/**
 * Loopback cloud-coaching proxy.
 *
 * The desktop app's cloud client is intentionally same-origin: the hosted
 * service must not need CORS, and exactly one reviewed place may attach the
 * caller's bearer. This module forwards the public cloud route
 * (`/api/v1/coaching/cloud/*`) to the destination the daemon currently
 * approves for the verified principal, and streams the response back with
 * backpressure and disconnect cancellation.
 *
 * Boundaries that are enforced here, not in the renderer:
 * - the local daemon guest bearer is never forwarded, and only a verified
 *   formal account may use the route;
 * - the destination is resolved per request from the daemon's setting (an
 *   operator/build default or a user-entered destination with explicit
 *   consent); a renderer cannot smuggle an unapproved value into the proxy;
 * - redirects are refused, never followed with the bearer;
 * - hostname resolution is checked for loopback/private/link-local/metadata
 *   targets, and the checked address is the one connected to (DNS rebinding
 *   between the check and the request is not possible);
 * - request/response sizes and time are bounded.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { API_ERROR_CODES, ApiError } from "@agent-fit-trace/api-contracts";
import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import { extractBearerToken } from "../../../server/auth/verifier.ts";
import type { TokenVerifier } from "../../../server/auth/verifier.ts";
import { LOCAL_DAEMON_BEARER } from "../../../server/auth/localVerifier.ts";

const CLOUD_API_BASE_PATH = "/api/v1";
const CLOUD_ROUTE_PREFIX = "/coaching/cloud/";
/** Nothing else from the caller is forwarded; Host/Origin/Cookie never travel upstream. */
const REQUEST_HEADERS = ["authorization", "accept", "content-type"] as const;
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "retry-after"]);
const DEFAULT_BODY_BYTES = 1024 * 1024;
const DEFAULT_JSON_BYTES = 1024 * 1024;
const DEFAULT_SSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_BYTES = 64 * 1024;

export class CloudProxyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "CloudProxyError";
  }
}

/** Canonical destination from the operator/build configuration, or null. */
export function parseCloudApiBase(raw: string | undefined): URL | null {
  if (raw === undefined || raw === "") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.search !== "" || url.hash !== "") return null;
    if (url.pathname !== CLOUD_API_BASE_PATH) return null;
    if (url.hostname === "") return null;
    return url;
  } catch {
    return null;
  }
}

/** Paths the public cloud surface defines. Anything else never reaches upstream. */
export function isAllowedCloudPath(pathname: string): boolean {
  const id = "[A-Za-z0-9_-]{1,128}";
  return new RegExp(
    `^/api/v1${CLOUD_ROUTE_PREFIX}(?:capabilities|sessions(?:/${id})?|snapshots|runs(?:/${id}(?:/(?:events|cancel))?)?|conversations(?:/${id})?)$`,
  ).test(pathname);
}

function allowedMethods(method: string, pathname: string): boolean {
  if (method === "GET") return true;
  if (method === "POST") {
    return pathname === "/api/v1/coaching/cloud/sessions"
      || pathname === "/api/v1/coaching/cloud/snapshots"
      || pathname === "/api/v1/coaching/cloud/runs"
      || /\/runs\/[A-Za-z0-9_-]{1,128}\/cancel$/.test(pathname)
      || pathname === "/api/v1/coaching/cloud/conversations";
  }
  if (method === "DELETE") {
    return /^\/api\/v1\/coaching\/cloud\/conversations\/[A-Za-z0-9_-]{1,128}$/.test(pathname);
  }
  return false;
}

/**
 * Run-scoped cloud paths whose identifiers belong to one destination. `read
 * capabilities`, conversation history and destination configuration are not
 * run identity and stay usable after a destination change.
 */
export function isRunScopedCloudPath(pathname: string): boolean {
  return /^\/api\/v1\/coaching\/cloud\/(?:sessions|snapshots|runs)(?:\/|$)/.test(pathname);
}

function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith("127.");
  return address === "::1";
}

function isPublicIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function parseIPv6(address: string): number[] | null {
  const zone = address.indexOf("%");
  let value = zone < 0 ? address : address.slice(0, zone);
  if (value.includes(".")) {
    const colon = value.lastIndexOf(":");
    const v4 = value.slice(colon + 1).split(".").map((part) => Number(part));
    if (v4.length !== 4 || v4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, colon + 1)}${(((v4[0] as number) << 8) | (v4[1] as number)).toString(16)}:${(
      ((v4[2] as number) << 8) | (v4[3] as number)
    ).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const tail = halves.length === 1 || halves[1] === "" ? [] : (halves[1] as string).split(":");
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const parts = halves.length === 2
    ? [...head, ...Array<string>(missing).fill("0"), ...tail]
    : head;
  if (parts.length !== 8) return null;
  const parsed: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    parsed.push(Number.parseInt(part, 16));
  }
  return parsed;
}

function isPublicIPv6(address: string): boolean {
  const parts = parseIPv6(address);
  if (parts === null) return false;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = parts as [
    number, number, number, number, number, number, number, number,
  ];
  // IPv4-mapped: ::ffff:a.b.c.d
  if (first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0xffff) {
    return isPublicIPv4(`${seventh >> 8}.${seventh & 0xff}.${eighth >> 8}.${eighth & 0xff}`);
  }
  // Only global unicast (2000::/3) is routable; this also excludes NAT64,
  // 6to4, ULA, link-local, multicast, and the unspecified address.
  if (first < 0x2000 || first > 0x3fff) return false;
  // Documentation, benchmarking, ORCHID and Teredo ranges inside 2000::/3.
  if (first === 0x2001 && (second === 0x0db8 || second === 0 || second === 2 || second === 0x10 || second === 0x20)) {
    return false;
  }
  return true;
}

/** True only for addresses this proxy is willing to connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const defaultResolveHost: ResolveHost = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolve and authorise the destination, returning the address to pin for the
 * connection. Every answer must be public: a hostname that resolves to one
 * private address is refused even if another answer is public.
 */
export async function resolveApprovedAddress(
  destination: URL,
  resolveHost: ResolveHost = defaultResolveHost,
  allowInsecureLoopback = false,
): Promise<ResolvedAddress> {
  // Defence in depth: the static destination parser already requires HTTPS,
  // and the test seam must not turn into an accidental plaintext bearer path.
  const insecureHttp = destination.protocol === "http:";
  if (destination.protocol !== "https:" && !(allowInsecureLoopback && insecureHttp)) {
    throw new CloudProxyError(502, "The cloud destination must use HTTPS.");
  }
  const hostname = destination.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  const answers: readonly ResolvedAddress[] = literal === 4 || literal === 6
    ? [{ address: hostname, family: literal }]
    : await resolveHost(hostname).catch(() => {
        throw new CloudProxyError(502, "The cloud destination could not be resolved.");
      });
  if (answers.length === 0) throw new CloudProxyError(502, "The cloud destination did not resolve.");
  for (const answer of answers) {
    // The test-only plain-HTTP seam is strictly loopback: a plain-HTTP
    // destination that resolves to any public or private non-loopback address
    // must never receive the bearer.
    if (allowInsecureLoopback && insecureHttp) {
      if (!isLoopbackAddress(answer.address)) {
        throw new CloudProxyError(502, "The cloud destination resolves to a disallowed network address.");
      }
      continue;
    }
    if (!isPublicAddress(answer.address)) {
      throw new CloudProxyError(502, "The cloud destination resolves to a disallowed network address.");
    }
  }
  return answers[0] as ResolvedAddress;
}

