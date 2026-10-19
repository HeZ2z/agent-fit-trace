import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CLOUD_AGENT,
  readCloudAgentKind,
  readCloudWorkerEnv,
} from "../server/cloud/config.ts";
import { createCloudWorkerProvider } from "../server/cloud/workerEntrypoint.ts";

const BASE_ENV: Record<string, string | undefined> = {
  FIT_TRACE_CLOUD_ENABLED: "1",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  FIT_TRACE_OPENROUTER_API_KEY: "test-openrouter-key",
  FIT_TRACE_OPENROUTER_MODEL: "test/model",
};

test("cloud agent selection: default is the builtin loop", () => {
  assert.equal(DEFAULT_CLOUD_AGENT, "builtin");
  assert.equal(readCloudAgentKind({}), "builtin");
  assert.equal(readCloudAgentKind({ FIT_TRACE_CLOUD_AGENT: "" }), "builtin");
  assert.equal(readCloudAgentKind({ FIT_TRACE_CLOUD_AGENT: "   " }), "builtin");
  assert.equal(readCloudWorkerEnv(BASE_ENV)?.agent, "builtin");
});

test("cloud agent selection: both known runtimes are accepted", () => {
  assert.equal(readCloudAgentKind({ FIT_TRACE_CLOUD_AGENT: "builtin" }), "builtin");
  assert.equal(readCloudAgentKind({ FIT_TRACE_CLOUD_AGENT: " pi-agent-core " }), "pi-agent-core");
  assert.equal(
    readCloudWorkerEnv({ ...BASE_ENV, FIT_TRACE_CLOUD_AGENT: "pi-agent-core" })?.agent,
    "pi-agent-core",
  );
});

test("cloud agent selection: an unknown runtime fails the worker closed", () => {
  assert.equal(readCloudAgentKind({ FIT_TRACE_CLOUD_AGENT: "pi-coding-agent" }), null);
  assert.equal(readCloudAgentKind({ FIT_TRACE_CLOUD_AGENT: "PI-AGENT-CORE" }), null);
  assert.equal(
    readCloudWorkerEnv({ ...BASE_ENV, FIT_TRACE_CLOUD_AGENT: "unsupported" }),
    null,
    "a typo must not silently fall back to a paid runtime",
  );
});

test("cloud agent selection: the worker constructs the configured provider", () => {
  const fetchImpl = (async () => new Response("{}")) as typeof fetch;
  const builtin = readCloudWorkerEnv(BASE_ENV);
  assert.ok(builtin !== null);
  assert.equal(typeof createCloudWorkerProvider(builtin, { fetchImpl }).run, "function");

  const pi = readCloudWorkerEnv({ ...BASE_ENV, FIT_TRACE_CLOUD_AGENT: "pi-agent-core" });
  assert.ok(pi !== null);
  assert.equal(pi.agent, "pi-agent-core");
  assert.equal(typeof createCloudWorkerProvider(pi, { fetchImpl }).run, "function");
});
