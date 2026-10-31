import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MCP_AUTH_ERROR_STATUS,
  MCP_AUTH_ERRORS,
  MCP_RESOURCE_CLAIM,
  McpAuthError,
} from "../server/mcp/contracts.ts";
import type { McpAuthConfig, McpAuthErrorCode } from "../server/mcp/contracts.ts";
import { createMcpTokenVerifier } from "../server/mcp/auth.ts";
import { MCP_ENV_VARS, readMcpAuthConfig } from "../server/mcp/env.ts";

const SUPABASE_URL = "https://ref.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_key";
const RESOURCE = "https://agent-fit-trace.example.com/api/mcp";
const CLIENT_ID = "client-allowed-uuid";

function config(over: Partial<McpAuthConfig> = {}): McpAuthConfig {
  return {
    supabaseUrl: SUPABASE_URL,
    publishableKey: PUBLISHABLE_KEY,
    issuer: `${SUPABASE_URL}/auth/v1`,
    resource: RESOURCE,
    allowedClientIds: [CLIENT_ID],
    ...over,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A structurally valid JWT; the signature is never checked locally. */
function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.test-signature`;
}

/** Allow-listed MCP claims for the test project. */
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `${SUPABASE_URL}/auth/v1`,
    aud: "authenticated",
    exp: nowSeconds() + 600,
    sub: "user-1",
    client_id: CLIENT_ID,
    [MCP_RESOURCE_CLAIM]: RESOURCE,
    ...over,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: input instanceof Request ? input.url : String(input),
      init,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function userResponse(over: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ id: "user-1", ...over }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function expectAuthError(
  promise: Promise<unknown>,
  code: McpAuthErrorCode,
  token?: string,
): Promise<McpAuthError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof McpAuthError)) throw error;
    assert.equal(error.code, code);
    assert.equal(error.status, MCP_AUTH_ERROR_STATUS[code]);
    // No failure message may echo the credential or its payload segment.
    // Degenerate inputs have an empty/short payload segment, which would make
    // a substring check vacuously true, so only meaningful segments are checked.
    if (token !== undefined) {
      assert.ok(!error.message.includes(token), "message must not contain the token");
      const payloadSegment = token.split(".")[1] ?? "";
      if (payloadSegment.length >= 8) {
        assert.ok(!error.message.includes(payloadSegment), "message must not contain the claims");
      }
    }
    return error;
  }
  assert.fail(`expected McpAuthError(${code})`);
}

// ---------------------------------------------------------------------------
// createMcpTokenVerifier — happy path
// ---------------------------------------------------------------------------

test("valid MCP token is accepted with the verified principal and token provenance", async () => {
  const token = jwt(claims());
  const { fetchImpl, calls } = fakeFetch(() =>
    userResponse({ email: "athlete@example.com", is_anonymous: false }),
  );
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  const result = await verify(token);

  assert.equal(result.principal.id, "user-1");
  assert.equal(result.principal.email, "athlete@example.com");
  assert.equal(result.principal.isAnonymous, false);
  assert.equal(result.clientId, CLIENT_ID);
  assert.equal(result.resource, RESOURCE);
  assert.equal(result.accessToken, token);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${SUPABASE_URL}/auth/v1/user`);
  assert.deepEqual(calls[0]?.init?.headers, {
    apikey: PUBLISHABLE_KEY,
    Authorization: `Bearer ${token}`,
  });
});

test("principal omits email/isAnonymous when the Auth server did not send them", async () => {
  const { fetchImpl } = fakeFetch(() => new Response(JSON.stringify({ id: "user-1" })));
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  const result = await verify(jwt(claims()));

  assert.deepEqual(result.principal, { id: "user-1" });
});

test("a valid nbf in the past is accepted", async () => {
  const { fetchImpl } = fakeFetch(() => userResponse());
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  const result = await verify(jwt(claims({ nbf: nowSeconds() - 30 })));
  assert.equal(result.principal.id, "user-1");
});

test("a trailing slash on supabaseUrl does not double the Auth path", async () => {
  const { fetchImpl, calls } = fakeFetch(() => userResponse());
  const verify = createMcpTokenVerifier(config({ supabaseUrl: `${SUPABASE_URL}/` }), { fetchImpl });

  await verify(jwt(claims()));
  assert.equal(calls[0]?.url, `${SUPABASE_URL}/auth/v1/user`);
});

// ---------------------------------------------------------------------------
// createMcpTokenVerifier — local claim failures (no Auth call happens)
// ---------------------------------------------------------------------------

async function expectClaimRejection(
  payload: Record<string, unknown>,
  code: McpAuthErrorCode = MCP_AUTH_ERRORS.INVALID_TOKEN,
): Promise<McpAuthError> {
  const token = jwt(payload);
  const { fetchImpl, calls } = fakeFetch(() => {
    throw new Error("Auth must not be called for a claim-level rejection");
  });
  const verify = createMcpTokenVerifier(config(), { fetchImpl });
  const error = await expectAuthError(verify(token), code, token);
  assert.equal(calls.length, 0, "no Auth call for locally rejected claims");
  return error;
}

