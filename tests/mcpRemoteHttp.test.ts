import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { ServerResponse } from "node:http";

import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import type { HistoryFilter, WorkoutRecord } from "@agent-fit-trace/core";
import type { FitTraceStore } from "@agent-fit-trace/mcp";
import type { QueryResult } from "@agent-fit-trace/store";

import { createMcpHttpHandler } from "../server/mcp/httpHandler.ts";
import type { McpHttpHandlerOptions } from "../server/mcp/httpHandler.ts";
import {
  MCP_AUTH_ERRORS,
  MCP_RESOURCE_CLAIM,
  McpAuthError,
} from "../server/mcp/contracts.ts";
import type { McpAuthConfig, McpAuthPrincipal, McpTokenVerifier } from "../server/mcp/contracts.ts";
import {
  MCP_METADATA_QUERY_KEY,
  MCP_SUPPORTED_SCOPES,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "../server/mcp/resourceMetadata.ts";
import { handleVercelApi } from "../server/vercel.ts";
import type { VercelRequestLike } from "../server/vercel.ts";
import { MCP_ENV_VARS } from "../server/mcp/env.ts";

/**
 * Remote MCP HTTP surface tests.
 *
 * Everything below goes through the real `fetch`-shaped handler: real
 * `Request`/`Response`, the real `WebStandardStreamableHTTPServerTransport`,
 * and the real `createFitTraceMcpServer` (the same factory the stdio entrypoint
 * uses). Only the two environment-dependent seams are injected — the token
 * verifier and the store factory — so the tests can observe per-request
 * identity without a network or a database.
 */

const SUPABASE_URL = "https://ref.supabase.co";
const RESOURCE = "https://agent-fit-trace.vercel.app/api/mcp";
const ORIGIN = "https://agent-fit-trace.vercel.app";
const METADATA_URL = `${ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}`;
const CLIENT_ID = "client-allowed-uuid";
const SKILL_TEXT = "# Training Coach\n\nDeterministic evidence only.";

function config(over: Partial<McpAuthConfig> = {}): McpAuthConfig {
  return {
    supabaseUrl: SUPABASE_URL,
    publishableKey: "sb_publishable_test_key",
    issuer: `${SUPABASE_URL}/auth/v1`,
    resource: RESOURCE,
    allowedClientIds: [CLIENT_ID],
    ...over,
  };
}

function principal(id: string, token: string, over: Partial<McpAuthPrincipal> = {}): McpAuthPrincipal {
  return {
    principal: { id },
    clientId: CLIENT_ID,
    resource: RESOURCE,
    accessToken: token,
    ...over,
  };
}

/** A verifier driven by a token → principal map; unknown tokens are invalid. */
function fakeVerifier(
  map: Record<string, McpAuthPrincipal>,
  options: { delayMs?: number; failure?: Error } = {},
): McpTokenVerifier & { calls: string[] } {
  const calls: string[] = [];
  const verify = async (token: string): Promise<McpAuthPrincipal> => {
    calls.push(token);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (options.failure !== undefined) throw options.failure;
    const found = map[token];
    if (found === undefined) {
      throw new McpAuthError(MCP_AUTH_ERRORS.INVALID_TOKEN, "Invalid or expired bearer token.");
    }
    return found;
  };
  return Object.assign(verify, { calls });
}

/** A store factory that records every principal/token pair it was built with. */
type RecordingStoreFactory = ((principal: McpAuthPrincipal) => FitTraceStore) & {
  seen: Array<{ id: string; token: string }>;
};

/** One independent in-memory store per principal; identity is the record bucket. */
function storeForPrincipal(recordsByPrincipal: Record<string, WorkoutRecord[]>): RecordingStoreFactory {
  const seen: Array<{ id: string; token: string }> = [];
  const factory = (auth: McpAuthPrincipal): FitTraceStore => {
    seen.push({ id: auth.principal.id, token: auth.accessToken });
    const ownerRecords = recordsByPrincipal[auth.principal.id] ?? [];
    const query = async (filter: HistoryFilter = {}): Promise<QueryResult> => ({
      records: ownerRecords.filter((entry) => {
        if (filter.from !== undefined && entry.date < filter.from) return false;
        if (filter.to !== undefined && entry.date > filter.to) return false;
        return true;
      }),
      total: ownerRecords.length,
      offset: 0,
      limit: null,
    });
    return {
      all: async () => ownerRecords,
      import: async (entry) => {
        if (!ownerRecords.some((existing) => existing.id === entry.id)) ownerRecords.push(entry);
        return { duplicate: false, total: ownerRecords.length };
      },
      query,
    };
  };
  return Object.assign(factory, { seen });
}

function record(id: string, date: string, exercise = "squat"): WorkoutRecord {
  return validateWorkoutRecord({
    id,
    schema_version: 1,
    date,
    session_type: "strength",
    exercises: [{ name: exercise, sets: [{ weight: 100, reps: 5, rpe: 7 }] }],
  }).record;
}

interface HandlerHarness {
  handle: (request: Request) => Promise<Response>;
  verifier: McpTokenVerifier & { calls: string[] };
  store: RecordingStoreFactory;
}

function harness(over: Partial<McpHttpHandlerOptions> = {}): HandlerHarness {
  const verifier = fakeVerifier({
    "token-a": principal("user-a", "token-a"),
    "token-b": principal("user-b", "token-b"),
  });
  const store = storeForPrincipal({
    "user-a": [record("a-1", "2026-09-01", "squat")],
    "user-b": [record("b-1", "2026-09-02", "bench_press"), record("b-2", "2026-09-03", "deadlift")],
  });
  const handle = createMcpHttpHandler({
    config: config(),
    verifier,
    storeFor: store,
    skillText: SKILL_TEXT,
    ...over,
  });
  return { handle, verifier, store };
}

/** JSON-RPC POST as a real MCP client would send it. */
function rpc(
  body: unknown,
  options: { token?: string | null; method?: string; url?: string; raw?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...options.headers,
  };
  if (options.token !== null && options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const method = options.method ?? "POST";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = options.raw ?? JSON.stringify(body);
  }
  return new Request(options.url ?? RESOURCE, init);
}

function initializeRequest(): Request {
  return rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-remote-test", version: "1.0.0" },
    },
  }, { token: "token-a" });
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    assert.fail(`expected JSON, got: ${text.slice(0, 200)}`);
  }
}

