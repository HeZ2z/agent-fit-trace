import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BIND_HOST, DEFAULT_PORT, normalizeUpstreamBaseUrl } from "./config.ts";
import { startCoachingServer } from "../../../server/coaching/coachingServer.ts";
import type { CoachingServer } from "../../../server/coaching/coachingServer.ts";
import { createSupabaseVerifier } from "../../../server/auth/supabaseVerifier.ts";
import type { TokenVerifier } from "../../../server/auth/verifier.ts";
import type { ServerPublicConfig } from "../../../server/publicConfig.ts";
import { isRejectedSupabaseKey, isSafeSupabaseUrl } from "../../../server/db/env.ts";
import type { CodexAppServerSupport } from "../../../server/coaching/codexAppServerCapability.ts";
import type { OpenCodeIsolationEvidence, OpenCodeRunSupport } from "../../../server/coaching/opencodeCapability.ts";
import type {
  CoachingService,
  RuntimeFactory,
} from "../../../server/coaching/coachingService.ts";
import { createCoachingRuntimeRegistry } from "../../../server/coaching/runtimeRegistry.ts";
import type { CoachingRuntimeRegistration } from "../../../server/coaching/runtimeRegistry.ts";
import {
  localPiRegistration,
  piRuntimeFactory,
  detectLocalCodex,
  detectLocalOpenCode,
  resolveLocalCodexRegistration,
  resolveLocalOpenCodeRegistration,
  unavailablePiRuntimeFactory,
} from "../../../server/coaching/localRuntimeRegistrations.ts";
import {
  acquireCoachingJournalLock,
} from "../../../server/coaching/coachingJournal.ts";
import type { CoachingJournalLock } from "../../../server/coaching/coachingJournal.ts";
import type { CoachingRuntimeId } from "@agent-fit-trace/api-contracts";
import { resolveCoachingBackendSelection } from "@agent-fit-trace/api-contracts";

/**
 * Same-origin launcher server: ONE loopback listener owned by the reviewed
 * coaching server. Static App serving, the runtime-mode bootstrap script,
 * and the allowlisted `/api/v1/*` data proxy run as the coaching server's
 * `trustedHandler` — invoked ONLY after its exact canonical Host/Origin
 * gate — while `/coaching/*` routes are served natively on the same
 * origin. There is no second listener, no proxied capability/Supabase
 * token to an untrusted process, and no route-specific CORS bypass: the
 * handler owns its (same-origin, no-ACA0) response headers.
 *
 * Boundaries (inherited from the coaching server + preserved here):
 * - Binds loopback only (`127.0.0.1`); any other host is refused before listen.
 * - The upstream base URL is fixed at startup (flag/env). The browser can
 *   never choose or override it — query strings carry no target.
 * - Only allowlisted data paths proxy; everything else under `/api/` is 404
 *   and never touches the upstream.
 * - Upstream redirects are refused, never followed. Bodies are bounded
 *   (64 KiB request, 1 MiB upstream response).
 * - The user's bearer token is forwarded ONLY to allowlisted workout /
 *   analysis / plan endpoints, and only as the `Authorization` header value.
 *   The public-config proxy drops credentials. Nothing credential-bearing
 *   is logged: this module logs nothing per request.
 * - SPA fallback serves `index.html` for app routes but NEVER for `/api/*`
 *   or `/assets/*` (matching `vercel.json` rewrites).
 * - Coaching reads flow through the fixed configured upstream with the
 *   request's own current bearer token (ephemeral); the default verifier is
 *   built from the verified upstream public Supabase config, and the
 *   default runtime factory spawns the coached pi process with the launch's
 *   own sessionDir/resume handle plus the explicit extension entrypoint.
 */

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_UPSTREAM_BODY_BYTES = 1 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 15000;
export const RUNTIME_SCRIPT_PATH = "/fit-trace-runtime.js";

/** Bound for the startup public-config fetch (never blocks boot long). */
const STARTUP_PUBLIC_CONFIG_TIMEOUT_MS = 5000;

export function buildRuntimeScriptBody(options?: { piAvailable?: boolean }): string {
  const pi = options?.piAvailable === undefined
    ? ""
    : `, piAvailable: ${options.piAvailable ? "true" : "false"}`;
  return `window.__FIT_TRACE_RUNTIME = { mode: "http", coaching: "same-origin"${pi} };\n`;
}

export const RUNTIME_SCRIPT_BODY = buildRuntimeScriptBody();

