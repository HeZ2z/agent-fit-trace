import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  canonicalCloudDestination,
  CloudDestinationFileError,
  CloudDestinationSettingError,
  CloudDestinationStore,
  cloudDestinationFilePath,
  normalizeCloudDestinationInput,
  normalizeCloudIssuer,
  parseStoredCloudDestination,
} from "../packages/fit-trace-cli/src/cloudDestination.ts";
import { probeCloudDestinationIssuer } from "../packages/fit-trace-cli/src/cloudProxy.ts";

const ISSUER = "https://project.example.test";

async function makeDataDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-destination-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function storeOptions(dataDir: string, overrides: Partial<Parameters<typeof CloudDestinationStore.load>[0]> = {}) {
  return {
    dataDir,
    officialDestination: null,
    officialError: null,
    issuer: ISSUER,
    probe: async () => ISSUER,
    allowInsecureLoopback: true,
    ...overrides,
  };
}

test("user-entered destinations are canonicalised to an HTTPS /api/v1 base", () => {
  assert.equal(
    normalizeCloudDestinationInput("https://coach.example.test/api/v1").href,
    "https://coach.example.test/api/v1",
  );
  assert.equal(
    normalizeCloudDestinationInput("  https://coach.example.test:8443/api/v1/  ").href,
    "https://coach.example.test:8443/api/v1",
  );
  // Plain HTTP is refused even for a loopback host unless the test-only seam is on.
  assert.throws(
    () => normalizeCloudDestinationInput("http://127.0.0.1:5199/api/v1"),
    /must use HTTPS/,
  );
  assert.equal(
    normalizeCloudDestinationInput("http://127.0.0.1:5199/api/v1", { allowInsecureLoopback: true }).href,
    "http://127.0.0.1:5199/api/v1",
  );
  for (const invalid of [
    "",
    "coach.example.test/api/v1",
    "https://coach.example.test",
    "https://coach.example.test/api/v1/extra",
    "https://user:pass@coach.example.test/api/v1",
    "https://coach.example.test/api/v1?x=1",
    "https://coach.example.test/api/v1#fragment",
  ]) {
    assert.throws(() => normalizeCloudDestinationInput(invalid), CloudDestinationSettingError, invalid);
  }
});

test("issuer normalisation ignores a trailing slash but preserves the auth path", () => {
  assert.equal(normalizeCloudIssuer("https://project.example.test/"), "https://project.example.test");
  assert.equal(normalizeCloudIssuer("https://project.example.test"), "https://project.example.test");
  assert.equal(
    normalizeCloudIssuer("https://host.example.test/auth/v1/"),
    "https://host.example.test/auth/v1",
  );
  assert.equal(normalizeCloudIssuer("not a url"), null);
});

test("an unset store fails closed and reports an actionable unconfigured state", async (t) => {
  const dataDir = await makeDataDir(t);
  const store = await CloudDestinationStore.load(storeOptions(dataDir));
  const status = store.statusFor("user-1");
  assert.equal(status.source, "unset");
  assert.equal(status.destination, null);
  assert.equal(status.consent, "not-applicable");
  assert.equal(store.decisionFor("user-1").status, "unconfigured");
});

test("the official destination is used without per-user consent", async (t) => {
  const dataDir = await makeDataDir(t);
  const official = new URL("https://official.example.test/api/v1");
  const store = await CloudDestinationStore.load(storeOptions(dataDir, { officialDestination: official }));
  const status = store.statusFor("user-1");
  assert.equal(status.source, "official");
  assert.equal(status.destination, canonicalCloudDestination(official));
  assert.equal(status.host, "official.example.test");
  assert.equal(status.consent, "not-applicable");
  assert.equal(store.decisionFor("user-1").status, "ready");
});