function challengeOf(response: Response): string {
  const header = response.headers.get("www-authenticate");
  assert.ok(header !== null, "every rejection must carry WWW-Authenticate");
  return header;
}

function assertChallenge(response: Response, expectedError?: string): void {
  const header = challengeOf(response);
  assert.match(header, /^Bearer /);
  // RFC 9728: the client discovers the authorization server from this URL.
  assert.ok(
    header.includes(`resource_metadata="${METADATA_URL}"`),
    `challenge must point at Protected Resource Metadata: ${header}`,
  );
  if (expectedError !== undefined) {
    assert.ok(header.includes(`error="${expectedError}"`), `missing error=${expectedError}: ${header}`);
  }
}

/** Assert no credential material escaped into these headers or this body text. */
function assertNoLeakIn(
  headers: Headers,
  body: string,
  tokens: readonly string[],
  context = "",
): void {
  const serializedHeaders = [...headers.entries()].map(([key, value]) => `${key}: ${value}`).join("\n");
  for (const token of tokens) {
    assert.ok(
      !serializedHeaders.toLowerCase().includes(token.toLowerCase()),
      `token leaked into a header ${context}`,
    );
    assert.ok(!body.includes(token), `token leaked into the body ${context}`);
  }
}

/** Assert no credential material escaped into a not-yet-read response. */
async function assertNoTokenLeak(response: Response, tokens: readonly string[]): Promise<string> {
  const body = await response.clone().text();
  assertNoLeakIn(response.headers, body, tokens);
  return body;
}

// ---------------------------------------------------------------------------
// Authentication: every rejection is a challenge, never anonymous access.
// ---------------------------------------------------------------------------

test("missing bearer token → 401 invalid_token with the discovery challenge", async () => {
  const { handle, store } = harness();
  const response = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: null }));

  assert.equal(response.status, 401);
  assertChallenge(response, MCP_AUTH_ERRORS.INVALID_TOKEN);
  const body = await jsonBody(response);
  assert.deepEqual(body.error, {
    code: MCP_AUTH_ERRORS.INVALID_TOKEN,
    message: "A valid OAuth access token is required to use this MCP endpoint.",
  });
  // Anonymous access never reaches the data layer.
  assert.equal(store.seen.length, 0);
});

