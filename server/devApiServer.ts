import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { createMemoryHandler } from "@pi-fit-trace/api-contracts/testing";
import {
  createAuthenticatedHandler,
  MAX_REQUEST_BODY_BYTES,
} from "./authenticatedHandler.ts";
import { createTestVerifier } from "./auth/testVerifier.ts";
import { createSupabaseVerifier } from "./auth/supabaseVerifier.ts";
import { createPrincipalMemoryStores } from "./principalMemoryStore.ts";
import { readSupabaseServerEnv } from "./db/env.ts";
import { createSupabaseWorkoutStore } from "./db/supabaseWorkouts.ts";
import { getPublicConfig } from "./publicConfig.ts";
import { extractBearerToken } from "./auth/verifier.ts";
import { createInMemoryWorkoutStore } from "./inMemoryWorkoutStore.ts";

export interface DevApiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export type DevApiMode = "memory" | "authenticated" | "supabase";

export interface DevApiServerOptions {
  port?: number;
  host?: string;
  /**
   * - `memory` (default): unauthenticated loopback over one in-memory store.
   *   Existing tests rely on this; it never verifies tokens.
   * - `authenticated`: local authenticated loopback (test verifier +
   *   per-principal memory stores) for exercising the real auth boundary
   *   without Supabase.
   * - `supabase`: local authenticated loopback backed by the real local
   *   Supabase stack (requires SUPABASE_URL + publishable key + stack up).
   */
  mode?: DevApiMode;
}

function collectBody(request: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  // GET/HEAD have no body in this API; resolve immediately.
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
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function resolveMode(explicit?: DevApiMode): DevApiMode {
  if (explicit !== undefined) return explicit;
  const env = (process.env.FIT_TRACE_DEV_API_MODE ?? "").toLowerCase();
  if (env === "supabase" || env === "authenticated" || env === "memory") return env;
  return "memory";
}

/**
 * Start a loopback-only development API.
 *
 * Default `memory` mode runs the deterministic core directly with one
 * in-memory append-only store per server process; restarting the process
 * clears all records (non-durable by design). `authenticated` and `supabase`
 * modes run the real authenticated handler instead (see `DevApiMode`).
 */
export async function startDevApiServer(
  options: DevApiServerOptions = {},
): Promise<DevApiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.FIT_TRACE_DEV_API_PORT ?? 5199);
  const mode = resolveMode(options.mode);

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const rawPath = request.url ?? "/";
      // The public base is `/api/v1`, but the shared handler routes on bare
      // resource paths — strip the prefix so both speak the same routes.
      const rawUrl = new URL(rawPath, "http://127.0.0.1");
      const route = `${rawUrl.pathname.replace(/^\/api\/v1(?=\/|$)/, "")}${rawUrl.search}`;
      let body: string | undefined;
      try {
        body = await collectBody(request, MAX_REQUEST_BODY_BYTES);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "VALIDATION_ERROR",
              message: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
            },
          }),
        );
        return;
      }

      if (mode === "memory") {
        // Lazily created per process so concurrent test servers stay isolated.
        const store = (server as unknown as { __store?: ReturnType<typeof createInMemoryWorkoutStore> })
          .__store ?? createInMemoryWorkoutStore();
        (server as unknown as { __store?: unknown }).__store = store;
        const handler = createMemoryHandler(store);
        const result = await handler(route, { method, body });
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(result.body);
        return;
      }

      const storesBox = server as unknown as { __authStores?: ReturnType<typeof createPrincipalMemoryStores> };
      const authStores = storesBox.__authStores ?? createPrincipalMemoryStores();
      storesBox.__authStores = authStores;
      const publicConfig = getPublicConfig();
      const authorization = request.headers.authorization;
      const accessToken = extractBearerToken(
        typeof authorization === "string" ? authorization : undefined,
      );
      const handler = createAuthenticatedHandler({
        verifier:
          mode === "supabase"
            ? (() => {
                const env = readSupabaseServerEnv();
                return env === null
                  ? null
                  : createSupabaseVerifier({
                      supabaseUrl: env.supabaseUrl,
                      publishableKey: env.publishableKey,
                    });
              })()
            : createTestVerifier({
                "dev-token": { id: "dev-user", email: "dev@example.com" },
              }),
        stores:
          mode === "supabase"
            ? (() => {
                const env = readSupabaseServerEnv();
                if (env === null || accessToken === null) return null;
                return {
                  storeFor: (principal) =>
                    createSupabaseWorkoutStore(principal, {
                      supabaseUrl: env.supabaseUrl,
                      publishableKey: env.publishableKey,
                      accessToken,
                    }),
                };
              })()
            : authStores,
        publicConfig,
      });
      const result = await handler(route, {
        method,
        body,
        authorization: typeof authorization === "string" ? authorization : undefined,
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      for (const [key, value] of Object.entries(result.headers)) headers[key] = value;
      response.writeHead(result.status, headers);
      response.end(result.body);
    } catch {
      // Never leak stack traces over the wire; the handler already maps
      // domain errors, so reaching here means something unexpected failed.
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "API_ERROR", message: "Internal error." } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

const invokedAsMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  const mode = resolveMode();
  const server = await startDevApiServer({ mode });
  console.log(`fit-trace dev API (${mode}) listening at ${server.url}/api/v1`);
}
