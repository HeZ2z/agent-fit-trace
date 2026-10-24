import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BIND_HOST } from "./config.ts";
import { startCoachingServer } from "../../../server/coaching/coachingServer.ts";
import type { CoachingServer } from "../../../server/coaching/coachingServer.ts";
import { createSupabaseVerifier } from "../../../server/auth/supabaseVerifier.ts";
import {
  createLocalDaemonVerifier,
  LOCAL_DAEMON_BEARER,
} from "../../../server/auth/localVerifier.ts";
import type { TokenVerifier } from "../../../server/auth/verifier.ts";
import { getPublicConfig } from "../../../server/publicConfig.ts";
import type { ServerPublicConfig } from "../../../server/publicConfig.ts";
import {
  createAuthenticatedHandler,
  MAX_REQUEST_BODY_BYTES,
} from "../../../server/authenticatedHandler.ts";
import type { AuthenticatedResponse } from "../../../server/authenticatedHandler.ts";
import { createSqlitePrincipalStores } from "../../../server/sqlitePrincipalStores.ts";
import { CoachedPiProcess } from "../../../server/coaching/piProcessAdapter.ts";
import type { RuntimeFactory } from "../../../server/coaching/coachingService.ts";
import { createCoachingRuntimeRegistry } from "../../../server/coaching/runtimeRegistry.ts";
import type { CoachingRuntimeRegistration } from "../../../server/coaching/runtimeRegistry.ts";
import {
  acquireCoachingJournalLock,
} from "../../../server/coaching/coachingJournal.ts";
import type { CoachingJournalLock } from "../../../server/coaching/coachingJournal.ts";
import {
  GUEST_PRINCIPAL,
  identityFilePath,
  resolveDataDir,
  writeIdentity,
} from "@agent-fit-trace/store";
import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import { API_ENDPOINTS } from "@agent-fit-trace/api-contracts";

/**
 * Standalone local daemon server (`agent-fit-trace daemon`): ONE loopback
 * listener owned by the same reviewed coaching server the launcher uses,
 * with the launcher's upstream data proxy replaced by a LOCAL data plane.
 *
 * Differences from `launcherServer.ts` (which stays untouched — `start`
 * keeps its fixed-upstream meaning during the transition):
 * - `/api/v1/*` is served in-process by the shared authenticated handler
 *   over per-principal SQLite stores (`createSqlitePrincipalStores`);
 *   nothing is proxied to an upstream API.
 * - Auth is the composite daemon verifier: the fixed local daemon bearer
 *   resolves the stable guest principal; when a Supabase project is
 *   configured in the environment, any other bearer is verified against
 *   it (login flows scope the same contract to the Supabase principal);
 *   with no Supabase configured every other token rejects
 *   `UNAUTHENTICATED`.
 * - `GET /api/v1/public-config` is answered by this module with the
 *   additive daemon payload (`daemon: true`, `auth_configured`; the
 *   Supabase fields are only carried when a project is configured). The
 *   shared handler's own public-config response keeps its exact shape.
 * - The app shell is OPTIONAL: with a built `dist` the same static/SPA
 *   semantics as the launcher apply (index.html + runtime bootstrap, no
 *   fallback for `/api/*` and `/assets/*`); without one the shell routes
 *   404 and the headless data plane still works.
 * - Coaching runs derive their per-run JSON snapshot from the ACTIVE
 *   principal's SQLite store (`storeFactorySource` over the daemon
 *   stores) instead of the upstream API. The coached pi child env is
 *   unchanged: `PI_FIT_TRACE_STORE` still points at the per-run snapshot
 *   file, never at the principal database.
 *
 * Inherited boundaries (from the coaching server): loopback-only bind,
 * exact canonical Host/Origin gate, capability-bound `/coaching/*`, and
 * bounded bodies. Nothing credential-bearing is logged.
 */

const DEFAULT_DAEMON_PORT = 5199;
const PORT_SCAN_LIMIT = 20;
export const RUNTIME_SCRIPT_PATH = "/fit-trace-runtime.js";

