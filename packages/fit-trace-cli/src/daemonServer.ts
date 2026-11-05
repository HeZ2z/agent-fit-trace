import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
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
import { createReplaceableCoachingRuntimeRegistry } from "../../../server/coaching/runtimeRegistry.ts";
import {
  detectLocalCodex,
  detectLocalOpenCode,
  localPiRegistration,
  resolveLocalCodexRegistration,
  resolveLocalOpenCodeRegistration,
} from "../../../server/coaching/localRuntimeRegistrations.ts";
import type { DetectedLocalCli } from "../../../server/coaching/localRuntimeRegistrations.ts";
import type { CodexAppServerSupport } from "../../../server/coaching/codexAppServerCapability.ts";
import type { OpenCodeRunSupport } from "../../../server/coaching/opencodeCapability.ts";
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
import type { AuthPrincipal, CoachingBackendId, CoachingRuntimeId } from "@agent-fit-trace/api-contracts";
import { API_ENDPOINTS, resolveCoachingBackendSelection } from "@agent-fit-trace/api-contracts";

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

/**
 * Placeholders used BEFORE the real probes run.
 *
 * They are not "unavailable because the user lacks the CLI" — that would be a
 * lie we cannot yet support, and it would make a machine WITH Codex look
 * broken for as long as the probe takes. `supported: false` plus this gap
 * says exactly what is true: we have not asked yet. The registration helper
 * keeps them unavailable, so a submit before the probe lands is rejected with
 * a reason that will change, rather than dispatched to a factory that does not
 * exist.
 */
const UNPROBED_CODEX: DetectedLocalCli<CodexAppServerSupport> = {
  support: {
    supported: false,
    builtinIsolationVerified: false,
    gap: "the Codex CLI has not been probed yet; availability is still being determined",
  },
};

const UNPROBED_OPENCODE: DetectedLocalCli<OpenCodeRunSupport> = {
  support: {
    supported: false,
    isolationVerified: false,
    gap: "the OpenCode CLI has not been probed yet; availability is still being determined",
  },
};

/**
 * How long any single CLI probe may take before the refresh gives up on it.
 *
 * Bounded on purpose: these probes spawn child processes, and an installed-but-
 * broken CLI must not keep a refresh (and therefore a rescan) pending forever.
 * The daemon serves normally regardless — this only decides when to stop
 * waiting and publish what is known.
 */
const LOCAL_CLI_PROBE_TIMEOUT_MS = 20_000;

/**
 * How long `close()` waits for an in-flight probe refresh after aborting it.
 *
 * Small on purpose: the desktop shell allows the daemon only a few seconds
 * before SIGKILL, and a probe child is reaped by its own kill timer regardless.
 * This is a teardown bound, not a probe bound.
 */
const LOCAL_CLI_SHUTDOWN_GRACE_MS = 250;

/**
 * Map an operator's `--runtime` to the backend id it names.
 *
 * `--runtime` is a SELECTION, not a filter. The known default (`pi`) is used
 * when nothing is named, and an unknown/cloud runtime is refused earlier by
 * config parsing, so this only has to translate the local ids.
 */