const PORT_SCAN_LIMIT = 20;

export interface LauncherServerOptions {
  distDir: string;
  upstreamBaseUrl: string;
  host?: string;
  port?: number;
  /** Injected verifier (tests). Undefined resolves the default verified
   * Supabase verifier; explicit null leaves coaching unauthenticated. */
  verifier?: TokenVerifier | null;
  /** Injected runtime factory (tests). Undefined uses CoachedPiProcess. */
  runtimeFactory?: RuntimeFactory;
  /** Injected public config (tests). Undefined resolves upstream-then-env. */
  publicConfig?: ServerPublicConfig | null;
  /** Explicit pi extension entrypoint (default: repo `.pi/.../index.ts`). */
  extensionPath?: string;
  /** Working directory for coached pi processes (default: process cwd). */
  piCwd?: string;
  /** Pi CLI presence for the runtime bootstrap (default: omitted). */
  piAvailable?: boolean;
  piExecutable?: string;
  piEnv?: NodeJS.ProcessEnv;
  piVersion?: string;
  validatePiExecutable?: () => boolean;
  /**
   * Installed Codex app-server capability (tests inject it). Undefined probes
   * the installed CLI only when `runtimeId` is `codex`.
   */
  codexSupport?: CodexAppServerSupport;
  /** Codex binary (default `codex`). */
  codexBinary?: string;
  /**
   * Installed OpenCode v2 capability evidence (tests inject it). The
   * production path probes the installed CLI; without positive isolation
   * evidence the backend stays unavailable with an explicit gap.
   */
  openCodeSupport?: OpenCodeRunSupport;
  openCodeBinary?: string;
  /** `provider/model` for generated OpenCode config (default env). */
  openCodeModel?: string;
  /** Test/operator seam for positive isolation evidence. */
  openCodeIsolationVerifier?: (context: {
    binary: string;
    version: string;
    model: string;
  }) => Promise<OpenCodeIsolationEvidence | null>;
  /**
   * Operator-configured coaching runtime (default `pi`). Only `pi` has an
   * enabled adapter. Codex is gated on a version-specific proof that its
   * entire built-in tool inventory is excluded; OpenCode has no adapter yet.
   * Discovery reports the concrete unavailable reason instead of advertising
   * either one.
   */
  runtimeId?: CoachingRuntimeId;
  /**
   * App-owned durable local journal path. Undefined uses
   * `.pi/fit-trace/coaching-journal.json` under the process cwd; null keeps
   * this launcher in-process only (tests).
   */
  journalPath?: string | null;
}

export interface LauncherServer {
  url: string;
  port: number;
  upstreamBaseUrl: string;
  service: CoachingService;
  close(): Promise<void>;
}

interface ProxyRoute {
  method: string;
  path: string;
  forwardAuth: boolean;
  forwardQuery: boolean;
  acceptsBody: boolean;
}

const PROXY_ROUTES: ProxyRoute[] = [
  { method: "GET", path: "/public-config", forwardAuth: false, forwardQuery: false, acceptsBody: false },
  { method: "GET", path: "/workouts", forwardAuth: true, forwardQuery: false, acceptsBody: false },
  { method: "POST", path: "/workouts", forwardAuth: true, forwardQuery: false, acceptsBody: true },
  { method: "GET", path: "/analysis", forwardAuth: true, forwardQuery: true, acceptsBody: false },
  { method: "POST", path: "/plans/drafts", forwardAuth: true, forwardQuery: false, acceptsBody: true },
];

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
    throw new Error(`launcher binds ${BIND_HOST} only; refusing host ${JSON.stringify(host)}`);
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

/**
 * Shared-guard validation for any public config (upstream bootstrap or
 * injected): secret/service-role keys and unsafe URLs are rejected so a
 * misconfigured key can never reach the browser or the verifier.
 * Returns null when unavailable or rejected.
 */
