import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import type { ServerResponse } from "node:http";
import { handleVercelApi } from "../server/vercel.ts";
import type { VercelRequestLike } from "../server/vercel.ts";

const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"] as const;

function saveEnv(): Record<string, string | undefined> {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setEnv(url: string, key: string): void {
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_PUBLISHABLE_KEY = key;
  delete process.env.SUPABASE_ANON_KEY;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

function fakeRequest(over: Record<string, unknown> = {}): VercelRequestLike {
  const emitter = new EventEmitter();
  return {
    url: "/api/v1/public-config",
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

function fakeResponse(): { response: ServerResponse; captured: CapturedResponse } {
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

/** Fail the test instead of hanging when the adapter never responds. */
function bounded<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function serviceRoleJwt(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode({ role: "service_role" })}.sig`;
}

/**
 * Vercel only routes a request into `handleVercelApi` when a matching
 * `api/v1` Function file exists (the SPA rewrite excludes `/api/`). Every
 * authenticated path the HTTP client can call must therefore have a wrapper,
 * including dynamic `[id]`/`[kind]` segments and the nested cloud catch-all.
 */
const DEPLOYED_FUNCTION_WRAPPERS = {
  "workouts.mjs": "../../build/server/vercel.mjs",
  "analysis.mjs": "../../build/server/vercel.mjs",
  "public-config.mjs": "../../build/server/vercel.mjs",
  "plans/drafts.mjs": "../../../build/server/vercel.mjs",
  "imports.mjs": "../../build/server/vercel.mjs",
  "imports/[id].mjs": "../../../build/server/vercel.mjs",
  "import-selections/[kind].mjs": "../../../build/server/vercel.mjs",
  "plan-adoption.mjs": "../../build/server/vercel.mjs",
  "coaching/cloud/[...path].mjs": "../../../../build/server/vercel.mjs",
} as const;

test("vercel adapter: every client route has a deployed Function wrapper", async () => {
  for (const [wrapper, target] of Object.entries(DEPLOYED_FUNCTION_WRAPPERS)) {
    const source = await readFile(new URL(`../api/v1/${wrapper}`, import.meta.url), "utf8");
    assert.ok(
      source.includes(`export { handleVercelApi as default } from "${target}";`),
      `missing shared adapter export in api/v1/${wrapper}`,
    );
  }
});

test("vercel adapter: pre-parsed null body on POST does not hang (fail-closed without env)", async () => {
  const saved = saveEnv();
  try {
    clearEnv();
    const request = fakeRequest({
      url: "/api/v1/workouts",
      method: "POST",
      body: null,
      headers: { authorization: "Bearer token" },
    });
    const { response, captured } = fakeResponse();
    await bounded(handleVercelApi(request, response), "null-body POST");
    assert.equal(captured.status, 500);
    assert.equal((JSON.parse(captured.body) as { error: { code: string } }).error.code, "API_ERROR");
  } finally {
    restoreEnv(saved);
  }
});

test("vercel adapter: oversized UTF-8 bodies reject by byte count, exact-limit ASCII passes", async () => {
  const saved = saveEnv();
  try {
    clearEnv();
    // 40_000 chars × 2 bytes = 80_000 bytes > 64 KiB limit (`.length` alone would miss it).
    const utf8 = fakeRequest({ url: "/api/v1/workouts", method: "POST", body: "é".repeat(40_000) });
    const first = fakeResponse();
    await bounded(handleVercelApi(utf8, first.response), "oversized UTF-8 body");
    assert.equal(first.captured.status, 400);
    assert.equal(
      (JSON.parse(first.captured.body) as { error: { code: string } }).error.code,
      "VALIDATION_ERROR",
    );

    // Exactly 64 KiB of ASCII is within the limit: readBody accepts it and the
    // request proceeds to the fail-closed handler (500 without env), not a 400.
    const exact = fakeRequest({ url: "/api/v1/workouts", method: "POST", body: "a".repeat(64 * 1024) });
    const second = fakeResponse();
    await bounded(handleVercelApi(exact, second.response), "exact-limit body");
    assert.equal(second.captured.status, 500);
  } finally {
    restoreEnv(saved);
  }
});

test("vercel adapter: GET with an already-consumed stream returns promptly", async () => {
  const saved = saveEnv();
  try {
    setEnv("http://127.0.0.1:54321", "test-publishable-key");
    const request = fakeRequest({
      url: "/api/v1/public-config",
      method: "GET",
      readableEnded: true,
    });
    const { response, captured } = fakeResponse();
    await bounded(handleVercelApi(request, response), "GET with consumed stream");
    assert.equal(captured.status, 200);
    const body = JSON.parse(captured.body) as {
      data: { supabaseUrl: string; supabasePublishableKey: string };
    };
    assert.equal(body.data.supabaseUrl, "http://127.0.0.1:54321");
    assert.equal(body.data.supabasePublishableKey, "test-publishable-key");
  } finally {
    restoreEnv(saved);
  }
});

test("vercel adapter: missing env fails closed on auth routes and public-config", async () => {
  const saved = saveEnv();
  try {
    clearEnv();
    const authed = fakeRequest({
      url: "/api/v1/workouts",
      method: "GET",
      headers: { authorization: "Bearer token" },
    });
    const first = fakeResponse();
    await bounded(handleVercelApi(authed, first.response), "auth route without env");
    assert.equal(first.captured.status, 500);
    assert.equal(
      (JSON.parse(first.captured.body) as { error: { code: string } }).error.code,
      "API_ERROR",
    );

    const config = fakeRequest({ url: "/api/v1/public-config", method: "GET" });
    const second = fakeResponse();
    await bounded(handleVercelApi(config, second.response), "public-config without env");
    assert.equal(second.captured.status, 500);
  } finally {
    restoreEnv(saved);
  }
});

test("vercel adapter: secret-looking keys are never served (fail closed)", async () => {
  const saved = saveEnv();
  try {
    for (const secret of [`sb_secret_abc123`, serviceRoleJwt()]) {
      setEnv("http://127.0.0.1:54321", secret);
      const request = fakeRequest({
        url: "/api/v1/workouts",
        method: "GET",
        headers: { authorization: "Bearer token" },
      });
      const { response, captured } = fakeResponse();
      await bounded(handleVercelApi(request, response), "secret env key");
      assert.equal(captured.status, 500);
      assert.ok(!captured.body.includes(secret.slice(0, 16)));

      const config = fakeRequest({ url: "/api/v1/public-config", method: "GET" });
      const second = fakeResponse();
      await bounded(handleVercelApi(config, second.response), "secret public-config");
      assert.equal(second.captured.status, 500);
    }
  } finally {
    restoreEnv(saved);
  }
});

test("vercel adapter: aborted request streams resolve instead of hanging", async () => {
  const saved = saveEnv();
  try {
    clearEnv();
    const request = fakeRequest({ url: "/api/v1/workouts", method: "POST" });
    const { response, captured } = fakeResponse();
    const pending = bounded(handleVercelApi(request, response), "aborted stream");
    // Simulate the platform aborting the upload mid-flight.
    (request as unknown as EventEmitter).emit("error", new Error("aborted"));
    await pending;
    assert.equal(captured.status, 400);
    assert.equal(
      (JSON.parse(captured.body) as { error: { code: string } }).error.code,
      "VALIDATION_ERROR",
    );
  } finally {
    restoreEnv(saved);
  }
});
