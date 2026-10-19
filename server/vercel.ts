import type { IncomingMessage, ServerResponse } from "node:http";
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
  const env = readSupabaseServerEnv();
  const publicConfig = getPublicConfig();
  const verifier =
    env === null
      ? null
      : createSupabaseVerifier({ supabaseUrl: env.supabaseUrl, publishableKey: env.publishableKey });

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