function validatePublicConfig(candidate: unknown): ServerPublicConfig | null {
  const data = candidate as {
    supabaseUrl?: unknown;
    supabasePublishableKey?: unknown;
    guestSignInEnabled?: unknown;
    guestUpgradeEnabled?: unknown;
    guestSignInCaptchaRequired?: unknown;
  } | null;
  if (typeof data?.supabaseUrl !== "string" || typeof data?.supabasePublishableKey !== "string") {
    return null;
  }
  if (!isSafeSupabaseUrl(data.supabaseUrl)) return null;
  if (isRejectedSupabaseKey(data.supabasePublishableKey)) return null;
  if (data.guestSignInEnabled !== undefined && typeof data.guestSignInEnabled !== "boolean") {
    return null;
  }
  if (data.guestUpgradeEnabled !== undefined && typeof data.guestUpgradeEnabled !== "boolean") {
    return null;
  }
  if (
    data.guestSignInCaptchaRequired !== undefined &&
    typeof data.guestSignInCaptchaRequired !== "boolean"
  ) {
    return null;
  }
  return {
    supabaseUrl: data.supabaseUrl,
    supabasePublishableKey: data.supabasePublishableKey,
    ...(data.guestSignInEnabled === true ? { guestSignInEnabled: true } : {}),
    ...(data.guestUpgradeEnabled === true ? { guestUpgradeEnabled: true } : {}),
    ...(data.guestSignInCaptchaRequired === true ? { guestSignInCaptchaRequired: true } : {}),
  };
}

/**
 * Bounded upstream body read: counts BYTES while streaming and cancels the
 * reader on overflow, so a multi-byte payload cannot force full allocation.
 */
async function readBoundedBodyText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort: the cap is already tripped.
        }
        throw new Error("body-too-large");
      }
      chunks.push(value);
    }
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
  return Buffer.from(combined).toString("utf8");
}

/**
 * Default public config: the fixed upstream's own bootstrap response only,
 * read with a 1 MiB streamed byte cap and validated with the shared
 * Supabase guards (secret/service-role keys are never accepted). There is
 * deliberately no environment fallback: an unrelated env project must never
 * silently authenticate this launcher. Null when the upstream is
 * missing/unreachable/malformed — coaching then reports unavailability
 * instead of serving an unverified key.
 */