test("a user destination overrides the official default and requires that principal's consent", async (t) => {
  const dataDir = await makeDataDir(t);
  const custom = new URL("https://custom.example.test/api/v1");
  const store = await CloudDestinationStore.load(
    storeOptions(dataDir, {
      officialDestination: new URL("https://official.example.test/api/v1"),
      probe: async () => ISSUER,
    }),
  );
  const status = await store.confirm(custom.href, "custom.example.test", "user-1");
  assert.equal(status.source, "user");
  assert.equal(status.consent, "confirmed");
  assert.equal(store.decisionFor("user-1").status, "ready");
  // Consent is per principal and bound to the exact issuer.
  assert.equal(store.statusFor("user-2").consent, "required");
  assert.equal(store.decisionFor("user-2").status, "unconfirmed");

  const raw = JSON.parse(await readFile(cloudDestinationFilePath(dataDir), "utf8")) as {
    destination: string;
    consents: Record<string, { destination: string; issuer: string }>;
  };
  assert.equal(raw.destination, custom.href);
  assert.equal(raw.consents["user-1"]?.issuer, ISSUER);
  const mode = (await stat(cloudDestinationFilePath(dataDir))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a destination change clears every prior consent; re-setting the same host keeps other consents", async (t) => {
  const dataDir = await makeDataDir(t);
  const first = new URL("https://first.example.test/api/v1");
  const second = new URL("https://second.example.test/api/v1");
  const store = await CloudDestinationStore.load(storeOptions(dataDir));
  await store.confirm(first.href, "first.example.test", "user-1");
  await store.confirm(first.href, "first.example.test", "user-2");
  assert.equal(store.statusFor("user-2").consent, "confirmed");

  await store.confirm(second.href, "second.example.test", "user-1");
  assert.equal(store.statusFor("user-1").consent, "confirmed");
  assert.equal(store.statusFor("user-2").consent, "required");
});

test("changing the issuer invalidates stored consent without losing the destination", async (t) => {
  const dataDir = await makeDataDir(t);
  const custom = new URL("https://custom.example.test/api/v1");
  const store = await CloudDestinationStore.load(storeOptions(dataDir));
  await store.confirm(custom.href, "custom.example.test", "user-1");

  const otherIssuer = await CloudDestinationStore.load(
    storeOptions(dataDir, { issuer: "https://other-project.example.test" }),
  );
  assert.equal(otherIssuer.statusFor("user-1").source, "user");
  assert.equal(otherIssuer.statusFor("user-1").consent, "required");
});

test("the confirmation must name the exact canonical host", async (t) => {
  const dataDir = await makeDataDir(t);
  const store = await CloudDestinationStore.load(storeOptions(dataDir));
  await assert.rejects(
    () => store.confirm("https://custom.example.test/api/v1", "custom.example.test:8443", "user-1"),
    /Confirm the exact host custom\.example\.test/,
  );
  const status = await store.confirm("https://custom.example.test/api/v1", "custom.example.test", "user-1");
  assert.equal(status.consent, "confirmed");
});

test("an incompatible or unverifiable issuer is refused and nothing is written", async (t) => {
  const dataDir = await makeDataDir(t);
  const custom = new URL("https://custom.example.test/api/v1");

  const incompatible = await CloudDestinationStore.load(
    storeOptions(dataDir, { probe: async () => "https://other-project.example.test" }),
  );
  const wrongIssuer = await incompatible.check(custom.href);
  assert.equal(wrongIssuer.ok, false);
  assert.equal(wrongIssuer.error?.code, "CLOUD_DESTINATION_ISSUER_INCOMPATIBLE");
  await assert.rejects(
    () => incompatible.confirm(custom.href, "custom.example.test", "user-1"),
    (error: unknown) =>
      error instanceof CloudDestinationSettingError &&
      error.code === "CLOUD_DESTINATION_ISSUER_INCOMPATIBLE",
  );

  const noIssuer = await CloudDestinationStore.load(
    storeOptions(dataDir, { probe: async () => null }),
  );
  assert.equal((await noIssuer.check(custom.href)).error?.code, "CLOUD_DESTINATION_ISSUER_UNVERIFIED");

  const unreachable = await CloudDestinationStore.load(
    storeOptions(dataDir, {
      probe: async () => {
        throw new Error("dns failure");
      },
    }),
  );
  assert.equal((await unreachable.check(custom.href)).error?.code, "CLOUD_DESTINATION_UNREACHABLE");
  await assert.rejects(() => readFile(cloudDestinationFilePath(dataDir)), /ENOENT/);
});

test("setting the official URL again resets the user setting", async (t) => {
  const dataDir = await makeDataDir(t);
  const official = new URL("https://official.example.test/api/v1");
  const store = await CloudDestinationStore.load(
    storeOptions(dataDir, {
      officialDestination: official,
      probe: async () => ISSUER,
    }),
  );
  await store.confirm("https://custom.example.test/api/v1", "custom.example.test", "user-1");
  assert.equal((await readFile(cloudDestinationFilePath(dataDir), "utf8")).length > 0, true);

  const status = await store.confirm(official.href, "official.example.test", "user-1");
  assert.equal(status.source, "official");
  await assert.rejects(() => readFile(cloudDestinationFilePath(dataDir)), /ENOENT/);
});

test("reset removes the file and falls back to official, then unset", async (t) => {
  const dataDir = await makeDataDir(t);
  const official = new URL("https://official.example.test/api/v1");
  const store = await CloudDestinationStore.load(
    storeOptions(dataDir, {
      officialDestination: official,
      probe: async () => ISSUER,
    }),
  );
  await store.confirm("https://custom.example.test/api/v1", "custom.example.test", "user-1");
  const reset = await store.reset();
  assert.equal(reset.source, "official");
  assert.equal(store.decisionFor("user-1").status, "ready");
  await assert.rejects(() => readFile(cloudDestinationFilePath(dataDir)), /ENOENT/);

  const noOfficialDir = await makeDataDir(t);
  const noOfficial = await CloudDestinationStore.load(storeOptions(noOfficialDir));
  assert.equal((await noOfficial.reset()).source, "unset");
});

test("a malformed stored file fails closed instead of falling back to the official default", async (t) => {
  const dataDir = await makeDataDir(t);
  const path = cloudDestinationFilePath(dataDir);
  await writeFile(path, "{ not json", "utf8");
  const store = await CloudDestinationStore.load(
    storeOptions(dataDir, { officialDestination: new URL("https://official.example.test/api/v1") }),
  );
  const status = store.statusFor("user-1");
  assert.equal(status.source, "invalid");
  assert.equal(status.error?.code, "CLOUD_DESTINATION_INVALID");
  const decision = store.decisionFor("user-1");
  assert.equal(decision.status, "invalid");
  // The official destination is still visible so the UI can offer a reset.
  assert.equal(status.officialDestination, "https://official.example.test/api/v1");
});

test("stored files are strict about schema, canonical form and consent binding", () => {
  const canonical = canonicalCloudDestination(new URL("https://custom.example.test/api/v1"));
  const base = {
    schema_version: 1,
    destination: canonical,
    consents: {
      "user-1": { destination: canonical, issuer: ISSUER, approvedAt: "2026-01-01T00:00:00.000Z" },
    },
  };
  assert.equal(parseStoredCloudDestination(JSON.stringify(base)).destination, canonical);
  assert.throws(
    () => parseStoredCloudDestination(JSON.stringify({ ...base, schema_version: 2 })),
    CloudDestinationFileError,
  );
  assert.throws(
    () => parseStoredCloudDestination(JSON.stringify({ ...base, destination: `${canonical}/` })),
    CloudDestinationFileError,
  );
  assert.throws(
    () =>
      parseStoredCloudDestination(
        JSON.stringify({
          ...base,
          consents: {
            "user-1": { destination: "https://other.example.test/api/v1", issuer: ISSUER, approvedAt: "x" },
          },
        }),
      ),
    /not bound to the stored destination/,
  );
});

test("the probe reads the public-config issuer through a pinned connection", async (t) => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? "");
    if (request.url === "/api/v1/public-config") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { supabaseUrl: ISSUER, supabasePublishableKey: "pub" } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await listen(server);
  t.after(() => close(server));

  const issuer = await probeCloudDestinationIssuer(new URL(`http://127.0.0.1:${port}/api/v1`), {
    allowInsecureLoopback: true,
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  assert.equal(issuer, ISSUER);
  assert.deepEqual(seen, ["/api/v1/public-config"]);
});

test("the probe refuses redirects, non-JSON responses, oversized bodies and private answers", async (t) => {
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: "https://elsewhere.example.test/" });
    response.end();
  });
  const redirectPort = await listen(redirect);
  t.after(() => close(redirect));

  await assert.rejects(
    () =>
      probeCloudDestinationIssuer(new URL(`http://127.0.0.1:${redirectPort}/api/v1`), {
        allowInsecureLoopback: true,
      }),
    /redirected/,
  );

  const notJson = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>not json</html>");
  });
  const notJsonPort = await listen(notJson);
  t.after(() => close(notJson));
  await assert.rejects(
    () =>
      probeCloudDestinationIssuer(new URL(`http://127.0.0.1:${notJsonPort}/api/v1`), {
        allowInsecureLoopback: true,
      }),
    /valid JSON/,
  );

  const large = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { supabaseUrl: ISSUER, padding: "x".repeat(4096) } }));
  });
  const largePort = await listen(large);
  t.after(() => close(large));
  await assert.rejects(
    () =>
      probeCloudDestinationIssuer(new URL(`http://127.0.0.1:${largePort}/api/v1`), {
        allowInsecureLoopback: true,
        maxBytes: 128,
      }),
    /too large/,
  );

  await assert.rejects(
    () =>
      probeCloudDestinationIssuer(new URL("http://coach.example.test/api/v1"), {
        allowInsecureLoopback: true,
        resolveHost: async () => [{ address: "10.0.0.1", family: 4 }],
      }),
    /disallowed network address/,
  );
});
