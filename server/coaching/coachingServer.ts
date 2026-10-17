/**
 * Loopback-only coaching HTTP + fetch-SSE server wiring the run service.
 *
 * Authentication: EVERY `/coaching/*` route (including bootstrap-adjacent
 * reads, events, and cancel) requires BOTH a freshly verified bearer token
 * AND a short-TTL launcher capability bound to the same account + origin.
 * `POST /coaching/bootstrap` verifies the bearer, then issues the bounded
 * capability. An expired/invalid bearer rejects even with a valid cap; a
 * mismatched account rejects; `POST /coaching/logout` invalidates the
 * caller's own sessions/caps and cancels their active run. Capabilities
 * travel ONLY in the `x-fit-trace-capability` header — never the query
 * string (rejected), never logged.
 *
 * Host/Origin: exact match against the canonical server origin
 * (`http://<bindHost>:<actualPort>` from the real listen address, including
 * the actual listening port). Alias hosts (localhost vs 127.0.0.1 vs ::1),
 * other localhost ports, prefix domains (`localhost.evil.com`), and
 * comma-joined Host values all reject. The bind host is validated as
 * loopback before listen. Capabilities bind to the canonical origin — never
 * the raw request header. No broad echoed CORS: only the exact validated
 * canonical Origin is echoed, never `*`. Requests without an Origin still
 * require both credentials (same-connection only).
 *
 * Bodies capped at 64KB (aborted collections settle instead of hanging);
 * generic 500s without stacks; fail-closed 401s; unknown routes are 404.
 * Capabilities are bounded per account and total (expired sweep first; full
 * maps reject new bootstrap with 503 instead of evicting in-use caps).
 * Injected and env public configs are validated with the shared Supabase key
 * guard so service-role/secret keys are never served.
 * Fixed upstream reads stream with a 1MB byte cap (reader cancelled on
 * overflow; timeout holds through the body) and accept only `{ data: [...] }`.
 * SSE events are resumable by `fromSeq` with the contract cursor semantics
 * (`lastSeq` = last stored seq, `-1` when empty); expired cursors are
 * explicit 410s directing a refetch from `firstSeq`, never a silent skip.
 * Frames and whole-stream bodies use the SHARED budgets in
 * `@pi-fit-trace/api-contracts` (`encodeCoachingEventFrame`); the run service
 * sizes stored events with the same measure, so an accepted event is always
 * readable by the browser client. `close()` stops accepting immediately and
 * is bounded: open streams end, in-flight upstream reads are aborted, and any
 * remaining sockets are destroyed after `shutdownGraceMs` — awaited
 * CONCURRENTLY with the service's own bounded agent cleanup so the total is
 * `max(http grace, agent cleanup)`, not their sum.
 * Client abort of an SSE/HTTP stream never cancels the run.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { extractBearerToken } from "../auth/verifier.ts";
import type { TokenVerifier } from "../auth/verifier.ts";
import type { PrincipalStoreFactory } from "../auth/verifier.ts";
import type { AuthPrincipal } from "@pi-fit-trace/api-contracts";
import { ApiError, API_ERROR_CODES, HTTP_STATUS, parseWorkoutList } from "@pi-fit-trace/api-contracts";
import {
  MAX_COACHING_SSE_TOTAL_BYTES,
  encodeCoachingEventFrame,
  parseCancelCoachingRunInput,
  parseCreateCoachingSessionInput,
  parseSnapshotFilter,
  parseSubmitCoachingRunInput,
} from "@pi-fit-trace/api-contracts";
import type { CoachingEventEnvelope } from "@pi-fit-trace/api-contracts";
import { MalformedResponseError } from "@pi-fit-trace/api-contracts";
import { DEFAULT_MAX_BODY_BYTES } from "../authenticatedHandler.ts";
import { getPublicConfig } from "../publicConfig.ts";
import type { ServerPublicConfig } from "../publicConfig.ts";
import { isRejectedSupabaseKey, isSafeSupabaseUrl } from "../db/env.ts";
import {
  createCoachingService,
  storeFactorySource,
  CoachingServiceError,
  WorkoutSourceUnavailable,
} from "./coachingService.ts";
import type {
  CoachingService,
  CoachingServiceOptions,
  RuntimeFactory,
  WorkoutReadContext,
  WorkoutSource,
} from "./coachingService.ts";
import type {
  CoachingRuntimeRegistration,
  CoachingRuntimeRegistry,
} from "./runtimeRegistry.ts";
import type { WorkoutRecord } from "@pi-fit-trace/core";

export const CAPABILITY_HEADER = "x-fit-trace-capability";
const SSE_CONTENT_TYPE = "text/event-stream";
/** Short-TTL launcher capability lifetime (bounded; re-bootstrap after). */
export const DEFAULT_CAPABILITY_TTL_MS = 10 * 60 * 1000;
/** Max active launcher capabilities per account (expired entries sweep first;
 * valid in-use caps are never evicted — new bootstrap rejects when full). */