test("a non-Bearer Authorization header is rejected without calling the verifier", async () => {
  const { handle, verifier } = harness();
  const response = await handle(
    rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { authorization: "Basic abc" } }),
  );

  assert.equal(response.status, 401);
  assertChallenge(response, MCP_AUTH_ERRORS.INVALID_TOKEN);
  assert.equal(verifier.calls.length, 0);
});

test("invalid token → 401 invalid_token and no store is ever built", async () => {
  const { handle, store } = harness();
  const response = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "token-evil" }));

  assert.equal(response.status, 401);
  assertChallenge(response, MCP_AUTH_ERRORS.INVALID_TOKEN);
  const body = await jsonBody(response);
  assert.equal((body.error as { code: string }).code, MCP_AUTH_ERRORS.INVALID_TOKEN);
  assert.equal(store.seen.length, 0);
  assert.ok(!JSON.stringify(body).includes("token-evil"));
});

test("an Auth outage maps to 503 auth_unavailable, not a logout-forcing 401", async () => {
  const { handle } = harness({
    verifier: fakeVerifier(
      {},
      { failure: new McpAuthError(MCP_AUTH_ERRORS.AUTH_UNAVAILABLE, "Authentication service is unavailable.") },
    ),
  });
  const response = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "token-a" }));

  assert.equal(response.status, 503);
  assertChallenge(response, MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
  const body = await jsonBody(response);
  assert.equal((body.error as { code: string }).code, MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
});

test("an unexpected verifier throw fails closed as 503 without echoing the error", async () => {
  const secret = "secret-internal-detail";
  const { handle } = harness({
    verifier: fakeVerifier({}, { failure: new Error(`boom ${secret}`) }),
  });
  const response = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "token-a" }));

  assert.equal(response.status, 503);
  const text = await assertNoTokenLeak(response, ["token-a", secret]);
  assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
});

test("insufficient scope → 403 with error and scope in the challenge", async () => {
  const { handle, store } = harness({ requiredScopes: ["openid", "profile"] });
  const response = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "token-a" }));

  assert.equal(response.status, 403);
  const header = challengeOf(response);
  assertChallenge(response, MCP_AUTH_ERRORS.INSUFFICIENT_SCOPE);
  // The scopes named here are what a client upscopes with, so they must be present.
  assert.ok(header.includes('scope="openid profile"'), `missing scope parameter: ${header}`);
  const body = await jsonBody(response);
  assert.equal((body.error as { code: string }).code, MCP_AUTH_ERRORS.INSUFFICIENT_SCOPE);
  // The identity was verified but the request never reached the data layer.
  assert.equal(store.seen.length, 0);
});

// ---------------------------------------------------------------------------
// Fail-closed deployment configuration.
// ---------------------------------------------------------------------------

test("a null config answers 503 on the endpoint and on the metadata document", async () => {
  const { handle, verifier, store } = harness({ config: null });

  const endpoint = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "token-a" }));
  assert.equal(endpoint.status, 503);
  // No resource is configured, so there is no metadata URL to advertise. The
  // challenge still advertises the scheme and the error honestly.
  assert.equal(challengeOf(endpoint), 'Bearer error="auth_unavailable"');
  assert.equal((await jsonBody(endpoint)).error !== undefined, true);

  const metadata = await handle(new Request(METADATA_URL, { method: "GET" }));
  assert.equal(metadata.status, 503);
  assert.equal((await jsonBody(metadata)).error !== undefined, true);

  assert.equal(verifier.calls.length, 0);
  assert.equal(store.seen.length, 0);
});

test("a null verifier answers 503 without building a store", async () => {
  const { handle, store } = harness({ verifier: null });
  const response = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "token-a" }));

  assert.equal(response.status, 503);
  assertChallenge(response, MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
  assert.equal(store.seen.length, 0);
});

test("a null store factory answers 503 without authenticating", async () => {
  const { handle, verifier } = harness({ storeFor: null });
  const response = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "token-a" }));

  assert.equal(response.status, 503);
  assertChallenge(response, MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
  const body = await jsonBody(response);
  assert.equal((body.error as { code: string }).code, MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
  // A deployment that cannot build a store is an outage; it must not spend an
  // Auth round trip on a request it will refuse anyway.
  assert.equal(verifier.calls.length, 0);
});

test("a missing coach prompt answers 503 rather than serving an empty contract", async () => {
  for (const skillText of [null, "", "   "] as const) {
    const { handle, store } = harness({ skillText });
    const response = await handle(initializeRequest());
    assert.equal(response.status, 503, `skillText=${JSON.stringify(skillText)}`);
    assert.equal((await jsonBody(response)).error !== undefined, true);
    // Nothing was built for a request that cannot be served faithfully.
    assert.equal(store.seen.length, 0);
  }
});

