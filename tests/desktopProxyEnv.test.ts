import assert from "node:assert/strict";
import { test } from "node:test";

import { applyProxyEnv, parseMacProxy } from "../packages/fit-trace-desktop/main/proxyEnv.cjs";

test("desktop proxy env marks explicit env so Node fetch can use it", () => {
  const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://127.0.0.1:10808" };
  assert.equal(applyProxyEnv(env, { platform: "linux" }), env);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:10808");
});

test("desktop proxy env normalizes a bare explicit proxy before Node parses it", () => {
  const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "127.0.0.1:10808" };
  applyProxyEnv(env, { platform: "linux" });
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.https_proxy, "http://127.0.0.1:10808");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("desktop proxy env normalizes a bare lowercase proxy", () => {
  const env: NodeJS.ProcessEnv = { https_proxy: "proxy.example.test:3128" };
  applyProxyEnv(env, { platform: "linux" });
  assert.equal(env.HTTPS_PROXY, "http://proxy.example.test:3128");
  assert.equal(env.https_proxy, "http://proxy.example.test:3128");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("desktop proxy env normalizes a bare HTTP_PROXY fallback", () => {
  const env: NodeJS.ProcessEnv = { HTTP_PROXY: "127.0.0.1:10808" };
  applyProxyEnv(env, { platform: "linux" });
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.https_proxy, "http://127.0.0.1:10808");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("desktop proxy env leaves an unsupported explicit proxy for the daemon to reject", () => {
  const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "socks5://127.0.0.1:1080" };
  applyProxyEnv(env, { platform: "linux" });
  assert.equal(env.HTTPS_PROXY, "socks5://127.0.0.1:1080");
  assert.equal(env.NODE_USE_ENV_PROXY, undefined);
});

test("desktop proxy env normalizes HTTP(S) ALL_PROXY for Node fetch", () => {
  const env: NodeJS.ProcessEnv = { ALL_PROXY: "http://127.0.0.1:10808" };
  applyProxyEnv(env, { platform: "linux" });
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("desktop proxy env does not turn a SOCKS ALL_PROXY into HTTPS_PROXY", () => {
  const env: NodeJS.ProcessEnv = { ALL_PROXY: "socks5://127.0.0.1:1080" };
  applyProxyEnv(env, { platform: "linux" });
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NODE_USE_ENV_PROXY, undefined);
});

test("desktop proxy env reads the macOS system HTTPS proxy", () => {
  const env: NodeJS.ProcessEnv = {};
  applyProxyEnv(env, {
    platform: "darwin",
    readSystemProxy: () => `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
  }
  HTTPSEnable : 1
  HTTPSPort : 10808
  HTTPSProxy : 127.0.0.1
  HTTPEnable : 0
  SOCKSEnable : 0
}`,
  });
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env.NO_PROXY, "127.0.0.1");
});

test("desktop proxy env leaves automatic/PAC-only settings alone", () => {
  const env: NodeJS.ProcessEnv = {};
  applyProxyEnv(env, {
    platform: "darwin",
    readSystemProxy: () => `<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://example.test/proxy.pac
  HTTPSEnable : 0
}`,
  });
  assert.deepEqual(env, {});
});

test("macOS parser prefers HTTPS and keeps its exception list", () => {
  const parsed = parseMacProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  HTTPEnable : 0
  HTTPSEnable : 1
  HTTPSPort : 10808
  HTTPSProxy : 127.0.0.1
}`);
  assert.deepEqual(parsed, { url: "http://127.0.0.1:10808", bypass: ["*.local"] });
});