export function defaultBackendIdFor(runtimeId: CoachingRuntimeId | undefined): CoachingBackendId {
  if (runtimeId === undefined) return "local-pi";
  const selection = resolveCoachingBackendSelection({ runtimeId });
  // The daemon serves local coaching only. A cloud runtime named as the local
  // default would preselect a backend this server cannot run, so it is refused
  // here rather than advertised and failing at submit time. `cli.ts` validates
  // the flag first; this is the belt-and-braces check for the embedding seam.
  if (selection.executionLocation !== "local") {
    throw new Error(`the daemon cannot default to the ${runtimeId} cloud runtime`);
  }
  return selection.backendId;
}

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
  /**
   * Pi CLI presence (default: coaching advertises available).
   *
   * A promise is accepted so a caller can start the probe WITHOUT awaiting it
   * before binding the listener (#68): startup must not depend on a child
   * process, but availability still needs the real answer. The daemon awaits it
   * once, when it builds the initial registrations.
   */
  piAvailable?: boolean | Promise<boolean>;
  /**
   * Path to the pi extension that coached runs load (`pi -e <path>`).
   *
   * `undefined` keeps the source-checkout default
   * (`<repo>/.pi/extensions/fit-trace/index.ts`), which is computed from
   * `import.meta.url` and is only correct when running from the repository.
   * A packaged build MUST pass this: the daemon bundle lives under
   * `Contents/Resources/`, so the derived path lands outside the app.
   *
   * Availability is decided from this path's existence (see
   * `resolvePiAvailability`), not from `piAvailable` alone — advertising a
   * coach whose extension cannot be found only defers the failure to the first
   * run, as an opaque `EXTENSION_ERROR`.
   */
  extensionPath?: string;
  /** Injectable `fs.existsSync`-style probe (tests). */
  pathExists?: (path: string) => boolean;
  /**
   * Test/embedding seam: replace the installed-CLI probes.
   *
   * Production never sets this. It exists so the availability matrix and the
   * late-probe behaviour can be tested without a real Codex or OpenCode on the
   * build machine — the gates stay closed in every normal run, which is
   * correct but would otherwise make the "becomes available" path untestable.
   */
  localCliProbes?: {
    codex?: () => Promise<DetectedLocalCli<CodexAppServerSupport>>;
    openCode?: () => Promise<DetectedLocalCli<OpenCodeRunSupport>>;
  };
  /**
   * How long one probe may take before the refresh publishes what it has.
   * Production leaves this at the default; tests shorten it so a deliberately
   * hanging probe does not force every run to sit through the real bound.
   */
  localCliProbeTimeoutMs?: number;
  /**
   * Durable coaching journal path (default `<dataDir>/coaching-journal.json`,
   * held under the same process lock as the launcher's). `null` keeps the
   * daemon in-process only (tests).
   */
  journalPath?: string | null;
  /**
   * Operator-selected DEFAULT local coaching backend (`--runtime`).
   *
   * It selects which backend a NEW coached run should preselect. It does NOT
   * filter what is discovered: the daemon reports every local CLI it can see,
   * because a settings page (#69) has to offer all of them, and hiding an
   * installed CLI would make it unreachable. Defaulting to `pi` preserves
   * today's behavior exactly for an operator who passes nothing.
   *
   * Unavailable values are accepted and reported, never silently coerced: a
   * caller that asked for Codex must be able to see that Codex is the default
   * AND that it is unavailable, rather than quietly getting pi.
   *
   * Documented in `docs/local-daemon.md`.
   */
  defaultRuntime?: CoachingRuntimeId;
}