test("a throwing skill loader answers 503 and is retried on the next request", async () => {
  let attempts = 0;
  const { handle } = harness({
    skillText: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient read failure");
      return SKILL_TEXT;
    },
  });

  const failed = await handle(initializeRequest());
  assert.equal(failed.status, 503);

  const recovered = await handle(initializeRequest());
  assert.equal(recovered.status, 200);
  assert.equal(attempts, 2);
});

// ---------------------------------------------------------------------------
// Protected Resource Metadata (RFC 9728).
// ---------------------------------------------------------------------------

test("serves Protected Resource Metadata at the well-known path", async () => {
  const { handle } = harness();
  const response = await handle(new Request(METADATA_URL, { method: "GET" }));

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    resource: RESOURCE,
    authorization_servers: [`${SUPABASE_URL}/auth/v1`],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_SUPPORTED_SCOPES],
  });
});

test("serves the same document when Vercel rewrites the path onto /api/mcp", async () => {
  const { handle, verifier } = harness();
  // The rewrite appends the marker and may hand the Function either the
  // destination path or the original one; both must work.
  for (const url of [
    `${RESOURCE}?${MCP_METADATA_QUERY_KEY}=1`,
    `${METADATA_URL}?${MCP_METADATA_QUERY_KEY}=1`,
    `${METADATA_URL}/`,
  ]) {
    const response = await handle(new Request(url, { method: "GET" }));
    assert.equal(response.status, 200, url);
    const body = (await response.json()) as { resource?: string };
    assert.equal(body.resource, RESOURCE, url);
  }
  // Discovery is unauthenticated by design: it is the document the challenge
  // points at, so requiring a token would deadlock the OAuth flow.
  assert.equal(verifier.calls.length, 0);
});

test("metadata rejects non-GET methods explicitly", async () => {
  const { handle } = harness();
  const response = await handle(new Request(METADATA_URL, { method: "POST", body: "{}" }));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

// ---------------------------------------------------------------------------
// Full MCP happy path over the real transport.
// ---------------------------------------------------------------------------

test("initialize → tools/list → tools/call → resources/list → prompts/get", async () => {
  const { handle, store } = harness();

  const init = await handle(initializeRequest());
  assert.equal(init.status, 200);
  // Stateless mode must never issue a session id: it would look like identity.
  assert.equal(init.headers.get("mcp-session-id"), null);
  const initBody = await jsonBody(init);
  const initResult = initBody.result as {
    protocolVersion: string;
    serverInfo: { name: string };
    capabilities: Record<string, unknown>;
  };
  assert.equal(initResult.serverInfo.name, "agent-fit-trace");
  assert.equal(typeof initResult.protocolVersion, "string");
  assert.ok("tools" in initResult.capabilities);

  const list = await handle(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token: "token-a" }));
  assert.equal(list.status, 200);
  const tools = (await jsonBody(list)).result as { tools: Array<{ name: string }> };
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "analyze_progress",
    "generate_next_plan",
    "get_training_history",
    "import_workout",
  ]);

  const call = await handle(
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "analyze_progress", arguments: {} } }, { token: "token-a" }),
  );
  assert.equal(call.status, 200);
  const callResult = (await jsonBody(call)).result as {
    content: Array<{ text: string }>;
    structuredContent: { metrics: { sessions: number } };
    isError?: boolean;
  };
  assert.ok(!callResult.isError);
  // The store handed to the MCP server is the caller's own: user-a's single squat.
  assert.equal(callResult.structuredContent.metrics.sessions, 1);
  assert.match(callResult.content[0]?.text ?? "", /Analyzed 1 session\(s\)/);

  const resources = await handle(rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" }, { token: "token-a" }));
  const resourcesResult = (await jsonBody(resources)).result as { resources: Array<{ uri: string }> };
  assert.deepEqual(resourcesResult.resources.map((entry) => entry.uri).sort(), [
    "fit-trace://analysis/summary",
    "fit-trace://workouts/recent",
  ]);

  const prompt = await handle(
    rpc({ jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name: "training-coach" } }, { token: "token-a" }),
  );
  const promptResult = (await jsonBody(prompt)).result as {
    messages: Array<{ content: { text: string } }>;
  };
  assert.equal(promptResult.messages[0]?.content.text, SKILL_TEXT);

  // Every one of those requests built its own store; a shared one would throw
  // on the reused stateless transport before reaching the data layer.
  assert.ok(store.seen.length >= 3);
  assert.ok(store.seen.every((entry) => entry.id === "user-a" && entry.token === "token-a"));
});

