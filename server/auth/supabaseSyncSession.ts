import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import type { TokenVerifier } from "./verifier.ts";
import { createPublicKey, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { isValidPrincipalId } from "./verifier.ts";

export interface VerifiedSyncSession {
  principal: AuthPrincipal;
  issuer: string;
  sessionId: string;
}

/** Reject duplicate JSON keys, including differently escaped spellings. */
function parseUniqueJson(text: string): unknown {
  let offset = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(text[offset] ?? "\0")) offset++; };
  const string = (): string => {
    if (text[offset] !== '"') throw new Error("Expected JSON string.");
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") { offset++; continue; }
      if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    throw new Error("Unterminated JSON string.");
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Error("JSON nesting too deep.");
    whitespace();
    if (text[offset] === '"') { string(); return; }
    if (text[offset] === '{') {
      offset++; whitespace();
      const keys = new Set<string>();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        whitespace(); const key = string();
        if (keys.has(key)) throw new Error("Duplicate JSON key.");
        keys.add(key); whitespace();
        if (text[offset++] !== ':') throw new Error("Expected colon.");
        value(depth + 1); whitespace();
        const separator = text[offset++];
        if (separator === '}') return;
        if (separator !== ',') throw new Error("Expected object separator.");
      }
    }
    if (text[offset] === '[') {
      offset++; whitespace();
      if (text[offset] === ']') { offset++; return; }
      for (;;) {
        value(depth + 1); whitespace();
        const separator = text[offset++];
        if (separator === ']') return;
        if (separator !== ',') throw new Error("Expected array separator.");
      }
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++;
    if (offset === start) throw new Error("Expected JSON value.");
  };
  value(0); whitespace();
  if (offset !== text.length) throw new Error("Trailing JSON data.");
  return JSON.parse(text) as unknown;
}

/**
 * Only call after Auth has verified the exact token. Claims alone never verify
 * identity or signature. This accepts the controlled Supabase Auth contract,
 * not arbitrary externally minted or claim-hook-modified JWTs.
 */
export function parseSignedSyncIdentity(
  token: string,
  supabaseUrl: string,
  publicKeys: JsonWebKey[],
): { accountId: string; issuer: string; sessionId: string } {
  const parts = token.split(".");
  if (token.length > 16_384 || parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Invalid sync credential.");
  }
  const headerBytes = Buffer.from(parts[0], "base64url");
  if (headerBytes.toString("base64url") !== parts[0]) throw new Error("Invalid sync credential.");
  const header = parseUniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
  if (typeof header !== "object" || header === null || Array.isArray(header)) throw new Error("Invalid sync credential.");
  const fields = header as Record<string, unknown>;
  if (fields.alg !== "ES256" || typeof fields.kid !== "string" || fields.crit !== undefined || fields.b64 !== undefined) throw new Error("Invalid sync credential.");
  const candidates = publicKeys.filter(key => key.kid === fields.kid && key.kty === "EC" && key.crv === "P-256" && !key.d);
  const signature = Buffer.from(parts[2], "base64url");
  if (candidates.length !== 1 || signature.toString("base64url") !== parts[2] || signature.length !== 64 ||
      !verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: candidates[0], format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature)) {
    throw new Error("Invalid sync credential.");
  }
  const bytes = Buffer.from(parts[1], "base64url");
  if (bytes.toString("base64url") !== parts[1]) throw new Error("Invalid sync credential.");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const payload = parseUniqueJson(decoded);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Invalid sync credential.");
  const claims = payload as Record<string, unknown>;
  const issuer = `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  if (claims.iss !== issuer || !isValidPrincipalId(claims.sub) || claims.role !== "authenticated" ||
      !(claims.aud === "authenticated" || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === "authenticated")) ||
      typeof claims.session_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.session_id) || claims.session_id === "00000000-0000-0000-0000-000000000000" ||
      claims.sub === "guest") {
    throw new Error("Invalid sync credential.");
  }
  return { accountId: claims.sub, issuer, sessionId: claims.session_id.toLowerCase() };
}

export const SYNC_AUTH_TIMEOUT_MS = 10_000;
async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Sync authentication timed out.")); }, timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function verifySupabaseSyncSession(
  token: string,
  verifier: TokenVerifier,
  supabaseUrl: string,
  options: { publicKeys: JsonWebKey[]; publishableKey: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<VerifiedSyncSession> {
  const identity = parseSignedSyncIdentity(token, supabaseUrl, options.publicKeys);
  const principal = await bounded(signal => verifier.verify(token, { signal }), options.timeoutMs ?? SYNC_AUTH_TIMEOUT_MS);
  if (principal.id !== identity.accountId || principal.isAnonymous !== false) throw new Error("Invalid sync credential.");
  const owned = await bounded(async signal => {
    const response = await (options.fetchImpl ?? fetch)(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/fit_trace_sync_session_owned`, {
      method: "POST", redirect: "error", signal, headers: { apikey: options.publishableKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
    });
    if (!response.ok) throw new Error("Sync session verification unavailable or rejected.");
    return await response.json();
  }, options.timeoutMs ?? SYNC_AUTH_TIMEOUT_MS);
  if (owned !== true) throw new Error("Sync session verification unavailable or rejected.");
  return { principal, issuer: identity.issuer, sessionId: identity.sessionId };
}