export interface DaemonServerOptions {
  /** Preferred loopback port (default 5199, falls forward when busy). */
  port?: number;
  /** Data directory (default `resolveDataDir(env)`). */
  dataDir?: string;
  /**
   * App shell directory. `null` disables the shell; `undefined` tries
   * `<repo>/app/dist` and serves it only when an `index.html` exists
   * (a missing build is never an error — the data plane must work headless).
   */
  distDir?: string | null;
  host?: string;
  /** Environment for config resolution (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Injected verifier (tests). Undefined resolves the composite daemon verifier. */
  verifier?: TokenVerifier;
  /** Injected runtime factory (tests). Undefined uses CoachedPiProcess. */
  runtimeFactory?: RuntimeFactory;
  /** Pi CLI presence (default: coaching advertises available). */
  piAvailable?: boolean;
  /**
   * Durable coaching journal path (default `<dataDir>/coaching-journal.json`,
   * held under the same process lock as the launcher's). `null` keeps the
   * daemon in-process only (tests).
   */
  journalPath?: string | null;
}

export interface DaemonServer {
  url: string;
  port: number;
  dataDir: string;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function assertLoopbackHost(host: string): void {
  if (host !== BIND_HOST) {
    throw new Error(`daemon binds ${BIND_HOST} only; refusing host ${JSON.stringify(host)}`);
  }
}

function errorEnvelope(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

function sendJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(body);
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

function buildRuntimeScriptBody(options?: { piAvailable?: boolean }): string {
  const pi = options?.piAvailable === undefined
    ? ""
    : `, piAvailable: ${options.piAvailable ? "true" : "false"}`;
  return `window.__FIT_TRACE_RUNTIME = { mode: "http", coaching: "same-origin"${pi} };\n`;
}

function injectRuntimeScript(html: string): string {
  const tag = `<script src="${RUNTIME_SCRIPT_PATH}"></script>`;
  if (html.includes(RUNTIME_SCRIPT_PATH)) return html;
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  if (html.includes("</body>")) return html.replace("</body>", `${tag}</body>`);
  return `${tag}${html}`;
}

function safeStaticPath(distDir: string, pathname: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  if (relative === "" || relative.startsWith("..") || relative.includes(`..${sep}`)) return null;
  const absolute = resolve(join(distDir, relative));
  const root = resolve(distDir);
  if (absolute !== root && !absolute.startsWith(root + sep)) return null;
  return absolute;
}

/** True when `file` resolves inside `root` (symlink-escape check). */
function isInsideDist(root: string, file: string): boolean {
  if (file === root) return true;
  return file.startsWith(root + sep);
}

/** Resolve symlinks and require the real path to stay inside the
 * canonical dist root. Returns null on traversal/symlink escape or when
 * the entry cannot be confirmed as a file inside dist. */
async function resolveDistFile(distDir: string, pathname: string): Promise<string | null> {
  const candidate = safeStaticPath(distDir, pathname);
  if (candidate === null) return null;
  let rootReal: string;
  try {
    rootReal = await realpath(resolve(distDir));
  } catch {
    return null;
  }
  let fileReal: string;
  try {
    fileReal = await realpath(candidate);
  } catch {
    // Missing/broken entries fall through to the SPA 404 path — never
    // served, never leaked.
    return null;
  }
  if (!isInsideDist(rootReal, fileReal)) return null;
  let entry;
  try {
    entry = await stat(fileReal);
  } catch {
    return null;
  }
  if (!entry.isFile()) return null;
  return fileReal;
}

function defaultExtensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(resolve(here, "..", "..", ".."), ".pi", "extensions", "fit-trace", "index.ts");
}

function defaultDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(resolve(here, "..", "..", ".."), "app", "dist");
}

/**
 * Default runtime factory: the launch's own immutable snapshot file,
 * per-run snapshot dir, fixed per-session native dir, and resume handle
 * flow straight into the coached pi process — the factory invents no paths.
 * The child's `PI_FIT_TRACE_STORE` stays the per-run snapshot file (set by
 * the adapter), never the principal database.
 */
