import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { createCloudFitTraceStore, loadTrainingCoachPrompt } from "@agent-fit-trace/mcp";
import { createSupabaseVerifier } from "./auth/supabaseVerifier.ts";
import { extractBearerToken } from "./auth/verifier.ts";
import {
  createAuthenticatedHandler,
  MAX_REQUEST_BODY_BYTES,
} from "./authenticatedHandler.ts";
import { readSupabaseServerEnv } from "./db/env.ts";
import { createSupabaseWorkoutStore } from "./db/supabaseWorkouts.ts";
import { getPublicConfig } from "./publicConfig.ts";
import { CLOUD_SAFE_DEFAULTS, readCloudRequestEnv } from "./cloud/config.ts";
import { createCloudCoachingHandler } from "./cloud/httpHandler.ts";
import { createSupabaseCoachingRequestRepository } from "./cloud/supabaseCoachingRepository.ts";
import { storeFactorySource } from "./coaching/coachingService.ts";
import { createMcpTokenVerifier } from "./mcp/auth.ts";
import { readMcpAuthConfig } from "./mcp/env.ts";
import { createMcpHttpHandler } from "./mcp/httpHandler.ts";
import {
  MCP_ENDPOINT_PATH,
  MCP_METADATA_QUERY_KEY,
  PROTECTED_RESOURCE_METADATA_PATH,
  isProtectedResourceMetadataPath,
} from "./mcp/resourceMetadata.ts";

/**
 * Shared Vercel Function adapter.
 *
 * Production fails closed: when `SUPABASE_URL` or the publishable key is
 * absent there is no verifier and no store — the shared handler answers 500
 * `API_ERROR` and never falls back to an in-memory store or anonymous
 * access. The test verifier is never constructed here.
 */