test("a tools/call storage failure returns isError without leaking internals", async () => {
  const failingStore: FitTraceStore = {
    all: async () => {
      throw new Error("upstream exploded");
    },
    import: async () => ({ duplicate: false, total: 0 }),
    query: async () => ({ records: [], total: 0, offset: 0, limit: 50 }),
  };
  const { handle } = harness({ storeFor: () => failingStore });

  const response = await handle(
    rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "analyze_progress", arguments: {} } }, { token: "token-a" }),
  );
  assert.equal(response.status, 200);
  const text = await assertNoTokenLeak(response, ["token-a"]);
  const result = (JSON.parse(text) as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
  // `tools.ts#errorResult` only knows `FitTraceError`, so an unexpected failure
  // becomes the fixed INTERNAL_ERROR text. Assert the shape, not the code.
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /^INTERNAL_ERROR: /);
  assert.ok(!/\bat .+:\d+:\d+/.test(result.content[0]?.text ?? ""), "stack frame leaked");
});

// ---------------------------------------------------------------------------
// Malformed input and non-POST methods: explicit answers, never a crash.
// ---------------------------------------------------------------------------

test("malformed JSON-RPC → 400-class response without crashing", async () => {
  const { handle, store } = harness();

  for (const raw of ["{not json", "null", '"a string"', "{}", "[{\"jsonrpc\":\"2.0\"}]"]) {
    const response = await handle(rpc(undefined, { token: "token-a", raw }));
    assert.equal(response.status, 400, `body ${raw}`);
    const body = await jsonBody(response);
    assert.equal((body.error as { code: number } | undefined)?.code ?? 0, -32700, `body ${raw}`);
  }

  // An empty batch carries no message at all: the SDK answers 202, not an error.
  const empty = await handle(rpc(undefined, { token: "token-a", raw: "[]" }));
  assert.equal(empty.status, 202);

  // The process survived; a well-formed request still works afterwards.
  const recovered = await handle(rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { token: "token-a" }));
  assert.equal(recovered.status, 200);
  assert.ok(store.seen.length >= 1);
});

test("invalid JSON-RPC shape → 400 rather than an unhandled rejection", async () => {
  const { handle } = harness();
  // Shape demands a method; the SDK reports the parse/validation failure.
  const response = await handle(rpc({ jsonrpc: "2.0", id: 1 }, { token: "token-a" }));
  assert.equal(response.status, 400);
  const body = await jsonBody(response);
  assert.equal((body.error as { code: number }).code, -32700);
});