export interface CloudDestinationProbeOptions {
  /** TEST-ONLY: allow a plain-HTTP loopback destination. */
  allowInsecureLoopback?: boolean;
  resolveHost?: ResolveHost;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Read a candidate destination's public bootstrap configuration and return its
 * account-service issuer (`supabaseUrl`), or null when it publishes none.
 *
 * This is the only request made before a user destination is saved. It sends
 * no bearer and no workout data, refuses redirects, and applies the same
 * address pinning/SSRF policy as the coaching proxy: the CI check for an
 * incompatible destination must not itself become an SSRF primitive.
 */
export async function probeCloudDestinationIssuer(
  destination: URL,
  options: CloudDestinationProbeOptions = {},
): Promise<string | null> {
  const allowInsecure = options.allowInsecureLoopback === true;
  const isHttps = destination.protocol === "https:";
  if (!isHttps && !(allowInsecure && destination.protocol === "http:")) {
    throw new CloudProxyError(502, "The cloud destination must use HTTPS.");
  }
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_PROBE_BYTES;
  const target = new URL(`${destination.origin}${destination.pathname}/public-config`);

  let pinned: ResolvedAddress;
  try {
    pinned = await resolveApprovedAddress(destination, resolveHost, allowInsecure);
  } catch (error) {
    throw error instanceof CloudProxyError
      ? error
      : new CloudProxyError(502, "The cloud destination could not be resolved.");
  }

  return await new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const settle = (error: Error | null, issuer: string | null = null): void => {
      if (settled) return;
      settled = true;
      if (error === null) resolve(issuer);
      else reject(error);
    };
    const requestModule = isHttps ? httpsRequest : httpRequest;
    const upstream = requestModule({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port === "" ? undefined : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { accept: "application/json", host: target.host },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all === true) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
      ...(isHttps ? { servername: target.hostname.replace(/^\[|\]$/g, "") } : {}),
      agent: false,
    });
    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy();
      settle(new CloudProxyError(504, "The cloud destination did not answer in time."));
    });
    upstream.on("error", () => {
      settle(new CloudProxyError(502, "The cloud destination is unavailable."));
    });
    upstream.on("response", (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        upstreamResponse.destroy();
        upstream.destroy();
        settle(new CloudProxyError(502, "The cloud destination redirected the request; refusing to follow it."));
        return;
      }
      if (status !== 200) {
        upstreamResponse.destroy();
        settle(new CloudProxyError(502, `The cloud destination answered ${status}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      upstreamResponse.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          upstreamResponse.destroy();
          upstream.destroy();
          settle(new CloudProxyError(502, "The cloud destination configuration is too large."));
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("end", () => {
        if (settled) return;
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const data =
            typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "data" in parsed
              ? (parsed as { data: unknown }).data
              : undefined;
          const issuer =
            typeof data === "object" && data !== null && !Array.isArray(data) && "supabaseUrl" in data
              ? (data as { supabaseUrl?: unknown }).supabaseUrl
              : undefined;
          settle(
            null,
            typeof issuer === "string" && issuer.trim() !== "" ? issuer.trim() : null,
          );
        } catch {
          settle(new CloudProxyError(502, "The cloud destination did not return valid JSON."));
        }
      });
      upstreamResponse.on("error", () => {
        settle(new CloudProxyError(502, "The cloud destination response failed."));
      });
    });
    upstream.end();
  });
}

function sendJson(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { code, message } }));
}

function forwardableRequestHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && value !== "") headers[name] = value;
  }
  return headers;
}

function forwardableResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || !RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(", ");
  }
  return result;
}

function collectBody(request: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        request.pause();
        reject(new CloudProxyError(413, "Cloud request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    request.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });
}

/** The slice of `IncomingMessage`/`ServerResponse` the body pump needs. */
export interface ProxyBodySource {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

export interface ProxyBodySink {
  write(chunk: Buffer): boolean;
  on(event: "drain", listener: () => void): unknown;
}

/**
 * Copy an upstream body into the caller's response with backpressure.
 *
 * `ServerResponse.write` returning false means the client is not keeping up;
 * the upstream is paused until the response drains. Without this the daemon
 * would buffer an arbitrarily large hostile body even though the response
 * socket has a bounded queue. The caller owns headers, status, end and error.
 */
export function pipeUpstreamBody(
  upstream: ProxyBodySource,
  response: ProxyBodySink,
  limit: number,
  onLimitExceeded: () => void,
): void {
  let bytes = 0;
  upstream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > limit) {
      onLimitExceeded();
      return;
    }
    if (!response.write(chunk)) upstream.pause();
  });
  response.on("drain", () => upstream.resume());
}

export interface CloudProxyOptions {
  /**
   * Static operator-approved HTTPS origin ending in `/api/v1`. Kept for
   * callers that have exactly one destination; `destinationFor` is the
   * per-principal dynamic form used by the daemon (#87).
   */
  apiBaseUrl?: URL;
  /**
   * Resolve the destination for a verified principal. A decision that is not
   * `ready` refuses the request before any body is read or bearer forwarded.
   */
  destinationFor?: (principal: AuthPrincipal) => CloudProxyDestinationDecision;
  verifier: TokenVerifier | null;
  /** Test seam: resolution without real DNS. */
  resolveHost?: ResolveHost;
  /**
   * Test-only: allow plain HTTP to loopback so the proxy itself can be tested
   * with a local upstream. Never set in production; `parseCloudApiBase` only
   * accepts HTTPS and this flag also requires a loopback destination.
   */
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxJsonBytes?: number;
  maxSseBytes?: number;
}

export interface CloudProxyRoute {
  method: string;
  pathname: string;
  search: string;
}

export interface CloudProxyDestinationDecision {
  status: "ready" | "unconfigured" | "unconfirmed" | "invalid";
  url?: URL;
  /** Stable id of the destination the request must be bound to, when ready. */
  binding?: string;
  code?: string;
  message?: string;
}

export type CloudProxyHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  route: CloudProxyRoute,
) => Promise<void>;

/**
 * Build the request handler. The daemon calls it only from its trusted
 * same-origin `/api/v1` surface, after the loopback Host/Origin gate.
 */
export function createCloudProxyHandler(options: CloudProxyOptions): CloudProxyHandler {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_BYTES;
  const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_JSON_BYTES;
  const maxSseBytes = options.maxSseBytes ?? DEFAULT_SSE_BYTES;

  return async function proxy(request, response, route): Promise<void> {
    const method = route.method.toUpperCase();
    if (!isAllowedCloudPath(route.pathname) || !allowedMethods(method, route.pathname)) {
      sendJson(response, 404, "NOT_FOUND", `No route for ${method} ${route.pathname}.`);
      return;
    }
    const token = extractBearerToken(
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
    );
    if (token === null) {
      sendJson(response, 401, "UNAUTHENTICATED", "Sign in to use cloud coaching.");
      return;
    }
    // The fixed local guest credential is not an account identity. Never let it
    // reach the hosted surface, even if the hosted service would reject it.
    if (token === LOCAL_DAEMON_BEARER) {
      sendJson(response, 403, "ACCOUNT_NOT_FORMAL", "Cloud coaching requires a signed-in account.");
      return;
    }
    if (options.verifier === null) {
      sendJson(response, 503, "CLOUD_DISABLED", "Cloud coaching is not configured on this daemon.");
      return;
    }
    let principal: AuthPrincipal;
    try {
      principal = await options.verifier.verify(token);
    } catch (error) {
      // A rejected credential is 401; an unreachable/overloaded Auth service
      // is 503. Flattening the latter into 401 would tell a valid user to sign
      // in again during a transient outage.
      const status = error instanceof ApiError ? error.status : undefined;
      if (status !== undefined && status >= 500) {
        sendJson(
          response,
          status,
          error instanceof ApiError ? error.code : API_ERROR_CODES.STORAGE_UNAVAILABLE,
          "Authentication service is unavailable.",
        );
      } else {
        sendJson(response, 401, API_ERROR_CODES.UNAUTHENTICATED, "Invalid or expired bearer token.");
      }
      return;
    }
    if (principal.isAnonymous !== false) {
      sendJson(response, 403, "ACCOUNT_NOT_FORMAL", "Cloud coaching requires a formal account.");
      return;
    }

    let body: string | undefined;
    try {
      body = await collectBody(request, maxBodyBytes);
    } catch (error) {
      const status = error instanceof CloudProxyError ? error.status : 400;
      sendJson(response, status, "VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid request body.");
      return;
    }
    const contentType = typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : "";
    if (body !== undefined && !/^application\/json\b/i.test(contentType)) {
      sendJson(response, 415, "VALIDATION_ERROR", "Cloud requests must be application/json.");
      return;
    }

    let destination: URL;
    if (options.destinationFor !== undefined) {
      const decision = options.destinationFor(principal);
      if (decision.status !== "ready" || decision.url === undefined) {
        const status = decision.status === "unconfirmed" ? 403 : 503;
        sendJson(
          response,
          status,
          decision.code ?? "CLOUD_DISABLED",
          decision.message ?? "Cloud coaching has no usable destination.",
        );
        return;
      }
      if (
        decision.binding !== undefined &&
        isRunScopedCloudPath(route.pathname) &&
        request.headers["x-fit-trace-cloud-destination"] !== decision.binding
      ) {
        sendJson(
          response,
          409,
          "CLOUD_DESTINATION_CHANGED",
          "The cloud server changed while this run was in progress. The operation was not sent to another server; restore the original server or start a new run.",
        );
        return;
      }
      destination = decision.url;
    } else if (options.apiBaseUrl !== undefined) {
      destination = options.apiBaseUrl;
    } else {
      sendJson(response, 503, "CLOUD_DISABLED", "Cloud coaching has no configured destination.");
      return;
    }

    let pinned: ResolvedAddress;
    try {
      pinned = await resolveApprovedAddress(destination, resolveHost, options.allowInsecureLoopback === true);
    } catch (error) {
      const status = error instanceof CloudProxyError ? error.status : 502;
      sendJson(response, status, "UPSTREAM_UNAVAILABLE", error instanceof Error ? error.message : "Cloud destination is unavailable.");
      return;
    }

    const target = new URL(`${destination.origin}${destination.pathname}${route.pathname.slice(CLOUD_API_BASE_PATH.length)}${route.search}`);
    const requestHeaders = forwardableRequestHeaders(request);
    requestHeaders.host = target.host;
    if (body !== undefined) {
      requestHeaders["content-type"] = "application/json";
      requestHeaders["content-length"] = String(Buffer.byteLength(body, "utf8"));
    }

    const isHttps = target.protocol === "https:";
    const requestModule = isHttps ? httpsRequest : httpRequest;
    const upstream = requestModule({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port === "" ? undefined : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method,
      headers: requestHeaders,
      // Connect only to the address we checked. For TLS, SNI/Host remain the
      // DNS name, so certificate verification still binds the name.
      // Node 24's family autoselection calls this with `all: true` and expects
      // an ARRAY of resolved addresses. Returning only the scalar triple makes
      // the connect fail with ERR_INVALID_IP_ADDRESS before a hostname-based
      // destination is reached (IP-literal tests would not see it).
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all === true) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
      ...(isHttps ? { servername: target.hostname.replace(/^\[|\]$/g, "") } : {}),
      // No redirect following: a 3xx is rejected below.
      agent: false,
    });

    let settled = false;
    let responseLimit = maxJsonBytes;
    const fail = (status: number, code: string, message: string): void => {
      if (settled) return;
      settled = true;
      upstream.destroy();
      sendJson(response, status, code, message);
    };

    upstream.setTimeout(timeoutMs, () => fail(504, "UPSTREAM_TIMEOUT", "The cloud service did not answer in time."));
    upstream.on("error", () => fail(502, "UPSTREAM_UNAVAILABLE", "The cloud service is unavailable."));
    response.on("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    upstream.on("response", (upstreamResponse) => {
      if (settled) {
        upstreamResponse.resume();
        return;
      }
      const status = upstreamResponse.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        settled = true;
        // Do not drain an unbounded redirect body: a destination that sends
        // headers and never finishes would keep this socket open forever.
        upstreamResponse.destroy();
        upstream.destroy();
        sendJson(response, 502, "UPSTREAM_UNAVAILABLE", "The cloud service redirected the request; refusing to follow it.");
        return;
      }
      const contentTypeUpstream = String(upstreamResponse.headers["content-type"] ?? "");
      responseLimit = contentTypeUpstream.startsWith("text/event-stream") ? maxSseBytes : maxJsonBytes;
      response.writeHead(status, forwardableResponseHeaders(upstreamResponse.headers));
      pipeUpstreamBody(upstreamResponse, response, responseLimit, () => {
        if (settled) return;
        settled = true;
        upstreamResponse.destroy();
        response.destroy();
      });
      upstreamResponse.on("end", () => {
        if (settled) return;
        settled = true;
        response.end();
      });
      upstreamResponse.on("error", () => {
        if (settled) return;
        settled = true;
        response.destroy();
      });
    });
    upstream.end(body);
  };
}
