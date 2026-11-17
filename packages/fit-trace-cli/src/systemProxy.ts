/**
 * Outbound HTTP(S) proxy discovery for the daemon's cloud transport.
 *
 * The renderer uses Chromium and therefore follows the OS proxy configuration.
 * The daemon is a plain Node process: `https.request` ignores proxy
 * environment variables, and a packaged app launched from Finder inherits no
 * shell proxy environment at all. Without this module a machine whose network
 * policy requires a proxy can sign in through the app but never reach the
 * hosted coach: the daemon opens a direct socket and times out.
 *
 * Supported surface (deliberately small and fail-closed):
 * - an explicit `HTTPS_PROXY`/`https_proxy` (then `ALL_PROXY`/`all_proxy`),
 *   as an `http://` or `https://` URL;
 * - on macOS, the system HTTP/HTTPS proxy from `scutil --proxy`;
 * - `NO_PROXY` and the macOS exception list for direct destinations.
 *
 * SOCKS, PAC/automatic configuration and malformed settings are reported as
 * unsupported instead of silently falling back to a direct connection: a
 * direct fallback would bypass the user's network policy.
 */
import { execFileSync } from "node:child_process";

export interface HttpProxyEndpoint {
  readonly protocol: "http:" | "https:";
  readonly host: string;
  readonly port: number;
  /** Value for `Proxy-Authorization`, never logged. */
  readonly authorization?: string;
  /** Hosts that must bypass this proxy. */
  readonly bypass: readonly string[];
  readonly source: "env" | "system";
}

export type OutboundProxyState =
  | { readonly kind: "direct" }
  | { readonly kind: "proxy"; readonly proxy: HttpProxyEndpoint }
  | { readonly kind: "unsupported"; readonly message: string };

export interface ResolveOutboundProxyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** TEST-ONLY: return the `scutil --proxy` text without running it. */
  readonly readSystemProxy?: () => string | null;
}

function unsupported(message: string): OutboundProxyState {
  return { kind: "unsupported", message };
}

function parseBypass(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    // macOS writes wildcard domains as `*.local`; matching treats a leading
    // dot as a suffix, so normalise the wildcard form to that representation.
    .map((entry) => (entry.startsWith("*.") ? entry.slice(1) : entry))
    .filter((entry) => entry !== "");
}

interface BypassEntry {
  host: string;
  port?: number;
}

function splitBypassEntry(entry: string): BypassEntry {
  // NO_PROXY allows `host:port` and `[ipv6]:port`. An unbracketed IPv6
  // address contains several colons and must not be mistaken for a port.
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end < 0) return { host: entry };
    const host = entry.slice(1, end);
    const rest = entry.slice(end + 1);
    return rest.startsWith(":") && /^\d+$/.test(rest.slice(1))
      ? { host, port: Number(rest.slice(1)) }
      : { host };
  }
  const firstColon = entry.indexOf(":");
  if (firstColon <= 0 || firstColon !== entry.lastIndexOf(":")) return { host: entry };
  const suffix = entry.slice(firstColon + 1);
  return /^\d+$/.test(suffix) ? { host: entry.slice(0, firstColon), port: Number(suffix) } : { host: entry };
}

function proxyFromUrl(
  raw: string,
  source: "env" | "system",
  bypass: readonly string[],
): OutboundProxyState {
  let value = raw.trim();
  if (value === "") return { kind: "direct" };
  // A bare `host:port` is a common proxy setting; treat it as HTTP.
  if (!value.includes("://")) value = `http://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return unsupported("The configured HTTP proxy is not a valid URL.");
  }
  if (url.protocol === "socks:" || url.protocol === "socks5:" || url.protocol === "socks5h:") {
    return unsupported(
      "The configured proxy uses SOCKS, which the cloud transport does not support. Configure an HTTP or HTTPS proxy.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return unsupported("The configured proxy must use http:// or https://.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return unsupported("The configured proxy URL must not contain a path.");
  }
  if (url.hostname === "") {
    return unsupported("The configured proxy URL has no host.");
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    return unsupported("The configured proxy URL has an invalid port.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let authorization: string | undefined;
  if (url.username !== "" || url.password !== "") {
    try {
      authorization = `Basic ${Buffer.from(
        `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
        "utf8",
      ).toString("base64")}`;
    } catch {
      return unsupported("The configured proxy credentials contain an invalid escape.");
    }
  }
  return {
    kind: "proxy",
    proxy: {
      protocol: url.protocol,
      host,
      port,
      ...(authorization === undefined ? {} : { authorization }),
      bypass,
      source,
    },
  };
}

function parseExceptions(text: string): string[] {
  const exceptions: string[] = [];
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
    if (match !== null) exceptions.push((match[1] as string).toLowerCase());
  }
  return exceptions;
}