test("an unsupported content type or Accept header is answered by the transport", async () => {
  const { handle } = harness();

  const wrongType = await handle(
    new Request(RESOURCE, {
      method: "POST",
      headers: { authorization: "Bearer token-a", accept: "application/json, text/event-stream", "content-type": "text/plain" },
      body: "{}",
    }),
  );
  assert.equal(wrongType.status, 415);

  const wrongAccept = await handle(
    new Request(RESOURCE, {
      method: "POST",
      headers: { authorization: "Bearer token-a", accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assert.equal(wrongAccept.status, 406);
});

test("GET and DELETE are answered explicitly (405) instead of opening a stream", async () => {
  const { handle } = harness();

  // A stateless endpoint cannot scope a server-initiated SSE stream to a
  // caller, and a 405 is what the SDK's own client treats as "no stream here".
  for (const method of ["GET", "DELETE"] as const) {
    const response = await handle(
      new Request(RESOURCE, {
        method,
        headers: { authorization: "Bearer token-a", accept: "text/event-stream" },
      }),
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST", method);
    const body = await jsonBody(response);
    assert.equal((body.error as { code: string }).code, "MCP_METHOD_NOT_ALLOWED");
  }

  // The method gate runs after authentication: a GET without a token is a 401.
  const unauthenticated = await handle(
    new Request(RESOURCE, { method: "GET", headers: { accept: "text/event-stream" } }),
  );
  assert.equal(unauthenticated.status, 401);
});

test("notifications are accepted with 202 and no body", async () => {
  const { handle } = harness();
  const response = await handle(
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { token: "token-a" }),
  );
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});

// ---------------------------------------------------------------------------
// Per-request identity isolation.
// ---------------------------------------------------------------------------

test("each request builds its own store from its own verified principal", async () => {
  const { handle, store } = harness();

  // Sequential requests: a reused stateless transport would throw instead.
  const first = await handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "token-a" }));
  const second = await handle(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token: "token-b" }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  assert.deepEqual(
    store.seen.map((entry) => entry.token),
    ["token-a", "token-b"],
  );
  assert.equal(new Set(store.seen).size, 2, "stores must be distinct instances");
});

test("concurrent requests with different tokens never share identity or records", async () => {
  // A verifier delay forces the two requests to interleave inside the handler,
  // which is where a module-level store or transport cache would bleed across.
  const verifier = fakeVerifier(
    {
      "token-a": principal("user-a", "token-a"),
      "token-b": principal("user-b", "token-b"),
    },
    { delayMs: 15 },
  );
  const store = storeForPrincipal({
    "user-a": [record("a-1", "2026-09-01", "squat")],
    "user-b": [record("b-1", "2026-09-02", "bench_press"), record("b-2", "2026-09-03", "deadlift")],
  });
  const handle = createMcpHttpHandler({
    config: config(),
    verifier,
    storeFor: store,
    skillText: SKILL_TEXT,
  });

  function historyRequest(token: string, id: number): Request {
    return rpc(
      { jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_training_history", arguments: {} } },
      { token },
    );
  }

  // Interleave the whole initialize + call sequence of two callers.
  const [a, b] = await Promise.all([
    (async () => {
      const init = await handle(initializeRequest());
      assert.equal(init.status, 200);
      const call = await handle(historyRequest("token-a", 2));
      // Read the body exactly once: both the identity assertions and the leak
      // check below need it, and a `Response` body can only be consumed once.
      const text = await call.text();
      return { init, call, text, body: JSON.parse(text) as Record<string, unknown> };
    })(),
    (async () => {
      const init = await handle(
        rpc(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "mcp-remote-test-b", version: "1.0.0" },
            },
          },
          { token: "token-b" },
        ),
      );
      assert.equal(init.status, 200);
      const call = await handle(historyRequest("token-b", 2));
      const text = await call.text();
      return { init, call, text, body: JSON.parse(text) as Record<string, unknown> };
    })(),
  ]);

  const aRecords = (a.body.result as { structuredContent: { records: Array<{ id: string }> } }).structuredContent.records;
  const bRecords = (b.body.result as { structuredContent: { records: Array<{ id: string }> } }).structuredContent.records;

  assert.deepEqual(aRecords.map((entry) => entry.id), ["a-1"]);
  assert.deepEqual(bRecords.map((entry) => entry.id), ["b-1", "b-2"]);

  // Each store was built with exactly the caller's own token, in that caller's
  // own request — the store factory is where an identity leak would show up.
  // Two requests per caller (initialize + tools/call) means two stores each, and
  // every one of them is bound to a single caller.
  assert.deepEqual(
    [...new Set(store.seen.map((entry) => `${entry.id}:${entry.token}`))].sort(),
    ["user-a:token-a", "user-b:token-b"],
  );
  assert.equal(store.seen.length, 4, "one store per MCP request, none shared");

  // Neither response may mention the other caller's token or records.
  for (const [label, self, other, otherRecords] of [
    ["a", a, "token-b", bRecords],
    ["b", b, "token-a", aRecords],
  ] as const) {
    assertNoLeakIn(self.call.headers, self.text, [other], `(caller ${label})`);
    for (const entry of otherRecords) {
      assert.ok(
        !self.text.includes(entry.id),
        `caller ${label} response leaked ${entry.id} from the other principal`,
      );
    }
    assert.equal(self.call.headers.get("mcp-session-id"), null);
  }
});