export const MAX_CAPABILITIES_PER_ACCOUNT = 5;
/** Max active launcher capabilities total across accounts (same fail-closed rule). */
export const MAX_CAPABILITIES_TOTAL = 100;
/** Explicit bound for teardown: after this grace, remaining sockets are
 * force-destroyed instead of awaiting them indefinitely. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 2000;

export interface CoachingServerOptions {
  verifier: TokenVerifier | null;
  stores?: PrincipalStoreFactory | null;
  source?: WorkoutSource | null;
  /** Fixed server-configured upstream for workout reads (production wiring).
   * Only the base URL is configured; the request's own current user bearer
   * token is used ephemerally per read. There is deliberately no static
   * headers / service-role option: the product always acts as the user. */
  upstream?: { baseUrl: string } | null;
  runtimeFactory: RuntimeFactory;
  /** Optional backend registry; `runtimeFactory` remains the legacy local-pi path. */
  runtimeRegistry?: CoachingRuntimeRegistry | readonly CoachingRuntimeRegistration[];
  serviceOptions?: Omit<CoachingServiceOptions, "source" | "runtimeFactory" | "runtimeRegistry">;
  /** App-owned durable local journal path; launcher defaults it. Null disables. */
  journalPath?: string | null;
  publicConfig?: ServerPublicConfig | null;
  host?: string;
  port?: number;
  capabilityTtlMs?: number;
  /**
   * Bounded teardown grace: `close()` stops accepting immediately, then waits
   * at most this long for existing sockets to end before destroying them.
   */
  shutdownGraceMs?: number;
  /**
   * Optional trusted handler for non-coaching routes on the SAME HTTP
   * listener. Invoked ONLY after exact canonical Host/Origin validation;
   * receives the raw request/response and returns (or resolves) `true` when
   * handled. Return `false` to fall through to the default 404. No
   * route-specific CORS bypass: the handler owns its response headers.
   */
  trustedHandler?: (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;
}

export interface CoachingServer {
  url: string;
  port: number;
  service: CoachingService;
  close(): Promise<void>;
}

interface Capability {
  accountId: string;
  /** Canonical server origin bound at bootstrap — always the canonical
   * origin, never the raw request header. Requests without an Origin are
   * still allowed (same-connection only): both credentials are always
   * verified, so a missing Origin never widens access. */
  origin: string;
  expiresAt: number;
}

function normalizeBindHost(host: string): string {
  return host.trim().toLowerCase();
}

/** Bracket bare IPv6 hosts for URL/hostport formatting. */
function formatBindHost(host: string): string {
  const bare = normalizeBindHost(host).replace(/^\[(.*)\]$/, "$1");
  if (bare.includes(":") && !bare.startsWith("[")) return `[${bare}]`;
  if (host.trim().startsWith("[") && host.trim().toLowerCase().endsWith("]")) {
    return host.trim().toLowerCase();
  }
  return bare;
}

/** The bind host must be loopback — validated BEFORE listen. */
function assertLoopbackBindHost(host: string): void {
  const bare = normalizeBindHost(host).replace(/^\[(.*)\]$/, "$1");
  if (bare !== "127.0.0.1" && bare !== "localhost" && bare !== "::1" && bare !== "::ffff:127.0.0.1") {
    throw new Error(`coaching server binds loopback only; refusing host ${JSON.stringify(host)}`);
  }
}

function hostVariants(_port: number): string[] {
  // Retained for reference only: acceptance is ALWAYS the single canonical
  // host:port (see canonicalHostPort), never the alias set. Protocol-alias
  // hosts (localhost vs 127.0.0.1 vs ::1) must not widen the accepted origin.
  void _port;
  return [];
}

/** Exact canonical `host:port` for the bound loopback address (no aliases). */
function canonicalHostPort(bindHost: string, port: number): string {
  return `${formatBindHost(bindHost)}:${port}`;
}

/** Exact canonical origin `http://<bindHost>:<port>` (no aliases). */
function canonicalOriginFor(bindHost: string, port: number): string {
  return `http://${canonicalHostPort(bindHost, port)}`;
}

/** Exact Host match against the canonical bind address only. Rejects
 * comma-joined values, prefix domains, alias hosts, and every other port. */
function isTrustedHost(raw: string | string[] | undefined, canonical: string): boolean {
  if (Array.isArray(raw)) return false;
  if (raw === undefined) return false;
  if (raw.includes(",")) return false;
  return raw.trim().toLowerCase() === canonical.toLowerCase();
}

/** Exact same-origin match against the canonical server origin only. Absent
 * Origin is allowed through this gate (both credentials are still required);
 * anything else — including alias hosts, wrong ports, and prefix domains —
 * rejects. */
function isTrustedOrigin(raw: string | string[] | undefined, canonicalOrigin: string): boolean {
  if (raw === undefined) return true;
  if (Array.isArray(raw)) return false;
  return raw.trim() === canonicalOrigin;
}

/** Max bytes read from the fixed upstream workout payload (bounded, bytes not chars). */
export const MAX_UPSTREAM_BODY_BYTES = 1 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 15000;

