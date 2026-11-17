import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createProxyTunnel, formatConnectTarget } from "../packages/fit-trace-cli/src/cloudProxyTunnel.ts";
import {
  parseMacSystemProxy,
  resolveOutboundProxy,
  shouldBypassProxy,
} from "../packages/fit-trace-cli/src/systemProxy.ts";

test("explicit proxy env wins and parses a bare host:port", () => {
  const state = resolveOutboundProxy({
    env: { HTTPS_PROXY: "127.0.0.1:10808", NO_PROXY: "localhost, .example.test" },
    platform: "linux",
  });
  assert.equal(state.kind, "proxy");
  if (state.kind !== "proxy") return;
  assert.equal(state.proxy.protocol, "http:");
  assert.equal(state.proxy.host, "127.0.0.1");
  assert.equal(state.proxy.port, 10808);
  assert.deepEqual(state.proxy.bypass, ["localhost", ".example.test"]);
});

test("SOCKS and malformed proxy settings fail closed", () => {
  const socks = resolveOutboundProxy({ env: { HTTPS_PROXY: "socks5://127.0.0.1:1080" }, platform: "linux" });
  assert.equal(socks.kind, "unsupported");
  const malformed = resolveOutboundProxy({ env: { HTTPS_PROXY: "http://" }, platform: "linux" });
  assert.equal(malformed.kind, "unsupported");
  const badEscape = resolveOutboundProxy({
    env: { HTTPS_PROXY: "http://user%ZZ:pass@127.0.0.1:10808" },
    platform: "linux",
  });
  assert.equal(badEscape.kind, "unsupported");
});

test("macOS scutil output selects the HTTPS proxy and exposes its exceptions", () => {
  const state = parseMacSystemProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
  }
  HTTPEnable : 0
  HTTPPort : 0
  HTTPSEnable : 1
  HTTPSPort : 10808
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 10808
  SOCKSProxy : 127.0.0.1
}`);
  assert.equal(state.kind, "proxy");
  if (state.kind !== "proxy") return;
  assert.equal(state.proxy.host, "127.0.0.1");
  assert.equal(state.proxy.port, 10808);
  assert.deepEqual(state.proxy.bypass, ["127.0.0.1", "*.local"]);
});

test("macOS enabled but incomplete proxy settings fail closed", () => {
  const state = parseMacSystemProxy(`<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 1
  SOCKSEnable : 0
}`);
  assert.equal(state.kind, "unsupported");
});

test("macOS proxy exceptions are lower-cased for matching", () => {
  const state = parseMacSystemProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.Example.COM
  }
  HTTPSEnable : 1
  HTTPSPort : 10808
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`);
  assert.equal(state.kind, "proxy");
  if (state.kind !== "proxy") return;
  assert.deepEqual(state.proxy.bypass, ["*.example.com"]);
});

test("macOS automatic proxy settings are unsupported without a manual proxy", () => {
  const state = parseMacSystemProxy(`<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://example.test/proxy.pac
  SOCKSEnable : 0
}`);
  assert.equal(state.kind, "unsupported");
});

test("macOS SOCKS-only settings are unsupported instead of silently direct", () => {
  const state = parseMacSystemProxy(`<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 10808
  SOCKSProxy : 127.0.0.1
}`);
  assert.equal(state.kind, "unsupported");
});

test("proxy bypass matches exact hosts and suffixes, not unrelated suffixes", () => {
  assert.equal(shouldBypassProxy("localhost", ["localhost"]), true);
  assert.equal(shouldBypassProxy("api.example.test", ["example.test"]), true);
  assert.equal(shouldBypassProxy("api.example.test", [".example.test"]), true);
  assert.equal(shouldBypassProxy("notexample.test", ["example.test"]), false);
  assert.equal(shouldBypassProxy("127.0.0.1", ["127.0.0.1"]), true);
  assert.equal(shouldBypassProxy("::1", ["::1"]), true);
  assert.equal(shouldBypassProxy("agent-fit-trace.vercel.app", ["::1"]), false);
  assert.equal(shouldBypassProxy("printer.local", ["*.local"]), true);
  assert.equal(shouldBypassProxy("api.example.test", ["api.example.test:8080"], 443), false);
  assert.equal(shouldBypassProxy("api.example.test", ["api.example.test:8080"], 8080), true);
});

test("CONNECT authority brackets IPv6 and preserves the port", () => {
  assert.equal(formatConnectTarget("104.31.142.88", 443), "104.31.142.88:443");
  assert.equal(formatConnectTarget("2a03:2880::1", 443), "[2a03:2880::1]:443");
});

test("proxy tunnel CONNECTs to the pinned address and carries TLS to the origin", async () => {
  const fixture = join(import.meta.dirname, "fixtures");
  const [key, cert] = await Promise.all([
    readFile(join(fixture, "proxy-test-key.pem")),
    readFile(join(fixture, "proxy-test-cert.pem")),
  ]);
  const origin = createHttpsServer({ key, cert }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { ok: true } }));
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as AddressInfo).port;

  const seen: { url?: string; host?: string; authorization?: string } = {};
  const proxy = createHttpServer();
  proxy.on("connect", (request, clientSocket, head) => {
    seen.url = request.url;
    seen.host = request.headers.host as string | undefined;
    seen.authorization = request.headers["proxy-authorization"] as string | undefined;
    const target = request.url ?? "";
    const port = Number(target.slice(target.lastIndexOf(":") + 1));
    const upstream = createConnection({ host: "127.0.0.1", port }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;

  const target = new URL(`https://localhost:${originPort}/api/v1`);
  const tunnel = createProxyTunnel({
    proxy: {
      protocol: "http:",
      host: "127.0.0.1",
      port: proxyPort,
      authorization: "Basic dGVzdDp0ZXN0",
      bypass: [],
      source: "env",
    },
    target,
    pinned: { address: "127.0.0.1" },
    timeoutMs: 5_000,
    tls: { ca: cert },
  });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: "localhost",
          port: originPort,
          path: "/api/v1/coaching/cloud/capabilities",
          method: "GET",
          agent: tunnel.agent,
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => resolve(text));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.deepEqual(JSON.parse(body), { data: { ok: true } });
    assert.equal(seen.url, `127.0.0.1:${originPort}`);
    assert.equal(seen.host, `127.0.0.1:${originPort}`);
    assert.equal(seen.authorization, "Basic dGVzdDp0ZXN0");
  } finally {
    tunnel.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});