async function fetchUpstreamPublicConfig(upstreamBase: string): Promise<ServerPublicConfig | null> {
  let response: Response;
  try {
    response = await fetch(`${upstreamBase}/public-config`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(STARTUP_PUBLIC_CONFIG_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (response.status >= 300 && response.status < 400) return null;
  if (!response.ok) return null;
  if (response.body === null) return null;
  let text: string;
  try {
    text = await readBoundedBodyText(response.body, MAX_UPSTREAM_BODY_BYTES);
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return validatePublicConfig((payload as { data?: unknown } | null)?.data);
}

export async function startLauncherServer(options: LauncherServerOptions): Promise<LauncherServer> {
  const host = options.host ?? BIND_HOST;
  assertLoopbackHost(host);
  const distDir = resolve(options.distDir);
  const journalPath =
    options.journalPath === undefined
      ? join(process.cwd(), ".pi", "fit-trace", "coaching-journal.json")
      : options.journalPath;

  let indexHtml: string;
  try {
    const file = await stat(join(distDir, "index.html"));
    if (!file.isFile()) throw new Error("not-a-file");
    indexHtml = await readFile(join(distDir, "index.html"), "utf8");
  } catch {
    throw new Error(
      `Static app build is missing at ${distDir} (no index.html). ` +
        `Build it first: pnpm --filter @agent-fit-trace/app build`,
    );
  }
  const indexWithRuntime = injectRuntimeScript(indexHtml);

  // Reuse the source validation: absolute http(s), no credentials/query/fragment.
  const upstreamBase = normalizeUpstreamBaseUrl(options.upstreamBaseUrl);

  const rawPublicConfig =
    options.publicConfig !== undefined ? options.publicConfig : await fetchUpstreamPublicConfig(upstreamBase);
  // Injected configs are untrusted input too: reject secret/service-role
  // keys and unsafe URLs with the shared guards (never served, never used
  // for the verifier).
  const publicConfig = rawPublicConfig === null ? null : validatePublicConfig(rawPublicConfig);
  const verifier =
    options.verifier !== undefined
      ? options.verifier
      : publicConfig !== null
        ? createSupabaseVerifier({
          supabaseUrl: publicConfig.supabaseUrl,
          publishableKey: publicConfig.supabasePublishableKey,
        })
        : null;
  const configuredRuntimeId = options.runtimeId ?? "pi";
  const configuredSelection = resolveCoachingBackendSelection({ runtimeId: configuredRuntimeId });
  if (configuredSelection.executionLocation !== "local") {
    throw new Error("the local launcher can only configure a local coaching runtime");
  }
  const runtimeFactory =
    options.runtimeFactory ??
    (options.piAvailable === false
      ? unavailablePiRuntimeFactory()
      : piRuntimeFactory(options.extensionPath ?? defaultExtensionPath(), options.piCwd ?? process.cwd(), { ...(options.piExecutable !== undefined ? { binary: options.piExecutable } : {}), ...(options.piEnv !== undefined ? { env: options.piEnv } : {}), ...(options.validatePiExecutable !== undefined ? { validateExecutable: options.validatePiExecutable } : {}) }));
  // local-pi remains the legacy v1 path even when another runtime is
  // configured: an omitted backend always maps to local-pi, never cloud.
  const localPiAvailable = options.piAvailable !== false || options.runtimeFactory !== undefined;
  const registrations: CoachingRuntimeRegistration[] = [
    localPiRegistration({ available: localPiAvailable, factory: runtimeFactory, ...(options.piExecutable !== undefined ? { executablePath: options.piExecutable } : {}), ...(options.piVersion !== undefined ? { version: options.piVersion } : {}) }),
  ];
  if (configuredSelection.backendId === "local-codex") {
    // Availability is derived from the INSTALLED app-server schema, gated in
    // the shared module so `start` and the daemon cannot drift apart. The
    // adapter declares only the two coached dynamic tools; without that
    // protocol surface a read-only sandbox still leaves built-in file/shell
    // tools usable, so the backend must stay unavailable.
    const detected = await detectLocalCodex({
      ...(options.codexBinary !== undefined ? { binary: options.codexBinary } : {}),
      ...(options.codexSupport !== undefined ? { support: options.codexSupport } : {}),
    });
    registrations.push(
      resolveLocalCodexRegistration(
        detected.support,
        { ...(detected.executablePath !== undefined ? { executablePath: detected.executablePath } : {}), ...(detected.env !== undefined ? { env: detected.env } : {}), ...(detected.validateExecutable !== undefined ? { validateExecutable: detected.validateExecutable } : {}), ...(detected.executablePath === undefined && options.codexBinary !== undefined ? { binary: options.codexBinary } : {}) },
      ),
    );
  } else if (configuredSelection.backendId === "local-opencode") {
    // Availability comes from the INSTALLED v2 CLI plus positive isolation
    // evidence, gated in the shared module. Without that evidence the adapter
    // remains gated: a wildcard deny is only trustworthy if the complete
    // built-in inventory, plugin tool list, and agent set were observed to be
    // excluded.
    const detected = await detectLocalOpenCode({
      ...(options.openCodeBinary !== undefined ? { binary: options.openCodeBinary } : {}),
      ...(options.openCodeModel !== undefined ? { model: options.openCodeModel } : {}),
      ...(options.openCodeSupport !== undefined ? { support: options.openCodeSupport } : {}),
      ...(options.openCodeIsolationVerifier !== undefined
        ? { verifyIsolation: options.openCodeIsolationVerifier }
        : {}),
    });
    registrations.push(
      resolveLocalOpenCodeRegistration(detected.support, {
        ...(detected.executablePath !== undefined ? { executablePath: detected.executablePath } : {}),
        ...(detected.env !== undefined ? { env: detected.env } : {}),
        ...(detected.validateExecutable !== undefined ? { validateExecutable: detected.validateExecutable } : {}),
        ...(detected.executablePath === undefined && options.openCodeBinary !== undefined ? { binary: options.openCodeBinary } : {}),
        ...(options.openCodeModel !== undefined ? { model: options.openCodeModel } : {}),
      }),
    );
  } else if (configuredSelection.backendId !== "local-pi") {
    // Configured but unimplemented: record the selection, never advertise it
    // as available and never fall back to pi under that backend id.
    registrations.push({
      backendId: configuredSelection.backendId,
      runtimeId: configuredSelection.runtimeId,
      executionLocation: "local",
      displayName: configuredSelection.backendId,
      available: false,
      unavailableReason: {
        code: "adapter-not-implemented",
        message: `${configuredSelection.backendId} is configured but its adapter is not implemented.`,
      },
    });
  }
  const runtimeRegistry = createCoachingRuntimeRegistry(registrations);
  const runtimeScript = buildRuntimeScriptBody(
    options.piAvailable === undefined ? undefined : { piAvailable: options.piAvailable },
  );

  async function handleStatic(response: ServerResponse, method: string, pathname: string): Promise<void> {
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
    const filePath = await resolveDistFile(distDir, pathname);
    if (filePath !== null) {
      // Never serve the raw index.html without the runtime bootstrap.
      if (normalize(filePath) === normalize(await realpath(join(distDir, "index.html")).catch(() => join(distDir, "index.html")))) {
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

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    route: { method: string; routeUrl: URL; pathname: string },
  ): Promise<void> {
    const { method, routeUrl, pathname } = route;
    const bare = pathname.replace(/^\/api\/v1(?=\/|$)/, "") || "/";
    const match = PROXY_ROUTES.find((candidate) => candidate.method === method && candidate.path === bare);
    if (match === undefined) {
      sendJson(response, 404, errorEnvelope("API_ERROR", `No route for ${method} ${pathname}.`));
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
    if (body !== undefined && !match.acceptsBody) {
      sendJson(response, 400, errorEnvelope("VALIDATION_ERROR", "This endpoint does not accept a request body."));
      return;
    }

    const search = match.forwardQuery ? routeUrl.search : "";
    const target = `${upstreamBase}${match.path}${search}`;
    const outgoing: Record<string, string> = { accept: "application/json" };
    // Credentials travel ONLY to the allowlisted data endpoints that need
    // them — and only as the exact header the client sent. The public
    // bootstrap endpoint never receives the bearer.
    if (match.forwardAuth) {
      const authorization = request.headers.authorization;
      if (typeof authorization === "string" && authorization !== "") {
        outgoing.authorization = authorization;
      }
    }
    if (body !== undefined) outgoing["content-type"] = "application/json";

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers: outgoing,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      sendJson(response, 503, errorEnvelope("STORAGE_UNAVAILABLE", "Upstream workout API is temporarily unavailable."));
      return;
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      // Refuse to follow redirects (never route the browser or credentials
      // to an untrusted host); surface a gateway failure instead.
      try {
        await upstream.arrayBuffer().catch(() => undefined);
      } catch {
        // Best-effort drain.
      }
      sendJson(response, 502, errorEnvelope("API_ERROR", "Upstream redirected the request; refusing to follow."));
      return;
    }

    const contentLength = upstream.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_UPSTREAM_BODY_BYTES) {
      sendJson(response, 502, errorEnvelope("API_ERROR", "Upstream payload exceeds the size limit."));
      return;
    }
    // Streamed BYTE cap (never a full unbounded buffer, never char length):
    // the reader is cancelled on overflow so multi-byte payloads are bounded
    // by bytes, not characters.
    let text: string;
    if (upstream.body === null) {
      sendJson(response, 502, errorEnvelope("API_ERROR", "Upstream returned an unreadable payload."));
      return;
    }
    try {
      text = await readBoundedBodyText(upstream.body, MAX_UPSTREAM_BODY_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message === "body-too-large") {
        sendJson(response, 502, errorEnvelope("API_ERROR", "Upstream payload exceeds the size limit."));
        return;
      }
      sendJson(response, 503, errorEnvelope("STORAGE_UNAVAILABLE", "Upstream workout API is temporarily unavailable."));
      return;
    }
    try {
      JSON.parse(text);
    } catch {
      sendJson(response, 502, errorEnvelope("API_ERROR", "Upstream returned an unreadable payload."));
      return;
    }
    response.writeHead(upstream.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(text);
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

    if (pathname === "/api/v1" || pathname.startsWith("/api/v1/") || pathname === "/api" || pathname.startsWith("/api/")) {
      await handleApi(request, response, { method, routeUrl, pathname });
      return true;
    }

    await handleStatic(response, method, pathname);
    return true;
  }

  // One owner, one listener: the coaching server binds; a busy preferred
  // port falls forward (port 0 binds once, no scan).
  const preferred = options.port ?? Number(process.env.FIT_TRACE_COACH_PORT ?? DEFAULT_PORT);
  const attempts = preferred === 0 ? 1 : PORT_SCAN_LIMIT + 1;
  // Two launchers over the same cwd would otherwise load and rewrite the same
  // journal with independent generation counters. Hold process ownership for
  // the listener lifetime; the lock is released on close or a failed startup.
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
          upstream: { baseUrl: upstreamBase },
          runtimeFactory,
          runtimeRegistry,
          publicConfig,
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
    throw error;
  }
  const bound = server;
  if (bound === null) {
    journalLock?.release();
    throw lastError instanceof Error ? lastError : new Error("launcher could not bind an available port");
  }

  return {
    url: bound.url,
    port: bound.port,
    upstreamBaseUrl: upstreamBase,
    service: bound.service,
    close: async () => {
      try {
        await bound.close();
      } finally {
        journalLock?.release();
      }
    },
  };
}