/** Validate the configured upstream base URL: absolute http(s), no query/credentials. */
function normalizeUpstreamBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") throw new Error("fixed upstream base URL is required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("fixed upstream base URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("fixed upstream base URL must be http(s)");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("fixed upstream base URL must not embed credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("fixed upstream base URL must not include a query or fragment");
  }
  return trimmed;
}

/**
 * Bounded upstream body read: counts BYTES (not characters) while streaming
 * and cancels the reader on overflow, so a multi-byte payload cannot force
 * full allocation. The fetch `AbortSignal.timeout` stays attached through the
 * body read: an abort during streaming surfaces as an outage (503), never a
 * truncated parse.
 */
async function readBoundedUpstreamText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    throw new WorkoutSourceUnavailable("Upstream returned an unreadable workout payload.");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort: the cap is already tripped.
        }
        // STORAGE_UNAVAILABLE (not generic WorkoutSourceUnavailable) so the
        // service preserves the size-limit message instead of genericizing it.
        throw new CoachingServiceError("STORAGE_UNAVAILABLE", "Upstream workout payload exceeds the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WorkoutSourceUnavailable) throw error;
    if (error instanceof CoachingServiceError) throw error;
    throw new WorkoutSourceUnavailable("Upstream returned an unreadable workout payload.");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best-effort.
    }
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(combined);
  } catch {
    throw new WorkoutSourceUnavailable("Upstream returned an unreadable workout payload.");
  }
}

/**
 * Production workout source: `GET <baseUrl>/workouts` with the request's own
 * current user bearer token only (ephemeral; never stored). Accepts ONLY the
 * fixed authenticated API envelope `{ data: [...] }` with a bounded body
 * read. Upstream 401/403 surfaces as FORBIDDEN (auth failure); every other
 * outage is WorkoutSourceUnavailable (→ 503). No raw-array/envelope fallback.
 */
function createAuthenticatedUpstreamSource(baseUrl: string, shutdownSignal?: AbortSignal): WorkoutSource {
  const base = normalizeUpstreamBaseUrl(baseUrl);
  return {
    async listWorkouts(principal: AuthPrincipal, ctx?: WorkoutReadContext): Promise<WorkoutRecord[]> {
      void principal;
      const bearer = ctx?.bearerToken;
      if (bearer === undefined || bearer === "") {
        // Fail closed: production reads always require the current bearer.
        throw new WorkoutSourceUnavailable("Upstream workout read requires the current user bearer token.");
      }
      // A per-request timeout holds through the body; the optional server
      // shutdown signal cancels an in-flight read so teardown never awaits a
      // stalled upstream.
      const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
      const signal = shutdownSignal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, shutdownSignal]);
      let response: Response;
      try {
        response = await fetch(`${base}/workouts`, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
          redirect: "manual",
          signal,
        });
      } catch {
        throw new WorkoutSourceUnavailable();
      }
      if (response.status === 401 || response.status === 403) {
        throw new CoachingServiceError("FORBIDDEN", `Upstream workout read rejected with status ${response.status}.`);
      }
      if (response.status >= 300 && response.status < 400) {
        throw new WorkoutSourceUnavailable("Upstream redirected the workout read; refusing to follow.");
      }
      if (!response.ok) {
        throw new WorkoutSourceUnavailable(`Upstream workout read failed with status ${response.status}.`);
      }
      const text = await readBoundedUpstreamText(response);
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new WorkoutSourceUnavailable("Upstream returned an unreadable workout payload.");
      }
      // Fixed envelope only: `{ data: [...] }`. A bare array or any other
      // shape is malformed — never silently accepted.
      const data = (payload as { data?: unknown } | null)?.data;
      if (data === undefined) {
        throw new WorkoutSourceUnavailable("Upstream returned a malformed workout payload.");
      }
      try {
        return parseWorkoutList(data);
      } catch (error) {
        if (error instanceof MalformedResponseError) {
          throw new WorkoutSourceUnavailable("Upstream returned a malformed workout payload.");
        }
        throw error;
      }
    },
  };
}
function singleHeader(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function json(response: ServerResponse, status: number, payload: unknown, extra?: Record<string, string>): void {
  response.writeHead(status, { "content-type": "application/json", ...(extra ?? {}) });
  response.end(JSON.stringify(payload));
}

function errorBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

/** Collect a capped body; an aborted socket settles (resolves) instead of hanging. */
function collectBody(request: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        try {
          request.pause();
        } catch {
          // Best-effort.
        }
        reject(new Error("body-too-large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) resolve(undefined);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error: unknown) => {
      settleReject(error);
    });
    // Aborted mid-body: settle so the handler fails closed instead of hanging.
    request.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });
}

