/**
 * Stateless Streamable HTTP transport for the remote MCP endpoint.
 *
 * The endpoint is a *resource server*: every request authenticates with its own
 * OAuth access token, and identity is never carried by a session. That single
 * decision drives the whole shape of this module:
 *
 * - A fresh `WebStandardStreamableHTTPServerTransport` and a fresh
 *   `createFitTraceMcpServer` are built **per request**. Reusing a stateless
 *   transport throws ("Stateless transport cannot be reused across
 *   requests"), and reusing one would also mean reusing one store, which is
 *   exactly the cross-user identity leak this design forbids. Nothing is cached
 *   in module scope: no transports, no servers, no stores, no principals.
 * - The store is built from the verified principal and that request's own
 *   access token, so PostgREST RLS (`auth.uid() = owner_id`) is the authority
 *   and the service-role key never appears on this path.
 * - The transport gets the caller's token as `authInfo`, not a session
 *   reference, so a downstream handler can never mistake a session for an
 *   identity.
 *
 * Failure policy is fail-closed throughout: a missing config, verifier, store
 * factory, or coach prompt answers 503, and a missing/invalid token answers 401
 * with the RFC 9728 discovery challenge. There is no anonymous path.
 *
 * The module is pure in the sense that everything environment-specific is
 * injected: `config`, `verifier`, `storeFor`, and the skill text (a value or a
 * loader). That makes the handler testable through a real `fetch`-shaped
 * function without stubbing the MCP SDK.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createFitTraceMcpServer } from "@agent-fit-trace/mcp";
import type { FitTraceStore } from "@agent-fit-trace/mcp";

import { MAX_REQUEST_BODY_BYTES } from "../authenticatedHandler.ts";
import { extractBearerToken } from "../auth/verifier.ts";
import { MCP_AUTH_ERRORS, McpAuthError } from "./contracts.ts";
import type {
  McpAuthConfig,
  McpAuthErrorCode,
  McpAuthPrincipal,
  McpTokenVerifier,
} from "./contracts.ts";
import {
  MCP_METADATA_QUERY_KEY,
  buildBearerChallenge,
  isProtectedResourceMetadataPath,
  readProtectedResourceMetadata,
} from "./resourceMetadata.ts";

/** OAuth error names surfaced in the JSON body next to the challenge header. */
const BODIES = {
  invalidToken: "A valid OAuth access token is required to use this MCP endpoint.",
  insufficientScope: "The access token is not authorized for this operation.",
  authUnavailable: "Authentication service is unavailable.",
  notConfigured: "The remote MCP endpoint is not configured on this deployment.",
  storeUnavailable: "The remote MCP endpoint has no data backend available.",
  promptUnavailable: "The training-coach prompt is unavailable on this deployment.",
  methodNotAllowed: "This MCP endpoint accepts POST (JSON-RPC) requests only.",
  internal: "Internal error.",
} as const;

type SkillTextSource = string | null | (() => string | null | Promise<string | null>);