export interface VercelRequestLike extends IncomingMessage {
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string>,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

function byteSizeUtf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

async function readBody(
  request: VercelRequestLike,
  maxBytes: number,
): Promise<string | undefined> {
  // Vercel may pre-parse JSON bodies onto `request.body` (object) or leave a
  // raw string. `null` means "already parsed, no body" — treat as empty.
  if (typeof request.body === "string") {
    if (byteSizeUtf8(request.body) > maxBytes) {
      throw new Error("body-too-large");
    }
    return request.body === "" ? undefined : request.body;
  }
  if (request.body !== undefined && request.body !== null) {
    const serialized = JSON.stringify(request.body);
    if (byteSizeUtf8(serialized) > maxBytes) throw new Error("body-too-large");
    return serialized;
  }
  if (request.body === null) return undefined;
  // GET/HEAD never carry a workout body in this API: return immediately
  // instead of waiting on a stream Vercel may already have consumed (which
  // would hang when `end` never fires).
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  // A stream the platform already consumed has nothing left to read.
  const incoming = request as IncomingMessage & { readableEnded?: boolean };
  if (incoming.readableEnded === true) return undefined;
  return await new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const failTooLarge = (): void => {
      if (settled) return;
      settled = true;
      // Never destroy the socket: the caller still has to send the 400
      // error response over it. Pause the stream and reject instead.
      request.pause();
      reject(new Error("body-too-large"));
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        failTooLarge();
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
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * Query marker used by the `vercel.json` rewrites for cloud run subpaths.
 *
 * Vercel's filesystem routing matches only one segment for bracket route
 * segments, so `/coaching/cloud/runs/:id/events` and
 * `/coaching/cloud/runs/:id/cancel` are rewritten to the nearest single-segment
 * Function with this marker. `applyCloudSubpathRewrite` restores the logical
 * path before routing so the shared handler sees the documented URL.
 */
const CLOUD_SUBPATH_QUERY_KEY = "__fit_trace_cloud_op";
const CLOUD_SUBPATH_SEGMENTS = new Set(["events", "cancel"]);

/**
 * Fixed base for the `Request` handed to the MCP handler.
 *
 * The MCP layer derives everything that matters (the metadata URL, the
 * challenge) from configuration, never from the incoming URL, so a constant
 * base is both sufficient and safer than reading `Host`/`X-Forwarded-Host` —
 * a spoofed host header must not be able to redirect OAuth discovery.
 */
const MCP_REQUEST_BASE = "http://fit-trace.invalid";

/**
 * Headers that describe the platform's HTTP hop rather than the request, and
 * that a Web `Request` must not carry. The body is supplied explicitly and the
 * URL is fixed, so dropping them loses nothing and avoids runtime rejections.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "te",
  "expect",
  "host",
  "content-length",
]);

/** True for the MCP endpoint and its Protected Resource Metadata path. */
function isMcpRequest(url: URL): boolean {
  const pathname = url.pathname.replace(/\/+$/, "");
  return (
    pathname === MCP_ENDPOINT_PATH ||
    pathname.startsWith(`${MCP_ENDPOINT_PATH}/`) ||
    isProtectedResourceMetadataPath(url.pathname)
  );
}

/**
 * Training-coach skill body for the remote endpoint.
 *
 * Read once per warm instance and memoized: the file is immutable
 * configuration, unlike identity, transports, or stores. `FIT_TRACE_SKILL_PATH`
 * wins (the same override the stdio entrypoint documents), then the repo
 * layout is tried relative to this module. A miss returns `null` and the
 * handler fails closed with `503` rather than serving an empty coach contract.
 *
 * Deployment requirement: the skill file must be present in the Function
 * bundle (`vercel.json` includes `.pi/skills/**`) or `FIT_TRACE_SKILL_PATH`
 * must point at it; otherwise `/api/mcp` answers 503 until one of the two is
 * set. See `docs/deployment.md`.
 */
let mcpSkillText: Promise<string | null> | null = null;

async function loadMcpSkillText(): Promise<string | null> {
  const override = (process.env.FIT_TRACE_SKILL_PATH ?? "").trim();
  const candidates =
    override !== ""
      ? [override]
      : [
          resolvePath(process.cwd(), ".pi", "skills", "training-coach", "SKILL.md"),
          fileURLToPath(new URL("../../.pi/skills/training-coach/SKILL.md", import.meta.url)),
        ];
  for (const candidate of candidates) {
    try {
      return await loadTrainingCoachPrompt(candidate);
    } catch {
      // Try the next candidate; only a full miss fails closed.
    }
  }
  return null;
}

async function resolveMcpSkillText(): Promise<string | null> {
  // A miss is never cached: serving 503 is the honest answer for one failed
  // read, whereas caching it would make a transient error permanent for the
  // life of the warm instance.
  if (mcpSkillText === null) {
    const attempt = loadMcpSkillText()
      .catch(() => null)
      .then((text) => (text === null || text.trim() === "" ? null : text));
    mcpSkillText = attempt;
    const text = await attempt;
    if (text === null) mcpSkillText = null;
    return text;
  }
  return mcpSkillText;
}

/** Adapt the platform request into a Web `Request` the MCP handler can serve. */
function toWebRequest(request: VercelRequestLike, url: URL, body: string | undefined): Request {
  const method = (request.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;
  return new Request(url, init);
}

/** Write a Web `Response` back onto the platform response. */
async function sendWebResponse(
  response: ServerResponse,
  webResponse: Response,
  headOnly: boolean,
): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // HEAD must not carry a body, but must keep the headers of the GET response.
  const text = headOnly ? "" : await webResponse.text();
  if (!headOnly) headers["content-length"] = String(Buffer.byteLength(text, "utf8"));
  response.writeHead(webResponse.status, headers);
  response.end(text);
}

/**
 * Route one request for the remote MCP surface.
 *
 * The handler is constructed per request from freshly read configuration: the
 * endpoint is a resource server, so nothing about a caller — config included —
 * may be cached across requests. A request-local handler keeps the fail-closed
 * rules honest even if the environment changes between invocations.
 */
async function handleMcpRequest(
  request: VercelRequestLike,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const headOnly = method === "HEAD";

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await readBody(request, MAX_REQUEST_BODY_BYTES);
    } catch {
      send(
        response,
        400,
        JSON.stringify({
          error: {
            code: "MCP_INVALID_REQUEST",
            message: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
          },
        }),
        { "www-authenticate": "Bearer" },
      );
      return;
    }
  }

  const config = readMcpAuthConfig(process.env);
  const handler = createMcpHttpHandler({
    config,
    // A misconfigured deployment must refuse, not serve anonymously: a null
    // config also means there is no Supabase URL/key to verify against.
    verifier: config === null ? null : createMcpTokenVerifier(config),
    storeFor:
      config === null
        ? null
        : (principal) =>
            // One store per request, carrying only that caller's token, so
            // PostgREST RLS is the authority and no service-role key is ever
            // involved on this path.
            createCloudFitTraceStore(principal.principal, {
              supabaseUrl: config.supabaseUrl,
              publishableKey: config.publishableKey,
              accessToken: principal.accessToken,
            }),
    skillText: () => resolveMcpSkillText(),
  });

  try {
    const webResponse = await handler(toWebRequest(request, url, body));
    await sendWebResponse(response, webResponse, headOnly);
  } catch {
    // The handler answers its own failures; this is the last-resort guard so a
    // bug cannot surface as an unhandled rejection on the platform.
    send(response, 500, JSON.stringify({ error: { code: "MCP_INTERNAL_ERROR", message: "Internal error." } }), {
      "www-authenticate": "Bearer",
    });
  }
}


/**
 * Restore a rewritten cloud run subpath in place. Only the two documented
 * subpaths are accepted; every other value is ignored (and the marker removed)
 * so a caller cannot inject arbitrary path segments. Unrelated query
 * parameters such as `fromSeq` are preserved when the platform forwards them.
 *
 * Vercel selects the Function by the rewrite destination but can hand the
 * Function the original request path. The operation suffix may therefore
 * already be present; appending blindly would produce `.../events/events`.
 */
export function applyCloudSubpathRewrite(url: URL): boolean {
  const op = url.searchParams.get(CLOUD_SUBPATH_QUERY_KEY);
  if (op === null) return false;
  url.searchParams.delete(CLOUD_SUBPATH_QUERY_KEY);
  if (!CLOUD_SUBPATH_SEGMENTS.has(op)) return false;
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = base.endsWith(`/${op}`) ? base : `${base}/${op}`;
  return true;
}

/** Route one Vercel request through the shared authenticated handler. */
export async function handleVercelApi(
  request: VercelRequestLike,
  response: ServerResponse,
): Promise<void> {
  let rawUrl = request.url ?? "/";
  const query = request.query;
  if (query !== undefined && !rawUrl.includes("?")) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") params.set(key, value);
      else if (Array.isArray(value) && value[0] !== undefined) params.set(key, value[0]);
    }
    const serialized = params.toString();
    if (serialized !== "") rawUrl += `?${serialized}`;
  }

  // The remote MCP surface is routed FIRST and returns unconditionally.
  // `/api/mcp` and `/.well-known/oauth-protected-resource/api/mcp` are a
  // separate, Web-Standards handler (one stateless transport + server per
  // request); nothing below this block may see them. Routing before the
  // `/api/v1` env/verifier setup and before the body read keeps this request's
  // body stream untouched for the MCP handler, which reads it with the same
  // byte cap, and keeps MCP independent of `readSupabaseServerEnv`.
  //
  // The metadata path arrives here through the `vercel.json` rewrite that maps
  // it onto this Function with `MCP_METADATA_QUERY_KEY` (Vercel creates no
  // Function for a dot-directory, and the Hobby plan's 12-Function cap is
  // already reached). The original path is also accepted so a direct
  // preview/local invocation works unchanged.
  {
    const mcpUrl = new URL(rawUrl, MCP_REQUEST_BASE);
    if (isMcpRequest(mcpUrl) || mcpUrl.searchParams.has(MCP_METADATA_QUERY_KEY)) {
      await handleMcpRequest(request, response, mcpUrl);
      return;
    }
  }

  const env = readSupabaseServerEnv();
  const publicConfig = getPublicConfig();
  const verifier =
    env === null
      ? null
      : createSupabaseVerifier({ supabaseUrl: env.supabaseUrl, publishableKey: env.publishableKey });

  let body: string | undefined;
  try {
    body = await readBody(request, MAX_REQUEST_BODY_BYTES);
  } catch {
    send(
      response,
      400,
      JSON.stringify({
        error: {
          code: "VALIDATION_ERROR",
          message: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
        },
      }),
      {},
    );
    return;
  }

  const authorization =
    request.headers.authorization ??
    (Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : undefined);
  const accessToken = extractBearerToken(
    typeof authorization === "string" ? authorization : undefined,
  );

  // Strip the `/api/v1` mount prefix so the shared handlers see bare routes.
  const url = new URL(rawUrl, "http://fit-trace.invalid");
  // Vercel rewrites the two multi-segment cloud run subpaths to the nearest
  // single-segment Function; restore the documented path before routing.
  applyCloudSubpathRewrite(url);
  const route = `${url.pathname.replace(/^\/api\/v1(?=\/|$)/, "")}${url.search}`;

  // Durable cloud coaching has its own authenticated handler. It uses the
  // caller's own token for RPCs and never receives the service-role key.
  if (url.pathname.startsWith("/api/v1/coaching/cloud/")) {
    const cloudEnv = readCloudRequestEnv();
    const cloudHandler = createCloudCoachingHandler({
      verifier,
      repositoryFor:
        cloudEnv === null || accessToken === null || env === null
          ? null
          : (principal, token) =>
              createSupabaseCoachingRequestRepository({
                supabaseUrl: cloudEnv.supabase.supabaseUrl,
                publishableKey: cloudEnv.supabase.publishableKey,
                accessToken: token,
              }),
      source:
        cloudEnv === null || accessToken === null || env === null
          ? null
          : storeFactorySource({
              storeFor: (principal) =>
                createSupabaseWorkoutStore(principal, {
                  supabaseUrl: env.supabaseUrl,
                  publishableKey: env.publishableKey,
                  accessToken,
                }),
            }),
      providerConfigured: cloudEnv?.provider != null,
      providerLimits: {
        maxSteps: cloudEnv?.provider?.maxSteps ?? CLOUD_SAFE_DEFAULTS.maxSteps,
        maxTokens: cloudEnv?.provider?.maxTokens ?? CLOUD_SAFE_DEFAULTS.maxTokens,
        timeoutMs: cloudEnv?.provider?.timeoutMs ?? CLOUD_SAFE_DEFAULTS.timeoutMs,
      },
      sse: {
        pollMs: CLOUD_SAFE_DEFAULTS.ssePollMs,
        maxDurationMs: CLOUD_SAFE_DEFAULTS.sseMaxDurationMs,
        pageLimit: CLOUD_SAFE_DEFAULTS.ssePageLimit,
      },
    });
    const accept = request.headers.accept;
    const result = await cloudHandler({
      method: request.method ?? "GET",
      pathname: url.pathname.replace(/^\/api\/v1(?=\/|$)/, ""),
      searchParams: url.searchParams,
      body,
      authorization: typeof authorization === "string" ? authorization : undefined,
      accept: typeof accept === "string" ? accept : Array.isArray(accept) ? accept[0] : undefined,
    });
    send(response, result.status, result.body, result.headers);
    return;
  }

  const handler = createAuthenticatedHandler({
    verifier,
    // Per-request store bound to the caller's own token so PostgREST RLS
    // applies. When the token is missing the handler rejects before the
    // factory is used; when env is missing the factory cannot build a
    // store, so requests fail closed instead of reading memory.
    stores:
      env === null || accessToken === null
        ? null
        : {
            storeFor: (principal) =>
              createSupabaseWorkoutStore(principal, {
                supabaseUrl: env.supabaseUrl,
                publishableKey: env.publishableKey,
                accessToken,
              }),
          },
    publicConfig,
  });

  const result = await handler(route, {
    method: request.method ?? "GET",
    body,
    authorization: typeof authorization === "string" ? authorization : undefined,
  });
  send(response, result.status, result.body, result.headers);
}