export interface DaemonServer {
  url: string;
  port: number;
  dataDir: string;
  /**
   * The backend a NEW run should preselect, derived from `--runtime`.
   * `local-pi` when the operator named none.
   */
  defaultBackendId: CoachingBackendId;
  /** Resolves once the in-flight local CLI probe refresh has published. */
  localCliRefreshSettled(): Promise<void>;
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

/** Whether local-pi can run, and which extension file to use when it can. */
export interface PiAvailability {
  available: boolean;
  /**
   * Present iff `available` is true: the extension file that was actually
   * found. A coached run MUST use this rather than the requested path, so a
   * fallback candidate is honoured instead of silently reverting to the first
   * (possibly absent) choice.
   */
  path?: string;
  /**
   * Present iff `available` is false. `code` reuses the shared availability
   * enum so the app renders it without a daemon-specific vocabulary.
   */
  reason?: { code: "cli-not-installed" | "cli-version-unsupported"; message: string };
}

/**
 * Decide whether the local-pi backend can run a coached session, and WHICH
 * extension file it should load.
 *
 * The path is not taken on faith. A packaged app ships the extension as a
 * resource next to the daemon, but the exact location can differ between a
 * repackaged build, an operator override, and a source checkout; hard-failing
 * on the first candidate would turn a recoverable path mismatch into "local
 * coaching is broken". So the candidates are tried in order and the first
 * existing one wins.
 *
 * Candidates, in priority order:
 *   1. `extensionPath` — the explicit caller's choice (`--extension`, which the
 *      desktop shell always passes when packaged);
 *   2. `<daemonDir>/pi-extension.mjs` — the resource layout this daemon ships
 *      with, resolved from the running file rather than assumed;
 *   3. `<daemonDir>/../pi-extension.mjs` — one level up, covering a launcher
 *      that stages resources in a sibling directory;
 *   4. the source-checkout default under `<repo>/.pi/extensions/`.
 *
 * The returns distinguish the failures a user can act on:
 * - no `pi` CLI at all → `cli-not-installed`;
 * - a CLI but no extension anywhere in the candidate list → a packaging/build
 *   failure, reported with every path that was tried. It is deliberately NOT
 *   reported as "install pi": that sends the user to fix something that is
 *   already correct, the exact inversion this function exists to remove.
 *
 * A file-existence check is deliberately the bar. It cannot prove the extension
 * *loads*, so a present-but-broken file still fails at run time with
 * `EXTENSION_ERROR`; requiring a load probe would disable coaching on every pi
 * version we support, including the verified one.
 *
 * Pure apart from the injected `pathExists`, so every branch is unit-testable.
 */
export function resolvePiAvailability(options: {
  /** Result of the `pi --version` presence probe. */
  cliAvailable: boolean;
  /** Explicitly requested extension path (already resolved by the caller). */
  extensionPath?: string;
  /** Directory of the running daemon file; drives candidates 2 and 3. */
  daemonDir?: string;
  /** Injected for tests; defaults to `fs.existsSync`. */
  pathExists?: (path: string) => boolean;
}): PiAvailability {
  if (!options.cliAvailable) {
    return {
      available: false,
      reason: {
        code: "cli-not-installed",
        message: "pi CLI is not available on PATH.",
      },
    };
  }
  const exists = options.pathExists ?? existsSync;
  const candidates = piExtensionCandidates(options);
  for (const candidate of candidates) {
    if (exists(candidate)) {
      // `path` is the value a coached run must pass to `pi -e`; it may differ
      // from the caller's request when a fallback matched.
      return { available: true, path: candidate };
    }
  }
  return {
    available: false,
    reason: {
      code: "cli-version-unsupported",
      message:
        `pi CLI is installed, but no Fit Trace extension was found. Tried: ` +
        `${candidates.join(", ")}. This build cannot run local coaching; ` +
        `reinstall it or run from a source checkout.`,
    },
  };
}

/**
 * The extension locations to try, most specific first, deduplicated.
 *
 * Kept separate from the check so the ordering is directly testable and the
 * failure message can list exactly what was attempted.
 */
export function piExtensionCandidates(options: {
  extensionPath?: string;
  daemonDir?: string;
}): string[] {
  const candidates: string[] = [];
  const push = (value: string | undefined): void => {
    if (value !== undefined && value !== "" && !candidates.includes(value)) {
      candidates.push(value);
    }
  };
  push(options.extensionPath);
  if (options.daemonDir !== undefined && options.daemonDir !== "") {
    push(join(options.daemonDir, "pi-extension.mjs"));
    push(join(options.daemonDir, "..", "pi-extension.mjs"));
  }
  push(defaultExtensionPath());
  return candidates;
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

  // Resolve once: the same path feeds both the availability check and the
  // runtime factory, so discovery and execution cannot disagree about which
  // extension a coached run will load. `resolvePiAvailability` may return a
  // fallback candidate rather than the requested path, so the RUN must use
  // `piAvailability.path` — using `extensionPath` here would re-break exactly
  // the mismatch the fallback exists to absorb.
  // The pi probe may still be running: the caller is allowed to start it and
  // hand over the promise so the LISTENER does not wait (#68). We therefore
  // resolve availability twice: once optimistically for the listener (see
  // below), and once for real once the probe settles, publishing the result
  // through the replaceable registry.
  const piProbe: Promise<boolean> =
    options.piAvailable === undefined
      ? Promise.resolve(true)
      : typeof options.piAvailable === "boolean"
        ? Promise.resolve(options.piAvailable)
        : options.piAvailable;
  // Optimism is ONLY justified when the caller handed us a not-yet-settled
  // probe: then we genuinely do not know. An explicit `boolean` IS the answer,
  // so it must be honoured immediately — treating a known `false` as "probably
  // fine" would advertise a coach that cannot run until the refresh lands.
  const piKnownUpFront = typeof options.piAvailable === "boolean" ? options.piAvailable : true;
  const piAvailability = resolvePiAvailability({
    cliAvailable: piKnownUpFront,
    ...(options.extensionPath !== undefined ? { extensionPath: options.extensionPath } : {}),
    daemonDir: dirname(fileURLToPath(import.meta.url)),
    ...(options.pathExists !== undefined ? { pathExists: options.pathExists } : {}),
  });
  const runtimeFactory =
    options.runtimeFactory ??
    (piAvailability.available && piAvailability.path !== undefined
      ? defaultRuntimeFactory(piAvailability.path, process.cwd())
      : unavailablePiRuntimeFactory());
  // An injected factory is an explicit test/embedding opt-in: it owns its own
  // extension resolution and must not be gated by this path check.
  const localPiAvailable = piAvailability.available || options.runtimeFactory !== undefined;
  const enablePiSignal = localPiAvailable ? piAvailability.available : false;
  const piRegistration = localPiRegistration({
    available: localPiAvailable,
    factory: runtimeFactory,
    ...(localPiAvailable ? {} : { reason: piAvailability.reason }),
  });
  // Codex and OpenCode are registered from their probe results, which may not
  // be known yet. Start with them UNAVAILABLE and a truthful "not probed" gap,
  // then swap the snapshot in once the probes settle (see `refreshLocalClis`).
  // This ordering is the point: the data plane and the shell must never wait
  // for a child process that may be slow, hung, or absent.
  const rawCodexRegistration = resolveLocalCodexRegistration(UNPROBED_CODEX.support);
  const rawOpenCodeRegistration = resolveLocalOpenCodeRegistration(UNPROBED_OPENCODE.support);
  const runtimeRegistry = createReplaceableCoachingRuntimeRegistry([
    piRegistration,
    rawCodexRegistration,
    rawOpenCodeRegistration,
  ]);
  // The injected flag must reflect whether a run can actually start, not the
  // raw CLI probe: an installed pi whose extension is missing must report
  // `false` here, otherwise the Coach UI offers a backend that fails on use.
  let runtimeScript = buildRuntimeScriptBody({ piAvailable: enablePiSignal });

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
          // Publish the operator's `--runtime` choice so a client can
          // preselect it. Without this the flag is stored but never told to
          // anyone, and a run silently uses pi despite the selection.
          serviceOptions: { defaultBackendId: defaultBackendIdFor(options.defaultRuntime) },
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

  /**
   * Probe Codex and OpenCode AFTER the listener is up, then publish the result
   * by swapping the registry snapshot.
   *
   * Sequencing matters. `createCoachingService` captured the registry OBJECT,
   * so replacing its contents is enough — no restart, no re-wiring, and the
   * already-served listener keeps answering throughout. A probe that hangs is
   * bounded by `LOCAL_CLI_PROBE_TIMEOUT_MS` and leaves the backend reported as
   * "not probed yet" rather than blocking anything.
   *
   * Overlapping rescans coalesce: `refreshInFlight` holds the current attempt,
   * and a completion from a superseded attempt is discarded by comparing the
   * generation counter. Otherwise two quick rescans could publish an older
   * result over a newer one.
   */
  let refreshInFlight: Promise<void> | null = null;
  let refreshGeneration = 0;
  /**
   * Aborted on `close()`. A probe that is still running when the daemon shuts
   * down must not keep the process alive waiting for its own timeout — the
   * desktop shell gives the daemon only a few seconds before SIGKILL. Aborting
   * makes the refresh settle immediately; each probe's own kill timer still
   * reaps its child process, so nothing is left running either way.
   */
  const shutdownProbes = new AbortController();

  /**
   * Settled results, one slot per backend, plus the current published set.
   *
   * Each probe publishes on its OWN settle rather than waiting for the others.
   * The earlier `Promise.all` was wrong in two ways: a slow Codex probe held
   * back a pi result that had already said "absent" (discovery kept advertising
   * a coach that could not run, for up to the full probe bound), and an
   * injected pi promise that never resolves would suppress the Codex/OpenCode
   * results forever. Backends are independent facts and are published
   * independently.
   */
  const probed = {
    pi: null as { available: boolean; path?: string; reason?: unknown } | null,
    codex: UNPROBED_CODEX,
    openCode: UNPROBED_OPENCODE,
  };

  /** Publish whatever is currently known. Safe to call repeatedly. */
  function publishKnownLocalBackends(): void {
    const settledPiAvailable =
      options.runtimeFactory !== undefined || probed.pi?.available === true;
    const registrations = [
      localPiRegistration({
        available: settledPiAvailable,
        factory:
          options.runtimeFactory ??
          (probed.pi?.available === true && probed.pi.path !== undefined
            ? defaultRuntimeFactory(probed.pi.path, process.cwd())
            : unavailablePiRuntimeFactory()),
        ...(settledPiAvailable
          ? {}
          : { reason: probed.pi?.reason as never }),
      }),
      resolveLocalCodexRegistration(probed.codex.support, {
        ...(probed.codex.executablePath !== undefined
          ? { executablePath: probed.codex.executablePath }
          : {}),
      }),
      resolveLocalOpenCodeRegistration(probed.openCode.support, {
        ...(probed.openCode.executablePath !== undefined
          ? { executablePath: probed.openCode.executablePath }
          : {}),
      }),
    ];
    runtimeRegistry.replace(registrations);
  }

  async function runLocalCliRefresh(generation: number): Promise<void> {
    const codexProbe = options.localCliProbes?.codex ?? (() => detectLocalCodex({}));
    const openCodeProbe = options.localCliProbes?.openCode ?? (() => detectLocalOpenCode({}));
    const probeTimeoutMs = options.localCliProbeTimeoutMs ?? LOCAL_CLI_PROBE_TIMEOUT_MS;
    // `generation` guards against an older refresh publishing over a newer one.
    const stillCurrent = (): boolean => generation === refreshGeneration;

    const settlePi = (async (): Promise<void> => {
      const piCliAvailable = await piProbe.catch(() => false);
      if (!stillCurrent()) return;
      probed.pi = resolvePiAvailability({
        cliAvailable: piCliAvailable,
        ...(options.extensionPath !== undefined ? { extensionPath: options.extensionPath } : {}),
        daemonDir: dirname(fileURLToPath(import.meta.url)),
        ...(options.pathExists !== undefined ? { pathExists: options.pathExists } : {}),
      });
      publishKnownLocalBackends();
    })();

    const settleCodex = (async (): Promise<void> => {
      const detected = await settleWithin(
        codexProbe(),
        probeTimeoutMs,
        UNPROBED_CODEX,
        shutdownProbes.signal,
      );
      if (!stillCurrent()) return;
      probed.codex = detected;
      publishKnownLocalBackends();
    })();

    const settleOpenCode = (async (): Promise<void> => {
      const detected = await settleWithin(
        openCodeProbe(),
        probeTimeoutMs,
        UNPROBED_OPENCODE,
        shutdownProbes.signal,
      );
      if (!stillCurrent()) return;
      probed.openCode = detected;
      publishKnownLocalBackends();
    })();

    await Promise.all([settlePi, settleCodex, settleOpenCode]);
  }

  function refreshLocalClis(): Promise<void> {
    if (refreshInFlight !== null) return refreshInFlight;
    refreshGeneration += 1;
    const generation = refreshGeneration;
    const attempt = runLocalCliRefresh(generation)
      .catch((error: unknown) => {
        // A probe failure is never fatal: the backends simply stay as they are
        // (unavailable, with the "not probed yet" gap) and the data plane is
        // unaffected. Log once so a persistent failure is diagnosable.
        console.error(
          `[daemon] local CLI probe failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (refreshInFlight === attempt) refreshInFlight = null;
      });
    refreshInFlight = attempt;
    return attempt;
  }

  // Kick off the first refresh without awaiting it: startup must not depend on
  // any child process. The promise is RETAINED (not discarded with `void`) so a
  // caller can await the startup result even after it settles — reading
  // `refreshInFlight` alone returns an empty promise once it has finished,
  // which would let a caller observe the pre-probe snapshot and conclude the
  // probe never landed.
  const firstRefresh = refreshLocalClis();

  return {
    url: bound.url,
    port: bound.port,
    dataDir,
    defaultBackendId: defaultBackendIdFor(options.defaultRuntime),
    /**
     * Resolve once the current probe refresh has published its result.
     *
     * Tests need this to observe the post-probe state without sleeping; it is
     * harmless in production and callers may ignore it. It never starts a new
     * probe.
     */
    localCliRefreshSettled: (): Promise<void> => firstRefresh,
    close: async () => {
      try {
        await bound.close();
      } finally {
        // Stop waiting on any in-flight probe: shutdown must be prompt, and a
        // probe that is still running is bounded by its own kill timer. Bounded
        // again here so even a half-implemented probe cannot hold teardown open.
        shutdownProbes.abort();
        await settleWithin(
          refreshInFlight ?? Promise.resolve(),
          LOCAL_CLI_SHUTDOWN_GRACE_MS,
          undefined,
        );
        journalLock?.release();
        stores.closeAll();
      }
    },
  };
}

/**
 * Await `promise`, but never longer than `timeoutMs`; on timeout or rejection
 * return `fallback` so a refresh always publishes something rather than
 * becoming unobservable.
 */
async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
      new Promise<T>((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) {
          resolve(fallback);
          return;
        }
        onAbort = () => resolve(fallback);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}