test("the verified principal's records are what analyze_progress sees, per caller", async () => {
  const verifier = fakeVerifier({
    "token-a": principal("user-a", "token-a"),
    "token-b": principal("user-b", "token-b"),
  });
  const store = storeForPrincipal({
    "user-a": [record("a-1", "2026-09-01", "squat")],
    "user-b": [record("b-1", "2026-09-02", "bench_press")],
  });
  const handle = createMcpHttpHandler({ config: config(), verifier, storeFor: store, skillText: SKILL_TEXT });

  async function sessions(token: string): Promise<number> {
    const response = await handle(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "analyze_progress", arguments: {} } }, { token }),
    );
    const body = await jsonBody(response);
    return (body.result as { structuredContent: { metrics: { sessions: number } } }).structuredContent.metrics.sessions;
  }

  assert.equal(await sessions("token-a"), 1);
  assert.equal(await sessions("token-b"), 1);
  // Sanity: the two stores really differ, so "1 and 1" is not a shared store.
  const aRecords = await store(principal("user-a", "token-a")).all();
  const bRecords = await store(principal("user-b", "token-b")).all();
  assert.notDeepEqual(aRecords.map((entry) => entry.id), bRecords.map((entry) => entry.id));
  assert.deepEqual(analyzeProgress(aRecords, {}).metrics.sessions, 1);
});

// ---------------------------------------------------------------------------
// Response hygiene.
// ---------------------------------------------------------------------------

