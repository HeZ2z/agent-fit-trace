/**
 * Safe post-login return targets.
 *
 * The App keeps the requested URL while showing the inline sign-in gate, and
 * the sign-in/guest buttons navigate back to it only after success. Targets
 * are stored in `sessionStorage` (tab-scoped, never `localStorage`) after the
 * same sanitizer that runs again on read, so a stale or tampered value cannot
 * send a fresh session to an external origin, an auth loop, or a URL carrying
 * auth tokens. Auth callback hashes never enter this store.
 */

const STORAGE_KEY = "pi-fit-trace:auth:return-target:v1";
const EXPLICIT_SIGN_OUT_KEY = "pi-fit-trace:auth:explicit-sign-out:v1";
const EXPLICIT_SIGN_OUT_TTL_MS = 10_000;
const MAX_LENGTH = 2048;
const BASE_ORIGIN = "http://fit-trace.invalid";

const AUTH_PATHS = new Set([
  "/login",
  "/forgot-password",
  "/reset-password",
  "/auth/callback",
]);

const EXACT_PATHS = new Set(["/", "/me", "/workout/new", "/analysis", "/plan", "/coach"]);

/** Query keys that may carry credentials or callback state we must not replay. */
const AUTH_QUERY_KEYS = new Set([
  "access_token",
  "refresh_token",
  "provider_token",
  "token_hash",
  "code",
  "type",
  "error",
  "error_code",
  "error_description",
]);

const WORKOUT_PATH = /^\/workout\/[A-Za-z0-9._~-]+$/;

interface ExplicitSignOutMarker {
  path: string;
  at: number;
}

function isAuthScreenPath(pathname: string): boolean {
  return AUTH_PATHS.has(pathname);
}

function pathOnly(raw: unknown): string | null {
  return typeof raw === "string" ? raw.split(/[?#]/, 1)[0] ?? null : null;
}

/**
 * Read the tab-scoped sign-out marker. A marker is only an artifact of the
 * sign-out transition: it never lives across tabs/providers indefinitely and
 * expires quickly so it cannot suppress a later intentional deep link.
 */
function readExplicitSignOut(): ExplicitSignOutMarker | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(EXPLICIT_SIGN_OUT_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed = JSON.parse(raw) as Partial<ExplicitSignOutMarker>;
    if (typeof parsed.path !== "string" || typeof parsed.at !== "number") {
      clearExplicitSignOut();
      return null;
    }
    if (Date.now() - parsed.at > EXPLICIT_SIGN_OUT_TTL_MS) {
      clearExplicitSignOut();
      return null;
    }
    return { path: parsed.path, at: parsed.at };
  } catch {
    return null;
  }
}

/** Called by sign-out before the session clears; also clears any old target. */
export function markExplicitSignOut(pathname: string): void {
  clearReturnTarget();
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) {
    clearExplicitSignOut();
    return;
  }
  try {
    globalThis.sessionStorage?.setItem(
      EXPLICIT_SIGN_OUT_KEY,
      JSON.stringify({ path: pathname, at: Date.now() } satisfies ExplicitSignOutMarker),
    );
  } catch {
    // Without storage the only effect is a stale gate capture; auth stays safe.
  }
}

/** Called after a successful sign-in/guest sign-in, or by an explicit reset. */
export function clearExplicitSignOut(): void {
  try {
    globalThis.sessionStorage?.removeItem(EXPLICIT_SIGN_OUT_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function hasForbiddenRawCharacters(value: string): boolean {
  if (value.includes("\\")) return true;
  // Control characters (including newlines, NUL, and DEL) are never valid in
  // a returned path and are a common parser-differential trick.
  return /[\u0000-\u001F\u007F]/.test(value);
}

/**
 * Decode repeatedly so double/triple-encoded separators and credential keys
 * cannot hide from the checks below. If the value is still mutating at the
 * bound, reject it rather than guess.
 */
function decodeBounded(value: string): string | null {
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) return current;
    current = decoded;
  }
  return null;
}

function parseSameOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value, BASE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== BASE_ORIGIN) return null;
  return url;
}

function hasAuthQueryKey(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (AUTH_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

function isSafePath(pathname: string): boolean {
  return !AUTH_PATHS.has(pathname) && (EXACT_PATHS.has(pathname) || WORKOUT_PATH.test(pathname));
}

/**
 * Return a safe same-origin app path (pathname + query) or null.
 *
 * Accepted: `/`, `/me`, `/workout/new`, `/workout/<opaque-id>`, `/analysis`,
 * `/plan`, `/coach`, each optionally with ordinary query parameters. Rejected:
 * absolute/protocol-relative URLs, backslashes, control characters, encoded
 * separators, fragments (auth hashes), auth screens, unknown routes, and any
 * query carrying auth token/callback fields — including when those keys are
 * nested-encoded (`?%2561ccess_token=…`).
 */
export function sanitizeReturnTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("#")) return null;
  if (hasForbiddenRawCharacters(raw)) return null;

  const decoded = decodeBounded(raw);
  if (decoded === null) return null;
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return null;
  if (decoded.includes("\\") || decoded.includes("://") || decoded.includes("#")) return null;
  if (hasForbiddenRawCharacters(decoded)) return null;

  const url = parseSameOrigin(raw);
  const decodedUrl = parseSameOrigin(decoded);
  if (url === null || decodedUrl === null) return null;
  if (url.hash !== "" || decodedUrl.hash !== "") return null;
  if (!isSafePath(url.pathname) || !isSafePath(decodedUrl.pathname)) return null;
  if (hasAuthQueryKey(url) || hasAuthQueryKey(decodedUrl)) return null;
  // Query keys are the credential-bearing part; values may legitimately repeat
  // an arbitrary word, but a decoded path that changes route identity is not a
  // target this app should replay.
  if (url.pathname !== decodedUrl.pathname) return null;

  return `${url.pathname}${url.search}`;
}

/** Read the current tab's stored target, re-validated at read time. */
export function peekReturnTarget(): string | null {
  try {
    return sanitizeReturnTarget(globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Store a sanitized target. Returns what was stored (null when rejected). */
export function saveReturnTarget(raw: unknown): string | null {
  const marker = readExplicitSignOut();
  if (marker !== null) {
    const candidatePath = pathOnly(raw);
    if (candidatePath !== null && candidatePath === marker.path) {
      // This is the gate mounting because sign-out cleared the session, not a
      // deep link the user asked to resume. Consume the marker so a later
      // intentional visit to the same path is captured normally.
      clearExplicitSignOut();
      return null;
    }
    // Auth screens are rejected anyway; keep the marker so a gate that
    // mounts just before the /login route still cannot capture the old page.
    if (candidatePath !== null && !isAuthScreenPath(candidatePath)) clearExplicitSignOut();
  }
  const safe = sanitizeReturnTarget(raw);
  if (safe === null) return null;
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, safe);
  } catch {
    // Storage failures only cost the nice-to-have return target.
  }
  return safe;
}

/** Consume the target once: sign-in success or an explicit exit clears it. */
export function consumeReturnTarget(): string | null {
  const target = peekReturnTarget();
  clearReturnTarget();
  return target;
}

export function clearReturnTarget(): void {
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
