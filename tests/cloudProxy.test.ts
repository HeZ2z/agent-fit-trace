import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { AuthPrincipal } from "@agent-fit-trace/api-contracts";
import { createTestVerifier } from "../server/auth/testVerifier.ts";
import {
  createCloudProxyHandler,
  isAllowedCloudPath,
  isPublicAddress,
  parseCloudApiBase,
  resolveApprovedAddress,
} from "../packages/fit-trace-cli/src/cloudProxy.ts";

const TOKENS: Record<string, AuthPrincipal> = {
  "token-formal": { id: "user-1", email: "formal@example.com", isAnonymous: false },
  "token-guest": { id: "guest-1", email: "guest@example.com", isAnonymous: true },
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

type UpstreamHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => void;

async function startUpstream(handler: UpstreamHandler): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    handler(request, response, new URL(request.url ?? "/", "http://127.0.0.1"));
  });
  const port = await listen(server);
  return { server, port };
}

async function startProxy(
  upstreamPort: number,
  options: { verifier?: ReturnType<typeof createTestVerifier>; maxSseBytes?: number } = {},
): Promise<{ server: Server; url: string }> {
  const proxy = createCloudProxyHandler({
    apiBaseUrl: new URL(`http://127.0.0.1:${upstreamPort}/api/v1`),
    verifier: options.verifier ?? createTestVerifier(TOKENS),
    allowInsecureLoopback: true,
    ...(options.maxSseBytes === undefined ? {} : { maxSseBytes: options.maxSseBytes }),
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void proxy(request, response, {
      method: (request.method ?? "GET").toUpperCase(),
      pathname: url.pathname,
      search: url.search,
    });
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

test("cloud destination parsing accepts only the canonical HTTPS API base", () => {
  assert.equal(parseCloudApiBase("https://fit.example.test/api/v1")?.href, "https://fit.example.test/api/v1");
  assert.equal(parseCloudApiBase("http://fit.example.test/api/v1"), null);
  assert.equal(parseCloudApiBase("https://fit.example.test/api/v1/"), null);
  assert.equal(parseCloudApiBase("https://fit.example.test/api/v2"), null);
  assert.equal(parseCloudApiBase("https://user:pass@fit.example.test/api/v1"), null);
  assert.equal(parseCloudApiBase("https://fit.example.test/api/v1?x=1"), null);
  assert.equal(parseCloudApiBase("https://fit.example.test/api/v1#x"), null);
});

test("cloud route allowlist exposes only the documented public paths", () => {
  for (const path of [
    "/api/v1/coaching/cloud/capabilities",
    "/api/v1/coaching/cloud/sessions",
    "/api/v1/coaching/cloud/sessions/abc_1",
    "/api/v1/coaching/cloud/snapshots",
    "/api/v1/coaching/cloud/runs",
    "/api/v1/coaching/cloud/runs/r1",
    "/api/v1/coaching/cloud/runs/r1/events",
    "/api/v1/coaching/cloud/runs/r1/cancel",
    "/api/v1/coaching/cloud/conversations",
    "/api/v1/coaching/cloud/conversations/c1",
  ]) assert.equal(isAllowedCloudPath(path), true, path);
  for (const path of [
    "/api/v1/coaching/cloud",
    "/api/v1/coaching/local/runs",
    "/api/v1/coaching/cloud/runs/r1/../../workouts",
    "/api/v1/coaching/cloud/runs/r1/events/extra",
  ]) assert.equal(isAllowedCloudPath(path), false, path);
});

test("cloud SSRF guard rejects loopback, private, link-local and metadata targets", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("cloud destination resolution fails closed when any answer is private", async () => {
  const destination = new URL("https://cloud.example.test/api/v1");
  await assert.rejects(
    resolveApprovedAddress(destination, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.2", family: 4 },
    ]),
    /disallowed network address/,
  );
  const pinned = await resolveApprovedAddress(destination, async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
});

test("proxy forwards the caller bearer, path, query and JSON body, and strips Host", async () => {
  let seen: { url?: string; authorization?: string; host?: string; body?: string } = {};
  const upstream = await startUpstream((request, response, url) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      seen = {
        url: `${url.pathname}${url.search}`,
        authorization: request.headers.authorization,
        host: request.headers.host,
        body,
      };
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { ok: true } }));
    });
  });
  const proxy = await startProxy(upstream.port);
  try {
    const response = await fetch(`${proxy.url}/api/v1/coaching/cloud/runs?fromSeq=2`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-formal",
        "content-type": "application/json",
        accept: "application/json",
        origin: "http://127.0.0.1:5199",
      },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(await response.json(), { data: { ok: true } });
    assert.equal(seen.url, "/api/v1/coaching/cloud/runs?fromSeq=2");
    assert.equal(seen.authorization, "Bearer token-formal");
    assert.equal(seen.host, `127.0.0.1:${upstream.port}`);
    assert.equal(seen.body, JSON.stringify({ sessionId: "s1" }));
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxy forwards a snapshot date filter, never local workout records", async () => {
  let upstreamBody = "";
  const upstream = await startUpstream((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      upstreamBody = body;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: {
          snapshotId: "hosted-snapshot",
          source: "cloud",
          accountId: "user-1",
          recordIds: ["2026-09-02-hosted-sentinel"],
          recordCount: 1,
        },
      }));
    });
  });
  const proxy = await startProxy(upstream.port);
  try {
    const response = await fetch(`${proxy.url}/api/v1/coaching/cloud/snapshots`, {
      method: "POST",
      headers: { authorization: "Bearer token-formal", "content-type": "application/json" },
      body: JSON.stringify({ from: "2026-09-01", to: "2026-09-30" }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(JSON.parse(upstreamBody), { from: "2026-09-01", to: "2026-09-30" });
    assert.ok(!upstreamBody.includes("local-sentinel"), "local records must never be uploaded by the proxy");
    const body = (await response.json()) as { data: { recordIds: string[] } };
    assert.deepEqual(body.data.recordIds, ["2026-09-02-hosted-sentinel"]);
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxy refuses the local guest bearer and guest-classified accounts", async () => {
  let upstreamCalls = 0;
  const upstream = await startUpstream((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const proxy = await startProxy(upstream.port);
  try {
    const local = await fetch(`${proxy.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: "Bearer fit-trace-local-daemon" },
    });
    assert.equal(local.status, 403);
    const guest = await fetch(`${proxy.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: "Bearer token-guest" },
    });
    assert.equal(guest.status, 403);
    const missing = await fetch(`${proxy.url}/api/v1/coaching/cloud/capabilities`);
    assert.equal(missing.status, 401);
    assert.equal(upstreamCalls, 0, "the bearer must never reach upstream before account verification");
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxy never follows an upstream redirect", async () => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(302, { location: "https://elsewhere.example.test/api/v1/coaching/cloud/capabilities" });
    response.end();
  });
  const proxy = await startProxy(upstream.port);
  try {
    const response = await fetch(`${proxy.url}/api/v1/coaching/cloud/capabilities`, {
      headers: { authorization: "Bearer token-formal" },
    });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /redirected/);
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxy streams SSE frames as they arrive, before the terminal frame", async () => {
  let releaseTerminal: (() => void) | null = null;
  const terminalGate = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    });
    response.write('id: 1\ndata: {"seq":1,"event":{"type":"text_delta","delta":"first"}}\n\n');
    void terminalGate.then(() => {
      response.write('id: 2\ndata: {"seq":2,"event":{"type":"terminal","status":"completed"}}\n\n');
      response.end();
    });
  });
  const proxy = await startProxy(upstream.port);
  try {
    const response = await fetch(`${proxy.url}/api/v1/coaching/cloud/runs/r1/events`, {
      headers: { authorization: "Bearer token-formal", accept: "text/event-stream" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    assert.equal(first.done, false);
    const firstText = decoder.decode(first.value, { stream: true });
    assert.match(firstText, /"type":"text_delta"/);
    assert.ok(!firstText.includes('"type":"terminal"'), "terminal must not be buffered into the first frame");

    releaseTerminal!();
    let rest = "";
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      rest += decoder.decode(read.value, { stream: true });
    }
    assert.match(rest, /"type":"terminal"/);
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxy aborts the upstream request when the client disconnects", async () => {
  let upstreamClosed = false;
  const upstream = await startUpstream((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write("id: 1\ndata: {}\n\n");
    request.on("close", () => {
      upstreamClosed = true;
    });
    response.on("close", () => {
      upstreamClosed = true;
    });
  });
  const proxy = await startProxy(upstream.port);
  try {
    const controller = new AbortController();
    const response = await fetch(`${proxy.url}/api/v1/coaching/cloud/runs/r1/events`, {
      headers: { authorization: "Bearer token-formal", accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    for (let index = 0; index < 100 && !upstreamClosed; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamClosed, true, "the upstream socket must be destroyed on client disconnect");
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxy backpressures a slow reader instead of draining the upstream", async () => {
  let finished = false;
  let sawBackpressure = false;
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    let sent = 0;
    const chunk = `data: ${"x".repeat(64 * 1024)}\n\n`;
    const pump = (): void => {
      while (sent < 64) {
        sent += 1;
        if (!response.write(chunk)) {
          sawBackpressure = true;
          response.once("drain", pump);
          return;
        }
      }
      finished = true;
      response.end();
    };
    pump();
  });
  const proxy = await startProxy(upstream.port, { maxSseBytes: 16 * 1024 * 1024 });
  try {
    const response = await fetch(`${proxy.url}/api/v1/coaching/cloud/runs/r1/events`, {
      headers: { authorization: "Bearer token-formal", accept: "text/event-stream" },
    });
    assert.ok(response.body, "expected a streaming body");
    // Do not read yet: the proxy must stop pulling from upstream once the
    // client-side response buffer is full, so upstream cannot finish.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    assert.equal(finished, false, "upstream was drained while the client was not reading");
    const reader = response.body.getReader();
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
    }
    for (let index = 0; index < 100 && !finished; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(finished, true, "upstream never resumed after the client read");
    assert.equal(sawBackpressure, true, "the upstream response buffer never applied backpressure");
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxy caps a response instead of buffering it without bound", async () => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write("id: 1\ndata: first\n\n");
    response.write("x".repeat(4096));
  });
  const proxy = await startProxy(upstream.port, { maxSseBytes: 1024 });
  try {
    let bytes = 0;
    try {
      const response = await fetch(`${proxy.url}/api/v1/coaching/cloud/runs/r1/events`, {
        headers: { authorization: "Bearer token-formal", accept: "text/event-stream" },
      });
      if (response.body !== null) {
        const reader = response.body.getReader();
        for (;;) {
          const read = await reader.read();
          if (read.done) break;
          bytes += read.value.byteLength;
        }
      }
    } catch {
      // Exceeding the cap destroys the connection; a truncated read is the
      // observable outcome for the client.
    }
    assert.ok(bytes <= 1024, `received ${bytes} bytes above the configured cap`);
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});
