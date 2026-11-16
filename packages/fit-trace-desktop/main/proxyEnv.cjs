"use strict";

/**
 * Proxy environment for the daemon child process.
 *
 * Node's global fetch only honors `HTTPS_PROXY`/`ALL_PROXY` when
 * `NODE_USE_ENV_PROXY=1` was present when the process started. The packaged
 * app is launched from Finder, so it inherits no shell proxy environment;
 * detecting the proxy in the daemon (or setting the flag there) is too late
 * for Supabase verification and sync. This module resolves the proxy in the
 * Electron parent and puts it into the child's environment before spawn.
 *
 * The daemon still resolves the proxy itself for the raw cloud tunnel and for
 * direct CLI use; this is the startup piece that global fetch needs.
 */

const { execFileSync } = require("node:child_process");

function parseMacProxy(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (match !== null) values.set(match[1], match[2]);
  }
  const enabled = (key) => values.get(key) === "1";
  const useHttps = enabled("HTTPSEnable") && values.has("HTTPSProxy") && values.has("HTTPSPort");
  const useHttp = enabled("HTTPEnable") && values.has("HTTPProxy") && values.has("HTTPPort");
  if (!useHttps && !useHttp) return null;
  const host = useHttps ? values.get("HTTPSProxy") : values.get("HTTPProxy");
  const port = useHttps ? values.get("HTTPSPort") : values.get("HTTPPort");
  const bypass = [];
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    if (/ExceptionsList\s*:\s*<array>/.test(line)) {
      inList = true;
      continue;
    }
    if (inList && /^\s*}\s*$/.test(line)) {
      inList = false;
      continue;
    }
    if (!inList) continue;
    const match = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line);
    if (match !== null) bypass.push(match[1].toLowerCase());
  }
  return { url: `http://${host}:${port}`, bypass };
}

/**
 * Add proxy variables to a child environment without overriding explicit
 * values. Returns the same object for convenient use at the spawn site.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ platform?: NodeJS.Platform, readSystemProxy?: () => string | null }} [options]
 */
function applyProxyEnv(env, options = {}) {
  const httpsExplicit = env.HTTPS_PROXY || env.https_proxy;
  if (httpsExplicit !== undefined && httpsExplicit !== "") {
    env.NODE_USE_ENV_PROXY ??= "1";
    return env;
  }
  // Node's global fetch does not read ALL_PROXY/HTTP_PROXY for HTTPS
  // destinations. Normalize a supported HTTP(S) form to HTTPS_PROXY before
  // spawn; a SOCKS-only ALL_PROXY is left for the daemon to reject explicitly.
  const fallback = env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy;
  if (fallback !== undefined && /^https?:\/\//i.test(fallback)) {
    env.HTTPS_PROXY = fallback;
    env.https_proxy = fallback;
    env.NODE_USE_ENV_PROXY ??= "1";
    return env;
  }
  if (fallback !== undefined && fallback !== "") return env;
  if ((options.platform ?? process.platform) !== "darwin") return env;
  let text;
  try {
    text = options.readSystemProxy
      ? options.readSystemProxy()
      : execFileSync("scutil", ["--proxy"], {
          encoding: "utf8",
          timeout: 1000,
          stdio: ["ignore", "pipe", "ignore"],
        });
  } catch {
    return env;
  }
  if (text === null) return env;
  const proxy = parseMacProxy(text);
  if (proxy === null) return env;
  env.HTTPS_PROXY = proxy.url;
  env.https_proxy = proxy.url;
  env.NODE_USE_ENV_PROXY = "1";
  if (proxy.bypass.length > 0) {
    env.NO_PROXY ??= proxy.bypass.join(",");
    env.no_proxy ??= proxy.bypass.join(",");
  }
  return env;
}

module.exports = { applyProxyEnv, parseMacProxy };