function defaultRuntimeFactory(extensionPath: string, cwd: string): RuntimeFactory {
  return (launch) =>
    new CoachedPiProcess({
      sessionId: launch.sessionId,
      runId: launch.runId,
      prompt: launch.prompt,
      snapshotFile: launch.snapshotFile,
      snapshotDir: launch.snapshotDir,
      sessionDir: launch.sessionDir,
      ...(launch.resumeSessionFile !== undefined ? { resumeSessionFile: launch.resumeSessionFile } : {}),
      extensionPath,
      cwd,
      onEvent: launch.onEvent,
      onDone: launch.onDone,
    });
}

/**
 * Fail-clear runtime factory used when the pi CLI is missing and no test
 * factory was injected: runs report a clear "pi unavailable" failure
 * instead of a generic spawn error.
 */
function unavailablePiRuntimeFactory(): RuntimeFactory {
  return (launch) => ({
    start(): void {
      setImmediate(() => {
        launch.onEvent({
          type: "run_error",
          code: "PI_UNAVAILABLE",
          message: "pi CLI is not available on PATH — workout tracking works; install pi to run coaching.",
        });
        launch.onDone("failed", "pi CLI is not available on PATH — install pi to run coaching.", {
          processExitConfirmed: true,
        });
      });
    },
    cancel(_reason?: string): void {
      void _reason;
    },
    async close(): Promise<void> {},
  });
}

/**
 * Composite daemon verifier: the fixed local daemon bearer always resolves
 * the stable guest principal; with a Supabase project configured in the
 * environment, any other bearer is verified against it; without one, every
 * other token rejects with the same `UNAUTHENTICATED` semantics as
 * `localVerifier.ts` (the shared handler maps the code to a 401).
 */
export function createDaemonVerifier(env: Record<string, string | undefined>): TokenVerifier {
  const local = createLocalDaemonVerifier();
  const supabaseConfig = getPublicConfig(env);
  const supabase = supabaseConfig === null
    ? null
    : createSupabaseVerifier({
      supabaseUrl: supabaseConfig.supabaseUrl,
      publishableKey: supabaseConfig.supabasePublishableKey,
    });
  return {
    verify(bearerToken: string): Promise<AuthPrincipal> {
      if (bearerToken === LOCAL_DAEMON_BEARER) return local.verify(bearerToken);
      if (supabase !== null) return supabase.verify(bearerToken);
      const error = new Error("Invalid bearer token.");
      (error as { code?: string }).code = "UNAUTHENTICATED";
      return Promise.reject(error);
    },
  };
}