test("expired token is rejected", async () => {
  await expectClaimRejection(claims({ exp: nowSeconds() - 1 }));
});

test("token with a missing exp is rejected", async () => {
  const { exp: _exp, ...rest } = claims();
  await expectClaimRejection(rest);
});

test("token from a different issuer is rejected", async () => {
  await expectClaimRejection(claims({ iss: "https://other.supabase.co/auth/v1" }));
});

test("issuer must match exactly, not merely by prefix", async () => {
  await expectClaimRejection(claims({ iss: `${SUPABASE_URL}/auth/v1/` }));
});

test("token without the authenticated audience is rejected", async () => {
  await expectClaimRejection(claims({ aud: "other-audience" }));
});

test("token with a missing aud is rejected", async () => {
  const { aud: _aud, ...rest } = claims();
  await expectClaimRejection(rest);
});

test("aud as an array is accepted only when it contains authenticated", async () => {
  const { fetchImpl } = fakeFetch(() => userResponse());
  const verify = createMcpTokenVerifier(config(), { fetchImpl });
  const result = await verify(jwt(claims({ aud: ["authenticated", "other"] })));
  assert.equal(result.principal.id, "user-1");
});

test("token not yet valid (future nbf) is rejected", async () => {
  await expectClaimRejection(claims({ nbf: nowSeconds() + 300 }));
});

test("token with an empty sub is rejected", async () => {
  await expectClaimRejection(claims({ sub: "   " }));
});

test("token without a client_id is rejected", async () => {
  const { client_id: _clientId, ...rest } = claims();
  await expectClaimRejection(rest);
});

test("token from an unlisted OAuth client is rejected", async () => {
  await expectClaimRejection(claims({ client_id: "client-not-listed" }));
});

test("token with a missing resource claim is rejected", async () => {
  const { [MCP_RESOURCE_CLAIM]: _resource, ...rest } = claims();
  await expectClaimRejection(rest);
});

test("token bound to another resource is rejected", async () => {
  await expectClaimRejection(claims({ [MCP_RESOURCE_CLAIM]: "https://evil.example.com/api/mcp" }));
});

test("a custom resourceClaim override is honoured", async () => {
  const customClaim = "custom_resource";
  const token = jwt(
    Object.fromEntries(
      Object.entries(claims()).map(([key, value]) => [
        key === MCP_RESOURCE_CLAIM ? customClaim : key,
        value,
      ]),
    ),
  );
  const { fetchImpl, calls } = fakeFetch(() => userResponse());
  const verify = createMcpTokenVerifier(config({ resourceClaim: customClaim }), { fetchImpl });

  const result = await verify(token);
  assert.equal(result.resource, RESOURCE);
  assert.equal(calls.length, 1);
});

test("an empty bearer token is rejected without an Auth call", async () => {
  const { fetchImpl, calls } = fakeFetch(() => {
    throw new Error("Auth must not be called without a token");
  });
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  await expectAuthError(verify(""), MCP_AUTH_ERRORS.INVALID_TOKEN);
  assert.equal(calls.length, 0);
});

for (const malformed of ["not-a-jwt", "only.two", "a.b.c", "a..c", ".."]) {
  test(`malformed bearer (${JSON.stringify(malformed)}) is rejected`, async () => {
    const { fetchImpl, calls } = fakeFetch(() => {
      throw new Error("Auth must not be called for a malformed bearer");
    });
    const verify = createMcpTokenVerifier(config(), { fetchImpl });
    await expectAuthError(verify(malformed), MCP_AUTH_ERRORS.INVALID_TOKEN, malformed);
    assert.equal(calls.length, 0);
  });
}

// ---------------------------------------------------------------------------
// createMcpTokenVerifier — Auth server outcomes
// ---------------------------------------------------------------------------

test("Auth 401 maps to invalid_token", async () => {
  const token = jwt(claims());
  const { fetchImpl } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  await expectAuthError(verify(token), MCP_AUTH_ERRORS.INVALID_TOKEN, token);
});

test("Auth 403 maps to invalid_token", async () => {
  const token = jwt(claims());
  const { fetchImpl } = fakeFetch(() => new Response("forbidden", { status: 403 }));
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  await expectAuthError(verify(token), MCP_AUTH_ERRORS.INVALID_TOKEN, token);
});

test("Auth 500 maps to auth_unavailable, not invalid_token", async () => {
  const token = jwt(claims());
  const { fetchImpl } = fakeFetch(() => new Response("boom", { status: 500 }));
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  const error = await expectAuthError(verify(token), MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, token);
  assert.equal(error.status, 503);
});

test("Auth 429 maps to auth_unavailable", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("slow down", { status: 429 }));
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  await expectAuthError(verify(jwt(claims())), MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
});

test("a network error from Auth maps to auth_unavailable", async () => {
  const token = jwt(claims());
  const { fetchImpl } = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  const error = await expectAuthError(verify(token), MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, token);
  assert.equal(error.status, 503);
});