export async function startCoachingServer(options: CoachingServerOptions): Promise<CoachingServer> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackBindHost(host);
  const port = options.port ?? 0;
  const capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  // Aborted on close so any in-flight configured-upstream read settles instead
  // of holding teardown open until the upstream timeout.
  const shutdownController = new AbortController();

  const fixedUpstream = options.upstream !== undefined && options.upstream !== null
    ? createAuthenticatedUpstreamSource(options.upstream.baseUrl, shutdownController.signal)
    : null;
  const staticSource: WorkoutSource | null =
    options.source !== undefined
      ? options.source
      : options.stores !== undefined && options.stores !== null
        ? storeFactorySource(options.stores)
        : null;
  if (fixedUpstream === null && staticSource === null) {
    throw new Error("coaching server requires a workout source, stores, or upstream");
  }
  // Production reads flow through the fixed authenticated upstream with the
  // request's own current bearer token (ephemeral); the stores-backed source
  // is only the test seam. There is no per-request source override.
  const service = createCoachingService({
    ...(options.serviceOptions ?? {}),
    ...(options.journalPath === undefined ? {} : { journalPath: options.journalPath }),
    source: staticSource ?? fixedUpstream ?? (() => {
      throw new Error("coaching server has no workout source");
    })(),
    runtimeFactory: options.runtimeFactory,
    ...(options.runtimeRegistry === undefined ? {} : { runtimeRegistry: options.runtimeRegistry }),
  });
  const injectedPublicConfigOption = options.publicConfig;
  const capabilities = new Map<string, Capability>();
  /** Open SSE responses, tracked so shutdown closes them before server close. */
  const openStreams = new Set<ServerResponse>();
  /** Server-owned live-tail poll timers per open SSE stream (cleared on shutdown). */
  const openPolls = new Map<ServerResponse, ReturnType<typeof setInterval>>();
  const stopStreamPoll = (stream: ServerResponse): void => {
    const timer = openPolls.get(stream);
    if (timer !== undefined) {
      clearInterval(timer);
      openPolls.delete(stream);
    }
  };

  function sweepCapabilities(now: number): void {
    for (const [token, cap] of [...capabilities.entries()]) {
      if (cap.expiresAt <= now) capabilities.delete(token);
    }
  }

  /**
   * Injected configs are untrusted input: reject secret/service-role keys
   * with the shared server validator so an env mistake cannot leak them to
   * the browser. Returns null when unavailable or rejected (caller serves 500).
   */
  function resolvePublicConfig(): ServerPublicConfig | null {
    if (injectedPublicConfigOption !== undefined) {
      const injected = injectedPublicConfigOption;
      if (injected === null) return null;
      if (typeof injected.supabaseUrl !== "string" || typeof injected.supabasePublishableKey !== "string") {
        return null;
      }
      if (!isSafeSupabaseUrl(injected.supabaseUrl)) return null;
      if (isRejectedSupabaseKey(injected.supabasePublishableKey)) return null;
      return injected;
    }
    const fromEnv = getPublicConfig();
    if (fromEnv === null) return null;
    if (!isSafeSupabaseUrl(fromEnv.supabaseUrl)) return null;
    if (isRejectedSupabaseKey(fromEnv.supabasePublishableKey)) return null;
    return fromEnv;
  }
  // Server-owned capability sweep (unref'd; cleared on shutdown).
  const sweepTimer = setInterval(() => sweepCapabilities(Date.now()), 60_000);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  /** Canonical origin derived from the ACTUAL listen address (exact bind host + port). */
  function currentCanonical(): { hostPort: string; origin: string; port: number } {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : port;
    return {
      hostPort: canonicalHostPort(host, actualPort),
      origin: canonicalOriginFor(host, actualPort),
      port: actualPort,
    };
  }

  async function verifyBearer(request: IncomingMessage): Promise<{ principal: AuthPrincipal; token: string }> {
    if (options.verifier === null) {
      throw new ApiError({ code: API_ERROR_CODES.API_ERROR, message: "Authentication is not configured." });
    }
    const authorization = singleHeader(request.headers.authorization);
    const token = extractBearerToken(authorization);
    if (token === null) {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Missing bearer token.",
        status: HTTP_STATUS.unauthorized,
      });
    }
    try {
      const principal = await options.verifier.verify(token);
      return { principal, token };
    } catch (error) {
      if (error instanceof ApiError) {
        // Preserve availability failures (e.g. STORAGE_UNAVAILABLE → 503);
        // invalid credentials stay 401.
        if (error.code === API_ERROR_CODES.UNAUTHENTICATED) {
          throw new ApiError({
            code: API_ERROR_CODES.UNAUTHENTICATED,
            message: "Invalid or expired bearer token.",
            status: HTTP_STATUS.unauthorized,
          });
        }
        throw error;
      }
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      if (code === API_ERROR_CODES.UNAUTHENTICATED) {
        throw new ApiError({
          code: API_ERROR_CODES.UNAUTHENTICATED,
          message: "Invalid or expired bearer token.",
          status: HTTP_STATUS.unauthorized,
        });
      }
      // Auth outages are 503, never a forced logout.
      throw new ApiError({
        code: API_ERROR_CODES.STORAGE_UNAVAILABLE,
        message: "Authentication is temporarily unavailable.",
        status: HTTP_STATUS.serviceUnavailable,
      });
    }
  }

  /** Every coaching route requires BOTH a freshly verified bearer AND a
   * short-TTL capability bound to the same account + canonical origin. The
   * capability always binds the canonical origin; a request without an
   * Origin is allowed on the same connection (both credentials are still
   * verified), while a supplied Origin was already exact-matched at the
   * gate, so it maps to the canonical origin. A missing Origin never
   * widens access. */
  async function resolvePrincipal(
    request: IncomingMessage,
    opts?: { bootstrapOnly?: boolean },
  ): Promise<{ principal: AuthPrincipal; token: string }> {
    // Capabilities never travel in the query string.
    const rawUrl = request.url ?? "/";
    if (/[?&](capability|cap)=/i.test(rawUrl)) {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Capability must use the capability header, not the query string.",
        status: HTTP_STATUS.unauthorized,
      });
    }
    const { principal, token } = await verifyBearer(request);
    if (opts?.bootstrapOnly === true) return { principal, token };
    const capValue = singleHeader(request.headers[CAPABILITY_HEADER]);
    if (capValue === undefined || capValue === "") {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Missing capability credential.",
        status: HTTP_STATUS.unauthorized,
      });
    }
    sweepCapabilities(Date.now());
    const bound = capabilities.get(capValue);
    if (bound === undefined || bound.expiresAt <= Date.now()) {
      if (bound !== undefined) capabilities.delete(capValue);
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Invalid or expired capability credential.",
        status: HTTP_STATUS.unauthorized,
      });
    }
    if (bound.accountId !== principal.id) {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Capability is not bound to this account.",
        status: HTTP_STATUS.unauthorized,
      });
    }
    const origin = singleHeader(request.headers.origin) ?? null;
    // Compare against the CANONICAL origin, never the raw header value. A
    // supplied Origin was already exact-matched at the gate so it maps to
    // the canonical origin; an absent Origin is allowed (same-connection
    // only) since both credentials are still verified.
    const canonical = currentCanonical().origin;
    if (origin !== null && bound.origin !== canonical) {
      throw new ApiError({
        code: API_ERROR_CODES.UNAUTHENTICATED,
        message: "Capability is not bound to this origin.",
        status: HTTP_STATUS.unauthorized,
      });
    }
    return { principal, token };
  }

  function statusForServiceError(code: string): number {
    switch (code) {
      case "SESSION_NOT_FOUND":
      case "SNAPSHOT_NOT_FOUND":
      case "RUN_NOT_FOUND":
        return HTTP_STATUS.notFound;
      case "FORBIDDEN":
        return HTTP_STATUS.forbidden;
      case "VALIDATION_ERROR":
        return HTTP_STATUS.badRequest;
      case "IDEMPOTENCY_CONFLICT":
      case "RUN_BUSY":
        return HTTP_STATUS.conflict;
      case "EXPIRED_CURSOR":
        return HTTP_STATUS.gone;
      case "STORAGE_UNAVAILABLE":
        return HTTP_STATUS.serviceUnavailable;
      default:
        return HTTP_STATUS.serverError;
    }
  }

  const server: Server = createServer(async (request, response) => {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      const rawPath = request.url ?? "/";
      const routeUrl = new URL(rawPath, "http://127.0.0.1");
      const pathname = routeUrl.pathname;

      if (pathname === "/public-config" && method === "GET") {
        const config = resolvePublicConfig();
        if (config === null) {
          json(response, 500, { error: { code: "API_ERROR", message: "Public configuration is not available." } });
          return;
        }
        json(response, 200, { data: { supabaseUrl: config.supabaseUrl, supabasePublishableKey: config.supabasePublishableKey } });
        return;
      }

      // Host/Origin validation on every route except the public bootstrap
      // read above, against the CANONICAL server origin (exact bind host +
      // actual port; no alias widening).
      const canonical = currentCanonical();
      if (!isTrustedHost(request.headers.host, canonical.hostPort)) {
        json(response, 403, { error: { code: "FORBIDDEN", message: "Untrusted host." } });
        return;
      }
      const origin = singleHeader(request.headers.origin);
      if (!isTrustedOrigin(request.headers.origin, canonical.origin)) {
        json(response, 403, { error: { code: "FORBIDDEN", message: "Untrusted origin." } });
        return;
      }
      // No broad echoed CORS: only the exact validated canonical Origin is echoed.
      const corsHeaders: Record<string, string> =
        origin !== undefined ? { "access-control-allow-origin": canonical.origin, vary: "Origin" } : {};

      if (!pathname.startsWith("/coaching/")) {
        const trusted = options.trustedHandler;
        if (trusted !== undefined) {
          let handled = false;
          try {
            handled = await trusted(request, response);
          } catch {
            try {
              response.writeHead(500, { "content-type": "application/json" });
              response.end(errorBody("API_ERROR", "Internal error."));
            } catch {
              // Socket already gone.
            }
            return;
          }
          if (handled) return;
        }
        json(response, 404, { error: { code: "NOT_FOUND", message: "Unknown route." } }, corsHeaders);
        return;
      }

      let body: string | undefined;
      try {
        body = await collectBody(request, DEFAULT_MAX_BODY_BYTES);
      } catch {
        json(response, 400, {
          error: { code: "VALIDATION_ERROR", message: `Request body exceeds the ${DEFAULT_MAX_BODY_BYTES} byte limit.` },
        }, corsHeaders);
        return;
      }
      const parseBody = (): unknown => {
        if (body === undefined || body === "") return undefined;
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw new ApiError({ code: API_ERROR_CODES.VALIDATION_ERROR, message: "`body` is not valid JSON." });
        }
      };

      const runEventsMatch = /^\/coaching\/runs\/([^/]+)\/events$/.exec(pathname);
      const runCancelMatch = /^\/coaching\/runs\/([^/]+)\/cancel$/.exec(pathname);
      const runReadMatch = /^\/coaching\/runs\/([^/]+)$/.exec(pathname);
      const sessionReadMatch = /^\/coaching\/sessions\/([^/]+)$/.exec(pathname);

      try {
        if (pathname === "/coaching/bootstrap" && method === "POST") {
          const { principal } = await resolvePrincipal(request, { bootstrapOnly: true });
          sweepCapabilities(Date.now());
          // Bound the active map: expired entries already swept. When per-account
          // or total capacity is full, reject the new issuance (503) instead of
          // silently evicting a valid in-use capability.
          let perAccount = 0;
          for (const cap of capabilities.values()) {
            if (cap.accountId === principal.id) perAccount += 1;
          }
          if (perAccount >= MAX_CAPABILITIES_PER_ACCOUNT || capabilities.size >= MAX_CAPABILITIES_TOTAL) {
            json(response, HTTP_STATUS.serviceUnavailable, {
              error: { code: "STORAGE_UNAVAILABLE", message: "Capability capacity reached; retry after expiry." },
            }, corsHeaders);
            return;
          }
          const capability = `coachcap_${randomBytes(24).toString("base64url")}`;
          capabilities.set(capability, {
            accountId: principal.id,
            // Always bind the CANONICAL server origin, never the raw header:
            // Host/supplied-Origin exactness is enforced at the gate, and a
            // missing Origin is allowed only with both credentials.
            origin: canonical.origin,
            expiresAt: Date.now() + capabilityTtlMs,
          });
          json(response, 200, { data: { capability, expiresInMs: capabilityTtlMs } }, corsHeaders);
          return;
        }

        const { principal, token } = await resolvePrincipal(request);
        const readCtx: WorkoutReadContext = { bearerToken: token };

        if (pathname === "/coaching/logout" && method === "POST") {
          // Invalidate the caller's own sessions/caps and cancel their
          // active run. Other accounts are untouched.
          await service.logoutAccount(principal);
          sweepCapabilities(Date.now());
          for (const [value, cap] of [...capabilities.entries()]) {
            if (cap.accountId === principal.id) capabilities.delete(value);
          }
          json(response, 200, { data: { loggedOut: true } }, corsHeaders);
          return;
        }

        if (pathname === "/coaching/capabilities" && method === "GET") {
          // Versioned, server-derived backend/capability discovery. The
          // browser cannot assert availability, entitlement, or guest state.
          json(response, 200, { data: service.discoverBackends(principal) }, corsHeaders);
          return;
        }

        if (pathname === "/coaching/sessions" && method === "POST") {
          const input = parseCreateCoachingSessionInput(parseBody());
          const session = service.createSession(principal, input.id);
          json(response, 201, { data: { id: session.id } }, corsHeaders);
          return;
        }

        if (sessionReadMatch !== null && method === "GET") {
          const session = service.readSession(principal, decodeURIComponent(sessionReadMatch[1] ?? ""));
          json(response, 200, { data: { id: session.id } }, corsHeaders);
          return;
        }

        if (pathname === "/coaching/snapshots" && method === "POST") {
          const filter = parseSnapshotFilter(parseBody() ?? {});
          if (fixedUpstream !== null && (readCtx.bearerToken === undefined || readCtx.bearerToken === "")) {
            json(response, 401, { error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } }, corsHeaders);
            return;
          }
          const snapshot = await service.createSnapshot(principal, filter, readCtx);
          json(response, 201, { data: snapshot }, corsHeaders);
          return;
        }

        if (pathname === "/coaching/runs" && method === "POST") {
          const parsed = parseBody();
          const input = parseSubmitCoachingRunInput(parsed);
          const result = await service.submitRun(principal, input);
          json(
            response,
            result.created ? 201 : 200,
            { data: { run: result.run, lastSeq: result.lastSeq, replayed: result.replayed } },
            corsHeaders,
          );
          return;
        }

        if (runReadMatch !== null && method === "GET") {
          const result = service.readRun(principal, decodeURIComponent(runReadMatch[1] ?? ""));
          // Coherent state + retention so clients resume from their last
          // consumed seq and recover gaps; never an instruction to skip.
          json(response, 200, {
            data: {
              run: result.run,
              lastSeq: result.lastSeq,
              firstSeq: result.firstSeq,
              expiresAt: result.expiresAt,
            },
          }, corsHeaders);
          return;
        }

        if (runCancelMatch !== null && method === "POST") {
          const input = parseCancelCoachingRunInput(parseBody() ?? {});
          const result = service.cancelRun(principal, decodeURIComponent(runCancelMatch[1] ?? ""), input.reason);
          json(response, 200, { data: { run: result.run, lastSeq: result.lastSeq } }, corsHeaders);
          return;
        }

        if (runEventsMatch !== null && method === "GET") {
          const runId = decodeURIComponent(runEventsMatch[1] ?? "");
          const fromRaw = routeUrl.searchParams.get("fromSeq");
          let fromSeq: number | undefined;
          if (fromRaw !== null) {
            fromSeq = Number(fromRaw);
            if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
              json(response, 400, { error: { code: "VALIDATION_ERROR", message: "`fromSeq` must be a safe non-negative integer." } }, corsHeaders);
              return;
            }
          }
          let page: ReturnType<CoachingService["readEvents"]>;
          try {
            page = service.readEvents(principal, runId, fromSeq);
          } catch (error) {
            if (error instanceof CoachingServiceError && error.code === "EXPIRED_CURSOR") {
              // Expired cursor is explicit: include current run state +
              // retention so the client refetches from firstSeq and re-folds.
              // It is never advice to silently skip missing events.
              try {
                const current = service.readRun(principal, runId);
                json(response, 410, {
                  error: { code: "EXPIRED_CURSOR", message: error.message },
                  data: { run: current.run, lastSeq: current.lastSeq, firstSeq: current.firstSeq, expiresAt: current.expiresAt },
                }, corsHeaders);
              } catch {
                json(response, 404, { error: { code: "RUN_NOT_FOUND", message: "Coaching run not found." } }, corsHeaders);
              }
              return;
            }
            throw error;
          }
          response.writeHead(200, {
            "content-type": SSE_CONTENT_TYPE,
            "cache-control": "no-cache",
            connection: "keep-alive",
            ...corsHeaders,
          });
          // Flush headers immediately: an active run with no events yet
          // must not leave the client hanging awaiting a response.
          // Heartbeat frames are unnecessary; the live tail below delivers.
          response.flushHeaders();
          // Track BEFORE replay so shutdown can close even a fresh stream.
          openStreams.add(response);
          const untrack = (): void => {
            openStreams.delete(response);
            stopStreamPoll(response);
            response.removeAllListeners("close");
          };
          // Replay stored events first (resumable from the client's last
          // consumed seq + 1), then keep the stream open for live events.
          // The replay and the live poll both read from `cursor`, so no
          // event appended between them is lost and none is duplicated.
          let cursor = fromSeq ?? 0;
          let closed = false;
          let poll: ReturnType<typeof setInterval> | null = null;
          const stopPoll = (): void => {
            if (poll !== null) clearInterval(poll);
            poll = null;
            stopStreamPoll(response);
          };
          const writeEnvelope = (envelope: CoachingEventEnvelope): boolean => {
            const ok = response.write(encodeCoachingEventFrame(envelope));
            cursor = envelope.seq + 1;
            const buffered = (response.writableLength ?? 0);
            // One run's whole stream is the buffer ceiling: anything larger is already invalid.
            if (buffered > MAX_COACHING_SSE_TOTAL_BYTES) {
              closed = true;
              stopPoll();
              untrack();
              try {
                response.end();
              } catch {
                // Client already gone.
              }
              return false;
            }
            void ok;
            return true;
          };
          for (const envelope of page.events) {
            if (!writeEnvelope(envelope)) return;
          }
          // Terminal already stored → close cleanly after replay.
          const isTerminal = page.run.status === "completed" || page.run.status === "failed" || page.run.status === "cancelled";
          if (isTerminal) {
            untrack();
            response.end();
            return;
          }
          // Live tail: poll the stored event log. Client abort only detaches
          // this subscriber — it never cancels the run.
          poll = setInterval(() => {
            if (closed) return;
            let live: ReturnType<CoachingService["readEvents"]> | null = null;
            try {
              live = service.readEvents(principal, runId, cursor);
            } catch {
              closed = true;
              stopPoll();
              untrack();
              try {
                response.end();
              } catch {
                // Client already gone.
              }
              return;
            }
            for (const envelope of live.events) {
              try {
                if (!writeEnvelope(envelope)) return;
              } catch {
                break;
              }
              if (closed) return;
            }
            const terminal = live.run.status === "completed" || live.run.status === "failed" || live.run.status === "cancelled";
            if (terminal) {
              closed = true;
              stopPoll();
              untrack();
              try {
                response.end();
              } catch {
                // Client already gone.
              }
            }
          }, 25);
          if (typeof poll.unref === "function") poll.unref();
          openPolls.set(response, poll);
          // Cleanup via the RESPONSE close/aborted signal — never request.close.
          response.on("close", () => {
            if (!closed) {
              closed = true;
            }
            stopPoll();
            openStreams.delete(response);
            response.removeAllListeners("close");
          });
          return;
        }

        json(response, 404, { error: { code: "NOT_FOUND", message: "Unknown route." } }, corsHeaders);
      } catch (error) {
        if (error instanceof CoachingServiceError) {
          json(response, statusForServiceError(error.code), { error: { code: error.code, message: error.message } }, corsHeaders);
          return;
        }
        if (error instanceof MalformedResponseError) {
          json(response, 400, { error: { code: "VALIDATION_ERROR", message: "Malformed request." } }, corsHeaders);
          return;
        }
        if (error instanceof ApiError) {
          const status = error.status ?? (error.code === API_ERROR_CODES.UNAUTHENTICATED ? 401 : 400);
          const headers: Record<string, string> = { ...corsHeaders };
          if (status === 401) headers["www-authenticate"] = "Bearer";
          json(response, status, { error: { code: error.code, message: error.message } }, headers);
          return;
        }
        json(response, 500, { error: { code: "API_ERROR", message: "Internal error." } }, corsHeaders);
      }
    } catch {
      // Never leak stacks over the wire.
      try {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(errorBody("API_ERROR", "Internal error."));
      } catch {
        // Socket already gone.
      }
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    // Bind failure (e.g. EADDRINUSE while the launcher scans ports) must
    // not leak the service sweep timer, the capability sweep timer, or a
    // live runtime: no resources are held while scanning.
    clearInterval(sweepTimer);
    try {
      await service.shutdown();
    } catch {
      // Shutdown of an idle pre-listen service is best-effort.
    }
    server.removeAllListeners();
    throw error;
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  let closing: Promise<void> | null = null;

  const performClose = async (): Promise<void> => {
    // 1. Stop accepting new connections IMMEDIATELY. The callback fires once
    // the listener is down and every socket has ended (or was destroyed below).
    let serverCloseError: unknown = null;
    const serverClosed = new Promise<void>((resolve) => {
      try {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            serverCloseError = error;
          }
          resolve();
        });
      } catch (error) {
        // Already closed / never listening: not a shutdown failure.
        if ((error as NodeJS.ErrnoException)?.code !== "ERR_SERVER_NOT_RUNNING") {
          serverCloseError = error;
        }
        resolve();
      }
    });
    // 2. Cancel in-flight configured-upstream reads so a stalled upstream does
    // not hold teardown open until its own timeout.
    shutdownController.abort();
    // 3. End tracked SSE responses + their poll timers before waiting.
    for (const stream of [...openStreams]) {
      stopStreamPoll(stream);
      try {
        stream.end();
      } catch {
        // Client already gone.
      }
      try {
        stream.removeAllListeners("close");
      } catch {
        // Best-effort.
      }
    }
    openStreams.clear();
    for (const timer of [...openPolls.values()]) clearInterval(timer);
    openPolls.clear();
    clearInterval(sweepTimer);
    // 4. Stop the run service CONCURRENTLY with the socket grace below: its own
    // bound is the per-run cancel grace, but it must not DELAY socket teardown,
    // so the two waits overlap (total ≈ max(bounded agent cleanup, http grace),
    // never their sum). An unconfirmed live child surfaces as a rejection and
    // is never silently released.
    let shutdownError: unknown = null;
    const serviceShutdown = service.shutdown().then(
      () => undefined,
      (error: unknown) => {
        // Propagate: an unconfirmed live child must report failure and the
        // workspace is preserved by the service — never claim success.
        shutdownError = error;
      },
    );
    // 5. Bounded wait for existing sockets (unfinished request bodies, idle
    // keep-alive, open streams), started as soon as close starts — not after
    // agent cleanup. Past the grace, force-destroy the rest so `close()` can
    // never await a socket forever.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      serverClosed.then(() => false),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(true), shutdownGraceMs);
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (timedOut) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await serverClosed;
    }
    // Bounded agent cleanup still completes (bounded by its own cancel grace);
    // an unconfirmed child is reported, never silently released.
    await serviceShutdown;
    server.removeAllListeners();
    if (shutdownError !== null) {
      throw shutdownError instanceof Error ? shutdownError : new Error(String(shutdownError));
    }
    if (serverCloseError !== null) {
      throw serverCloseError instanceof Error ? serverCloseError : new Error(String(serverCloseError));
    }
    if (service.activeRunCount() > 0) {
      throw new Error("coaching shutdown unconfirmed: a live child is retained with capacity held; workspace preserved");
    }
  };

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    service,
    // Idempotent: the first call performs teardown, later calls share the same
    // settled promise (a second teardown is never attempted).
    close: (): Promise<void> => {
      if (closing === null) closing = performClose();
      return closing;
    },
  };
}

export { getPublicConfig };
export type { ServerPublicConfig };