/** Parse the stable key/value lines from `scutil --proxy` without executing it. */
export function parseMacSystemProxy(text: string): OutboundProxyState {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (match !== null) values.set(match[1] as string, match[2] as string);
  }
  const enabled = (key: string): boolean => values.get(key) === "1";
  const bypass = parseExceptions(text);
  const useHttps = enabled("HTTPSEnable") && values.has("HTTPSProxy") && values.has("HTTPSPort");
  const useHttp = enabled("HTTPEnable") && values.has("HTTPProxy") && values.has("HTTPPort");
  if ((enabled("HTTPSEnable") || enabled("HTTPEnable")) && !useHttps && !useHttp) {
    return unsupported("macOS reports an enabled proxy with no usable host and port.");
  }
  const automatic =
    enabled("ProxyAutoConfigEnable") ||
    enabled("ProxyAutoDiscoveryEnable") ||
    values.has("ProxyAutoConfigURLString");
  if (automatic && !useHttps && !useHttp) {
    return unsupported(
      "macOS is configured to use an automatic (PAC) proxy; the cloud transport supports an explicit HTTP or HTTPS proxy.",
    );
  }
  if (useHttps || useHttp) {
    const host = useHttps ? values.get("HTTPSProxy") : values.get("HTTPProxy");
    const port = useHttps ? values.get("HTTPSPort") : values.get("HTTPPort");
    return proxyFromUrl(`${host}:${port}`, "system", bypass);
  }
  if (enabled("SOCKSEnable") && values.has("SOCKSProxy") && values.has("SOCKSPort")) {
    return unsupported(
      "macOS is configured to use only a SOCKS proxy; the cloud transport supports HTTP or HTTPS proxies.",
    );
  }
  return { kind: "direct" };
}

function readMacSystemProxy(): string | null {
  try {
    return execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Resolve the egress proxy once at daemon startup. Explicit environment wins
 * over the OS setting; a Finder launch has no shell environment and therefore
 * reaches the `scutil` branch on macOS.
 */
export function resolveOutboundProxy(
  options: ResolveOutboundProxyOptions = {},
): OutboundProxyState {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const explicit =
    env.HTTPS_PROXY?.trim() ||
    env.https_proxy?.trim() ||
    env.ALL_PROXY?.trim() ||
    env.all_proxy?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.http_proxy?.trim();
  if (explicit !== undefined && explicit !== "") {
    return proxyFromUrl(explicit, "env", parseBypass(env.NO_PROXY ?? env.no_proxy));
  }
  if (platform === "darwin") {
    const text = options.readSystemProxy === undefined ? readMacSystemProxy() : options.readSystemProxy();
    if (text === null) {
      return unsupported("The macOS system proxy settings could not be read.");
    }
    const parsed = parseMacSystemProxy(text);
    if (parsed.kind === "proxy") {
      return {
        kind: "proxy",
        proxy: { ...parsed.proxy, bypass: [...parseBypass(env.NO_PROXY ?? env.no_proxy), ...parsed.proxy.bypass] },
      };
    }
    return parsed;
  }
  return { kind: "direct" };
}

export function shouldBypassProxy(
  hostname: string,
  bypass: readonly string[],
  port = 443,
): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  for (const rawEntry of bypass) {
    const wildcard = rawEntry.startsWith("*.") ? rawEntry.slice(1) : rawEntry;
    const entry = splitBypassEntry(wildcard.replace(/^\./, ""));
    if (entry.host === "*") return true;
    if (entry.host === "") continue;
    if (entry.port !== undefined && entry.port !== port) continue;
    if (host === entry.host || host.endsWith(`.${entry.host}`)) return true;
  }
  return false;
}

/**
 * Make the global `fetch` (Supabase bearer verification and sync) follow the
 * same proxy. Node 24 reads these variables on the first fetch; the daemon
 * calls this before creating any verifier. The raw cloud transport does not
 * use this environment and receives the proxy object directly.
 */
function proxyUserInfo(authorization: string | undefined): string {
  if (authorization === undefined || !authorization.startsWith("Basic ")) return "";
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return "";
    return `${encodeURIComponent(decoded.slice(0, colon))}:${encodeURIComponent(decoded.slice(colon + 1))}@`;
  } catch {
    return "";
  }
}

export function applyProxyEnvironment(
  state: OutboundProxyState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (state.kind !== "proxy") return;
  const { protocol, host, port, bypass, authorization } = state.proxy;
  const url = `${protocol}//${proxyUserInfo(authorization)}${host.includes(":") ? `[${host}]` : host}:${port}`;
  env.HTTPS_PROXY ??= url;
  env.https_proxy ??= url;
  env.NODE_USE_ENV_PROXY ??= "1";
  if (bypass.length > 0) {
    env.NO_PROXY ??= bypass.join(",");
    env.no_proxy ??= bypass.join(",");
  }
}