test("an unreadable Auth 2xx body maps to auth_unavailable", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("not json", { status: 200 }));
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  await expectAuthError(verify(jwt(claims())), MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
});

test("an Auth response whose id disagrees with the token sub is rejected", async () => {
  const token = jwt(claims());
  const { fetchImpl } = fakeFetch(() => userResponse({ id: "someone-else" }));
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  await expectAuthError(verify(token), MCP_AUTH_ERRORS.INVALID_TOKEN, token);
});

test("an Auth response with an empty id is rejected", async () => {
  const { fetchImpl } = fakeFetch(() => userResponse({ id: "" }));
  const verify = createMcpTokenVerifier(config(), { fetchImpl });

  await expectAuthError(verify(jwt(claims())), MCP_AUTH_ERRORS.INVALID_TOKEN);
});

test("a verifier built without a URL or key cannot be created", () => {
  assert.throws(
    () => createMcpTokenVerifier(config({ supabaseUrl: "/" }), {}),
    /requires a Supabase URL and a publishable key/,
  );
  assert.throws(
    () => createMcpTokenVerifier(config({ publishableKey: "" }), {}),
    /requires a Supabase URL and a publishable key/,
  );
});

// ---------------------------------------------------------------------------
// readMcpAuthConfig
// ---------------------------------------------------------------------------

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    [MCP_ENV_VARS.RESOURCE]: RESOURCE,
    [MCP_ENV_VARS.CLIENT_IDS]: CLIENT_ID,
    ...over,
  };
}

test("readMcpAuthConfig resolves the issuer, resource and client allow-list", () => {
  const config = readMcpAuthConfig(env({ [MCP_ENV_VARS.CLIENT_IDS]: `${CLIENT_ID},other, ,` }));

  assert.deepEqual(config, {
    supabaseUrl: SUPABASE_URL,
    publishableKey: PUBLISHABLE_KEY,
    issuer: `${SUPABASE_URL}/auth/v1`,
    resource: RESOURCE,
    allowedClientIds: [CLIENT_ID, "other"],
  });
});

test("readMcpAuthConfig strips trailing slashes from the project URL", () => {
  const config = readMcpAuthConfig(env({ SUPABASE_URL: `${SUPABASE_URL}//` }));
  assert.equal(config?.supabaseUrl, SUPABASE_URL);
  assert.equal(config?.issuer, `${SUPABASE_URL}/auth/v1`);
});

test("readMcpAuthConfig accepts the legacy SUPABASE_ANON_KEY alias", () => {
  const config = readMcpAuthConfig(
    env({ SUPABASE_PUBLISHABLE_KEY: undefined, SUPABASE_ANON_KEY: "legacy-anon-key" }),
  );
  assert.equal(config?.publishableKey, "legacy-anon-key");
});

test("readMcpAuthConfig fails closed without any Supabase env", () => {
  assert.equal(readMcpAuthConfig({}), null);
  assert.equal(readMcpAuthConfig(env({ SUPABASE_URL: undefined })), null);
  assert.equal(readMcpAuthConfig(env({ SUPABASE_PUBLISHABLE_KEY: undefined })), null);
});

test("readMcpAuthConfig rejects an unsafe Supabase URL", () => {
  assert.equal(readMcpAuthConfig(env({ SUPABASE_URL: "not-a-url" })), null);
  assert.equal(readMcpAuthConfig(env({ SUPABASE_URL: "ftp://ref.supabase.co" })), null);
});

test("readMcpAuthConfig rejects a service-role-looking key", () => {
  assert.equal(readMcpAuthConfig(env({ SUPABASE_PUBLISHABLE_KEY: "sb_secret_abc123" })), null);

  const serviceRoleJwt = jwt({ role: "service_role", iss: "supabase" });
  assert.equal(readMcpAuthConfig(env({ SUPABASE_PUBLISHABLE_KEY: serviceRoleJwt })), null);
});

test("readMcpAuthConfig fails closed on a blank or non-absolute resource", () => {
  assert.equal(readMcpAuthConfig(env({ [MCP_ENV_VARS.RESOURCE]: "" })), null);
  assert.equal(readMcpAuthConfig(env({ [MCP_ENV_VARS.RESOURCE]: "   " })), null);
  assert.equal(readMcpAuthConfig(env({ [MCP_ENV_VARS.RESOURCE]: undefined })), null);
  assert.equal(readMcpAuthConfig(env({ [MCP_ENV_VARS.RESOURCE]: "/api/mcp" })), null);
});

test("readMcpAuthConfig fails closed on an empty client allow-list", () => {
  assert.equal(readMcpAuthConfig(env({ [MCP_ENV_VARS.CLIENT_IDS]: "" })), null);
  assert.equal(readMcpAuthConfig(env({ [MCP_ENV_VARS.CLIENT_IDS]: " , ,, " })), null);
  assert.equal(readMcpAuthConfig(env({ [MCP_ENV_VARS.CLIENT_IDS]: undefined })), null);
});