test("no response leaks the bearer token or a session identity", async () => {
  const { handle } = harness();
  const token = "token-a";

  const responses = await Promise.all([
    handle(initializeRequest()),
    handle(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token })),
    handle(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_training_history", arguments: {} } }, { token })),
    handle(rpc({ jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "training-coach" } }, { token })),
    handle(new Request(METADATA_URL, { method: "GET" })),
  ]);

  for (const response of responses) {
    await assertNoTokenLeak(response, [token, CLIENT_ID]);
    assert.equal(response.headers.get("mcp-session-id"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});

test("a non-string authorization header value is ignored, not coerced", async () => {
  const { handle, verifier } = harness();
  const response = await handle(
    new Request(RESOURCE, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(verifier.calls.length, 0);
});

// ---------------------------------------------------------------------------
// The deployed Vercel adapter: routing precedence and fail-closed behavior.
// This proves the real `handleVercelApi` reaches the MCP handler; the MCP
// behavior above is proven through the handler directly.
// ---------------------------------------------------------------------------

const VERCEL_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  MCP_ENV_VARS.RESOURCE,
  MCP_ENV_VARS.CLIENT_IDS,
] as const;

function withMcpEnv(run: () => Promise<void>): () => Promise<void> {
  return async () => {
    const saved = Object.fromEntries(VERCEL_ENV_KEYS.map((key) => [key, process.env[key]]));
    try {
      process.env.SUPABASE_URL = SUPABASE_URL;
      process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_key";
      process.env[MCP_ENV_VARS.RESOURCE] = RESOURCE;
      process.env[MCP_ENV_VARS.CLIENT_IDS] = CLIENT_ID;
      await run();
    } finally {
      for (const key of VERCEL_ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

interface CapturedResponse {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

function fakeVercelRequest(over: Record<string, unknown> = {}): VercelRequestLike {
  const emitter = new EventEmitter();
  return {
    url: "/api/mcp",
    method: "GET",
    headers: {},
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    pause: () => undefined,
    ...over,
  } as unknown as VercelRequestLike;
}

function fakeVercelResponse(): { response: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status: number, headers: Record<string, unknown>): void {
      captured.status = status;
      captured.headers = headers;
    },
    end(body: string): void {
      captured.body = body;
    },
  } as unknown as ServerResponse;
  return { response, captured };
}

function bounded<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test(
  "vercel adapter serves the metadata path it is rewritten to",
  withMcpEnv(async () => {
    // The rewrite maps the well-known path onto the mcp Function with a marker;
    // Vercel may pass either the original path or the destination.
    for (const url of [
      `${PROTECTED_RESOURCE_METADATA_PATH}?${MCP_METADATA_QUERY_KEY}=1`,
      `${PROTECTED_RESOURCE_METADATA_PATH}`,
      `/api/mcp?${MCP_METADATA_QUERY_KEY}=1`,
    ]) {
      const request = fakeVercelRequest({ url, method: "GET" });
      const { response, captured } = fakeVercelResponse();
      await bounded(handleVercelApi(request, response), `metadata ${url}`);
      assert.equal(captured.status, 200, url);
      const body = JSON.parse(captured.body) as { resource?: string; authorization_servers?: string[] };
      assert.equal(body.resource, RESOURCE, url);
      assert.deepEqual(body.authorization_servers, [`${SUPABASE_URL}/auth/v1`]);
      assert.equal(captured.headers["cache-control"], "no-store");
    }
  }),
);

test(
  "vercel adapter answers an unauthenticated /api/mcp with the challenge, not the /api/v1 shape",
  withMcpEnv(async () => {
    const request = fakeVercelRequest({ url: "/api/mcp", method: "POST", body: "{}" });
    const { response, captured } = fakeVercelResponse();
    await bounded(handleVercelApi(request, response), "unauthenticated mcp post");

    assert.equal(captured.status, 401);
    const challenge = String(captured.headers["www-authenticate"] ?? "");
    assert.ok(challenge.includes(`resource_metadata="${METADATA_URL}"`), challenge);
    assert.ok(challenge.includes('error="invalid_token"'), challenge);
    // /api/v1 would have answered `{error:{code:"UNAUTHENTICATED"}}`.
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, MCP_AUTH_ERRORS.INVALID_TOKEN);
  }),
);

test(
  "vercel adapter fails closed when the MCP env is absent",
  async () => {
    const saved = Object.fromEntries(VERCEL_ENV_KEYS.map((key) => [key, process.env[key]]));
    try {
      for (const key of VERCEL_ENV_KEYS) delete process.env[key];
      const request = fakeVercelRequest({ url: "/api/mcp", method: "POST", body: "{}" });
      const { response, captured } = fakeVercelResponse();
      await bounded(handleVercelApi(request, response), "mcp without env");

      assert.equal(captured.status, 503);
      assert.ok(String(captured.headers["www-authenticate"] ?? "").startsWith("Bearer"));
      assert.equal((JSON.parse(captured.body) as { error: { code: string } }).error.code, MCP_AUTH_ERRORS.AUTH_UNAVAILABLE);
    } finally {
      for (const key of VERCEL_ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test(
  "vercel adapter leaves the /api/v1 routes untouched",
  withMcpEnv(async () => {
    // A /api/v1 route must still go through the authenticated handler: without a
    // bearer it answers the API contract's UNAUTHENTICATED, not an MCP challenge.
    const request = fakeVercelRequest({ url: "/api/v1/workouts", method: "GET" });
    const { response, captured } = fakeVercelResponse();
    await bounded(handleVercelApi(request, response), "v1 workouts");

    assert.equal(captured.status, 401);
    const body = JSON.parse(captured.body) as { error: { code: string } };
    assert.equal(body.error.code, "UNAUTHENTICATED");
  }),
);

// ---------------------------------------------------------------------------
// Deployment wiring guards (vercel.json / api/mcp.mjs).
// ---------------------------------------------------------------------------

test("vercel.json maps the metadata path onto the mcp Function before the SPA fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  const config = JSON.parse(raw) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
    functions?: Record<string, { includeFiles?: string }>;
  };
  const rewrites = config.rewrites ?? [];

  const metadataIndex = rewrites.findIndex(
    (entry) => entry.source === PROTECTED_RESOURCE_METADATA_PATH,
  );
  assert.ok(metadataIndex >= 0, "the metadata path needs a rewrite onto /api/mcp");
  const metadataRewrite = rewrites[metadataIndex]!;
  // Vercel creates no Function for a dot-directory, so the path must be
  // rewritten onto a real Function — and it must carry the marker the handler
  // uses to recognize the metadata document.
  assert.equal(
    metadataRewrite.destination,
    `/api/mcp?${MCP_METADATA_QUERY_KEY}=1`,
  );

  // Rewrites are evaluated in order and the first match wins: the SPA fallback
  // matches `/.well-known/...` too, so the metadata rewrite has to come first.
  const spaIndex = rewrites.findIndex(
    (entry) => typeof entry.destination === "string" && entry.destination === "/index.html",
  );
  assert.ok(spaIndex >= 0, "the SPA fallback rewrite is expected to exist");
  assert.ok(
    metadataIndex < spaIndex,
    "the metadata rewrite must precede the SPA fallback or the HTML shell would be served",
  );

  // The skill file must ship inside the Function bundle: the handler reads it at
  // request time and refuses (503) without it.
  const functions = config.functions ?? {};
  const includeFiles = functions["api/**/*.mjs"]?.includeFiles ?? "";
  assert.match(includeFiles, /\.pi\/skills/, "the Function bundle must include the coach skill file");
  assert.match(includeFiles, /build\/server/, "the Function bundle must include the built server");
});

test("api/mcp.mjs exports the shared adapter as the default handler", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../api/mcp.mjs", import.meta.url), "utf8");
  assert.match(source, /export \{ handleVercelApi as default \} from "\.\.\/\.\.\/build\/server\/vercel\.mjs";/);
});