export interface McpHttpHandlerOptions {
  /**
   * Validated resource-server configuration. `null` (missing/unsafe env) makes
   * the endpoint answer 503 instead of serving without a resource binding.
   */
  config: McpAuthConfig | null;
  /** Injectable token verifier; `null` fails closed with 503. */
  verifier: McpTokenVerifier | null;
  /**
   * Build the store for one verified principal. `null` fails closed with 503.
   * Called once per request, never memoized.
   *
   * It receives the whole verified principal — not just the id — because a
   * cloud store also needs that request's own access token for RLS. The
   * parameter is the *verified* principal, never anything from the request
   * body, a session header, or a cache.
   */
  storeFor: ((principal: McpAuthPrincipal) => FitTraceStore) | null;
  /**
   * Training-coach prompt body (frontmatter stripped). A loader's *success* is
   * memoized per handler instance — file contents are immutable configuration,
   * unlike identity, transports, or stores. A throw or an empty result is
   * retried on the next request instead of being cached.
   *
   * `null`/blank fails closed with 503: the prompt is part of the served
   * surface, so serving a silently empty coach contract would be worse than
   * refusing.
   */
  skillText: SkillTextSource;
  /**
   * Scopes this endpoint requires. The frozen {@link McpAuthPrincipal} carries
   * no scope list, so a non-empty requirement cannot be satisfied and every
   * authenticated request is answered `403 insufficient_scope` with the
   * required scopes named in the challenge. Empty (the default) means the
   * resource is scope-agnostic today; see `docs/mcp.md`.
   */
  requiredScopes?: readonly string[];
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

function authResponse(
  status: number,
  code: string,
  message: string,
  challenge: string,
): Response {
  return jsonResponse(
    status,
    { error: { code, message } },
    { "www-authenticate": challenge },
  );
}

/** Resolve the metadata request marker on either the rewritten or original URL. */
function isMetadataRequest(url: URL): boolean {
  if (url.searchParams.get(MCP_METADATA_QUERY_KEY) !== null) return true;
  return isProtectedResourceMetadataPath(url.pathname);
}

/**
 * Normalize whatever skill-source was injected into a promise of text, memoized
 * on *success* only. A failed or empty read is retried on the next request: a
 * transient filesystem error must not permanently break a warm instance, and
 * caching a miss would turn one bad moment into a permanent outage.
 */
function skillTextReader(source: SkillTextSource): () => Promise<string | null> {
  if (typeof source !== "function") {
    const fixed = source;
    return async () => fixed;
  }
  let pending: Promise<string | null> | null = null;
  return () => {
    if (pending === null) {
      pending = Promise.resolve()
        .then(() => source())
        .catch(() => null)
        .then((text) => {
          if (text === null || text.trim() === "") pending = null;
          return text;
        });
    }
    return pending;
  };
}

/** True when the resolved skill body is usable as the coach prompt. */
function hasSkillText(text: string | null): text is string {
  return typeof text === "string" && text.trim() !== "";
}

/**
 * Create the `/api/mcp` request handler.
 *
 * The returned function has the `fetch` shape — `(request: Request) =>
 * Promise<Response>` — so it can be composed with any Web-Standards runtime and
 * exercised directly in tests.
 */
export function createMcpHttpHandler(
  options: McpHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const config = options.config;
  const requiredScopes = (options.requiredScopes ?? [])
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
  const readSkillText = skillTextReader(options.skillText);
  const metadata = readProtectedResourceMetadata(config);

  /** The challenge for a rejection; never invents a URL when unconfigured. */
  function challenge(code?: McpAuthErrorCode): string {
    return buildBearerChallenge({
      resource: config?.resource ?? null,
      ...(code === undefined ? {} : { code }),
      ...(requiredScopes.length > 0 ? { scopes: requiredScopes } : {}),
    });
  }

  /**
   * Serve RFC 9728 Protected Resource Metadata. Unauthenticated by design: it
   * is the document the 401 challenge points at, so requiring a token would
   * deadlock discovery.
   */
  function serveMetadata(): Response {
    if (metadata === null) {
      return jsonResponse(
        503,
        { error: { code: MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, message: BODIES.notConfigured } },
        { "www-authenticate": challenge(MCP_AUTH_ERRORS.AUTH_UNAVAILABLE) },
      );
    }
    return jsonResponse(200, metadata);
  }

  return async function handle(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse(400, {
        error: { code: "MCP_INVALID_REQUEST", message: "Request URL is malformed." },
      });
    }

    if (isMetadataRequest(url)) {
      // Never authenticated, never a JSON-RPC surface.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse(
          405,
          { error: { code: "MCP_METHOD_NOT_ALLOWED", message: BODIES.methodNotAllowed } },
          { allow: "GET, HEAD" },
        );
      }
      return serveMetadata();
    }

    // Everything below is the MCP endpoint itself. Missing deployment config
    // is an outage, not a client error, and never a reason to serve anonymously.
    if (config === null) {
      return jsonResponse(
        503,
        { error: { code: MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, message: BODIES.notConfigured } },
        { "www-authenticate": challenge(MCP_AUTH_ERRORS.AUTH_UNAVAILABLE) },
      );
    }
    if (options.verifier === null) {
      return jsonResponse(
        503,
        { error: { code: MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, message: BODIES.authUnavailable } },
        { "www-authenticate": challenge(MCP_AUTH_ERRORS.AUTH_UNAVAILABLE) },
      );
    }
    if (options.storeFor === null) {
      return jsonResponse(
        503,
        { error: { code: MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, message: BODIES.storeUnavailable } },
        { "www-authenticate": challenge(MCP_AUTH_ERRORS.AUTH_UNAVAILABLE) },
      );
    }

    // 1. Authenticate. The token is the only identity input on this path.
    const bearer = extractBearerToken(request.headers.get("authorization") ?? undefined);
    if (bearer === null) {
      return authResponse(
        401,
        MCP_AUTH_ERRORS.INVALID_TOKEN,
        BODIES.invalidToken,
        challenge(MCP_AUTH_ERRORS.INVALID_TOKEN),
      );
    }
    let principal: McpAuthPrincipal;
    try {
      principal = await options.verifier(bearer);
    } catch (error) {
      if (error instanceof McpAuthError) {
        // A verifier outage maps to 503 with `auth_unavailable`; the challenge
        // still points at discovery so the client can retry intelligently.
        return authResponse(
          error.status,
          error.code,
          error.code === MCP_AUTH_ERRORS.AUTH_UNAVAILABLE
            ? BODIES.authUnavailable
            : BODIES.invalidToken,
          challenge(error.code),
        );
      }
      // An unexpected verifier failure is never surfaced verbatim: it could
      // carry token fragments. Fixed copy, and fail closed.
      return authResponse(
        503,
        MCP_AUTH_ERRORS.AUTH_UNAVAILABLE,
        BODIES.authUnavailable,
        challenge(MCP_AUTH_ERRORS.AUTH_UNAVAILABLE),
      );
    }

    // 2. Scope gate. Scopes are not part of the verified principal contract, so
    // a non-empty requirement is unsatisfiable and fails closed with the scopes
    // named in the challenge (which is what lets a client upscope).
    if (requiredScopes.length > 0) {
      return authResponse(
        403,
        MCP_AUTH_ERRORS.INSUFFICIENT_SCOPE,
        BODIES.insufficientScope,
        challenge(MCP_AUTH_ERRORS.INSUFFICIENT_SCOPE),
      );
    }

    // 3. Stateless method gate. POST carries JSON-RPC; GET would open a
    // server-initiated SSE stream that stateless mode cannot scope to a caller,
    // and DELETE would terminate a session that does not exist. Answer both
    // explicitly instead of letting the transport open a stream or crash.
    if (request.method !== "POST") {
      return jsonResponse(
        405,
        { error: { code: "MCP_METHOD_NOT_ALLOWED", message: BODIES.methodNotAllowed } },
        { allow: "POST" },
      );
    }

    // 4. Resolve the coach prompt. Refusing beats serving an empty contract.
    let skillText: string | null;
    try {
      skillText = await readSkillText();
    } catch {
      skillText = null;
    }
    if (!hasSkillText(skillText)) {
      return jsonResponse(503, {
        error: { code: "MCP_PROMPT_UNAVAILABLE", message: BODIES.promptUnavailable },
      });
    }

    // 5. Build this request's store, server, and transport. All three are
    // request-local by construction: nothing survives past the response.
    let store: FitTraceStore;
    try {
      store = options.storeFor(principal);
    } catch {
      return jsonResponse(503, {
        error: { code: MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, message: BODIES.storeUnavailable },
      });
    }

    const server = createFitTraceMcpServer({ store, skillText });
    const transport = new WebStandardStreamableHTTPServerTransport({
      // `undefined` (not omitted) selects stateless mode: no session id is ever
      // issued, so a session header can never be mistaken for identity.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } catch {
        // A close failure must not turn a completed response into an error.
      }
    };
    transport.onerror = () => {
      // The transport already maps protocol errors into responses; the callback
      // only exists so the SDK does not throw on an unhandled emit. Diagnostics
      // stay off stdout (which is protocol-only on stdio) and out of responses.
    };

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        authInfo: {
          token: principal.accessToken,
          clientId: principal.clientId,
          // No scope list is available from the frozen principal contract; the
          // endpoint enforces no scope requirement today (see `requiredScopes`).
          scopes: [],
          resource: new URL(principal.resource),
          extra: { principalId: principal.principal.id },
        },
      });
      // Response headers are the SDK's; add the hardening headers the data API
      // already sends so a cached or content-sniffed response cannot leak data.
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      // Never echo an exception: it can carry request internals. Fixed copy.
      return jsonResponse(500, {
        error: { code: "MCP_INTERNAL_ERROR", message: BODIES.internal },
      });
    } finally {
      // The response body above is already fully materialized by JSON-response
      // mode, so closing here cannot truncate it.
      await close();
    }
  };
}