export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
  const host = options.host ?? BIND_HOST;
  assertLoopbackHost(host);
  const env = options.env ?? process.env;
  const portRaw = options.port ?? DEFAULT_DAEMON_PORT;
  // Port 0 is a valid preference meaning "bind once on any free loopback
  // port" (same as the launcher's scan loop below and `startCoachingServer`).
  if (!Number.isSafeInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
    throw new Error(`invalid daemon port: ${String(portRaw)}`);
  }
  const dataDir = resolve(options.dataDir ?? resolveDataDir(env));
  const stores = createSqlitePrincipalStores(dataDir);

  // Guest identity is (re)written idempotently so #40 followers (MCP/pi)
  // resolve the same active principal this daemon serves.
  await writeIdentity(identityFilePath(dataDir), GUEST_PRINCIPAL);

  // The shell is strictly opt-in on presence: a missing build is not an
  // error — the headless data plane must always come up.
  const distDir =
    options.distDir === null ? null : resolve(options.distDir ?? defaultDistDir());
  let shell: { distDir: string; indexHtml: string } | null = null;
  if (distDir !== null) {
    try {
      const entry = await stat(join(distDir, "index.html"));
      if (entry.isFile()) {
        shell = { distDir, indexHtml: await readFile(join(distDir, "index.html"), "utf8") };
      }
    } catch {
      // No usable build: shell routes 404, data plane unaffected.
    }
  }
  const indexWithRuntime = shell === null ? "" : injectRuntimeScript(shell.indexHtml);
  // realpath so the raw-index comparison below matches the resolved file
  // even when the dist directory itself sits behind a symlink.
  const shellDir = shell === null ? null : shell.distDir;
  const shellIndexPath =
    shellDir === null
      ? null
      : normalize(await realpath(join(shellDir, "index.html")).catch(() => join(shellDir, "index.html")));

  // Supabase login is optional: configured env widens auth beyond the guest
  // bearer; unconfigured env keeps the pure local guest plane.
  const supabaseConfig = getPublicConfig(env);
  const verifier = options.verifier ?? createDaemonVerifier(env);
  // Additive daemon fields ride on the same config type; the shared
  // handler's own public-config response keeps its exact shape — the
  // extended payload is served by this module (see trustedHandler). A
  // full ServerPublicConfig only exists when Supabase is configured;
  // unconfigured, null keeps every consumer fail-closed.
  const daemonPublicConfig: ServerPublicConfig | null =
    supabaseConfig === null
      ? null
      : { ...supabaseConfig, daemon: true, auth_configured: true };
  const handler = createAuthenticatedHandler({
    verifier,
    stores,
    publicConfig: daemonPublicConfig,
  });

  const runtimeFactory =
    options.runtimeFactory ??
    (options.piAvailable === false
      ? unavailablePiRuntimeFactory()
      : defaultRuntimeFactory(defaultExtensionPath(), process.cwd()));
  const localPiAvailable = options.piAvailable !== false || options.runtimeFactory !== undefined;
  const registrations: CoachingRuntimeRegistration[] = [
    {
      backendId: "local-pi",
      runtimeId: "pi",
      executionLocation: "local",
      displayName: "pi CLI (local)",
      available: localPiAvailable,
      ...(localPiAvailable
        ? {}
        : {
            unavailableReason: {
              code: "cli-not-installed" as const,
              message: "pi CLI is not available on PATH.",
            },
          }),
      factory: runtimeFactory,
    },
  ];
  const runtimeRegistry = createCoachingRuntimeRegistry(registrations);
  const runtimeScript = buildRuntimeScriptBody(
    options.piAvailable === undefined ? undefined : { piAvailable: options.piAvailable },
  );

  async function servePublicConfig(response: ServerResponse): Promise<void> {
    // The standard Supabase fields are carried ONLY when a project is
    // configured; the daemon markers are always present.
    const config = supabaseConfig;
    sendJson(
      response,
      200,
      JSON.stringify({
        data: {
          ...(config === null
            ? {}
            : {
              supabaseUrl: config.supabaseUrl,
              supabasePublishableKey: config.supabasePublishableKey,
              guestSignInEnabled: config.guestSignInEnabled === true,
              guestUpgradeEnabled: config.guestUpgradeEnabled === true,
              guestSignInCaptchaRequired: config.guestSignInCaptchaRequired === true,
            }),
          daemon: true,
          auth_configured: config !== null,
        },
      }),
    );
  }

  async function handleApiV1(
    request: IncomingMessage,
    response: ServerResponse,
    route: { method: string; routeUrl: URL; pathname: string },
  ): Promise<void> {
    const { method, routeUrl, pathname } = route;
    const bare = pathname.replace(/^\/api\/v1(?=\/|$)/, "") || "/";

    // Extended daemon bootstrap payload (public, like the shared handler's
    // route; additive fields the handler itself does not serialize).
    if (bare === API_ENDPOINTS.publicConfig && method === "GET") {
      await servePublicConfig(response);
      return;
    }

    let body: string | undefined;
    try {
      body = await collectBody(request, MAX_REQUEST_BODY_BYTES);
    } catch {
      sendJson(
        response,
        400,
        errorEnvelope("VALIDATION_ERROR", `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`),
      );
      return;
    }
    // The shared handler routes on bare resource paths + query string.
    const result: AuthenticatedResponse = await handler(`${bare}${routeUrl.search}`, {
      method,
      ...(body !== undefined ? { body } : {}),
      authorization:
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
    });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  }

  async function handleShell(response: ServerResponse, method: string, pathname: string): Promise<void> {
    if (shell === null) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(method === "HEAD" ? undefined : indexWithRuntime);
      return;
    }
    const filePath = await resolveDistFile(shell.distDir, pathname);
    if (filePath !== null) {
      // Never serve the raw index.html without the runtime bootstrap.
      if (normalize(filePath) === shellIndexPath) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(method === "HEAD" ? undefined : indexWithRuntime);
        return;
      }
      response.writeHead(200, { "content-type": contentTypeFor(filePath) });
      if (method === "HEAD") {
        response.end();
        return;
      }
      response.end(await readFile(filePath));
      return;
    }
    // SPA fallback excludes API (handled above) and bundled assets: a
    // missing asset is a 404, never the app shell.
    if (pathname === "/assets" || pathname.startsWith("/assets/")) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(method === "HEAD" ? undefined : indexWithRuntime);
  }

  // Trusted same-origin handler: the coaching server invokes this ONLY after
  // its exact canonical Host/Origin gate, so no second Host/Origin check and
  // no CORS headers here. Returns true for every static/data route it owns.
  async function trustedHandler(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const method = (request.method ?? "GET").toUpperCase();
    const rawPath = request.url ?? "/";
    const routeUrl = new URL(rawPath, "http://127.0.0.1");
    const pathname = routeUrl.pathname;

    // Runtime mode bootstrap: public, same-origin, no credentials.
    if (pathname === RUNTIME_SCRIPT_PATH && (method === "GET" || method === "HEAD")) {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(method === "HEAD" ? undefined : runtimeScript);
      return true;
    }

    if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
      await handleApiV1(request, response, { method, routeUrl, pathname });
      return true;
    }
    // Only the versioned data plane exists; other /api paths never touch
    // the stores (mirrors the launcher's allowlist-only `/api` surface).
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      sendJson(response, 404, errorEnvelope("API_ERROR", `No route for ${method} ${pathname}.`));
      return true;
    }

    await handleShell(response, method, pathname);
    return true;
  }

  const preferred = portRaw;
  const attempts = preferred === 0 ? 1 : PORT_SCAN_LIMIT + 1;
  // Process ownership of the journal for the listener lifetime, like the
  // launcher: two writers over one journal would corrupt the generation
  // counters. Released on close or a failed startup.
  const journalPath =
    options.journalPath === undefined ? join(dataDir, "coaching-journal.json") : options.journalPath;
  const journalLock: CoachingJournalLock | null =
    journalPath === null ? null : acquireCoachingJournalLock(journalPath);
  let server: CoachingServer | null = null;
  let lastError: unknown = null;
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidate = preferred + attempt;
      if (candidate > 65535) break;
      try {
        server = await startCoachingServer({
          verifier,
          // Coaching snapshots derive from the ACTIVE PRINCIPAL's SQLite
          // store (storeFactorySource over the daemon stores) — no upstream.
          stores,
          runtimeFactory,
          runtimeRegistry,
          publicConfig: daemonPublicConfig,
          host,
          port: candidate,
          journalPath,
          trustedHandler,
        });
        lastError = null;
        break;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "";
        if (code !== "EADDRINUSE") throw error;
        lastError = error;
      }
    }
  } catch (error) {
    journalLock?.release();
    stores.closeAll();
    throw error;
  }
  const bound = server;
  if (bound === null) {
    journalLock?.release();
    stores.closeAll();
    throw lastError instanceof Error ? lastError : new Error("daemon could not bind an available port");
  }

  return {
    url: bound.url,
    port: bound.port,
    dataDir,
    close: async () => {
      try {
        await bound.close();
      } finally {
        journalLock?.release();
        stores.closeAll();
      }
    },
  };
}
