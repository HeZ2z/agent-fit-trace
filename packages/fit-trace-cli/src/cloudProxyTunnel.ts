/**
 * HTTPS-over-HTTP-CONNECT transport for the cloud proxy.
 *
 * The proxy still resolves and validates the destination itself. The tunnel
 * therefore CONNECTs to the *approved numeric address*, not the hostname, so
 * the proxy cannot re-resolve the name to a different (possibly private)
 * address. TLS is then negotiated through the tunnel with the original
 * hostname as SNI and certificate name; the proxy never sees the bearer and
 * cannot read the request.
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { AgentOptions } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";

import type { HttpProxyEndpoint } from "./systemProxy.ts";

export interface ProxyTunnelTarget {
  readonly address: string;
}

export interface ProxyTunnelOptions {
  readonly proxy: HttpProxyEndpoint;
  readonly target: URL;
  readonly pinned: ProxyTunnelTarget;
  readonly timeoutMs: number;
  /**
   * TEST-ONLY TLS trust override for a local self-signed server. The daemon
   * never passes this; production always uses the platform CA store.
   */
  readonly tls?: {
    readonly ca?: string | Buffer | Array<string | Buffer>;
    readonly rejectUnauthorized?: boolean;
  };
}

export interface ProxyTunnel {
  /** Agent for `https.request`/`https.get`; it owns the CONNECT handshake. */
  readonly agent: HttpsAgent;
  /** The exact `CONNECT` authority; exposed for tests. */
  readonly connectTarget: string;
  /** Abort an in-flight CONNECT/TLS handshake and close the tunnel. */
  destroy(): void;
}

function authority(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

export function formatConnectTarget(address: string, port: number): string {
  return `${authority(address)}:${port}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown proxy error.";
}

/**
 * Create a one-shot agent that establishes one CONNECT tunnel per connection.
 * `agent.createConnection` is overridden on the instance because Node's HTTP
 * agent owns socket creation; returning an already-TLS-wrapped socket makes
 * `https.request` write the ordinary HTTP request over it.
 */
export function createProxyTunnel(options: ProxyTunnelOptions): ProxyTunnel {
  const { proxy, target, pinned, timeoutMs, tls } = options;
  if (target.protocol !== "https:") {
    throw new Error("The proxy tunnel only supports HTTPS destinations.");
  }
  const port = target.port === "" ? 443 : Number(target.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error("The proxy tunnel received an invalid destination port.");
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const connectTarget = formatConnectTarget(pinned.address, port);
  const agent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
  const sockets = new Set<Socket>();
  const requests = new Set<ClientRequest>();
  let destroyed = false;

  function destroy(): void {
    destroyed = true;
    for (const request of requests) request.destroy();
    requests.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    agent.destroy();
  }

  const connection = (
    _options: AgentOptions,
    callback: (error: Error | null, socket?: TLSSocket) => void,
  ): void => {
    let done = false;
    const finish = (error: Error | null, socket?: TLSSocket): void => {
      if (done) return;
      done = true;
      callback(error, socket);
    };
    if (destroyed) {
      finish(new Error("The proxy tunnel was aborted."));
      return;
    }
    // Some proxies validate that CONNECT's target and Host agree. Both must
    // name the approved numeric authority; the hostname is used only for SNI
    // and certificate verification inside the tunnel.
    const headers: Record<string, string> = { host: connectTarget };
    if (proxy.authorization !== undefined) headers["proxy-authorization"] = proxy.authorization;
    const request = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: connectTarget,
      headers,
      ...(proxy.protocol === "https:" ? { servername: proxy.host } : {}),
      timeout: timeoutMs,
      agent: false,
    });
    requests.add(request);
    const abort = (message: string): void => {
      request.destroy();
      finish(new Error(message));
    };
    request.setTimeout(timeoutMs, () => abort("The proxy CONNECT timed out."));
    request.on("error", (error) => finish(new Error(`The proxy CONNECT failed: ${errorMessage(error)}`)));
    request.on("response", (response: IncomingMessage) => {
      response.resume();
      abort(`The proxy CONNECT answered ${response.statusCode ?? "an error"}.`);
    });
    request.on("connect", (response, socket) => {
      sockets.add(socket);
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`The proxy CONNECT answered ${response.statusCode ?? "an error"}.`));
        return;
      }
      // Once the proxy has connected to the approved numeric address, wrap
      // the tunnel in TLS. The original hostname is used only for SNI and
      // certificate verification; the proxy cannot substitute a certificate
      // for another host without failing verification.
      const secure = tlsConnect({
        socket,
        servername: hostname,
        host: hostname,
        ...(tls?.ca === undefined ? {} : { ca: tls.ca }),
        ...(tls?.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: tls.rejectUnauthorized }),
      });
      sockets.add(secure);
      secure.setTimeout(timeoutMs, () => {
        secure.destroy();
        finish(new Error("The proxy TLS handshake timed out."));
      });
      secure.once("secureConnect", () => {
        secure.setTimeout(0);
        finish(null, secure);
      });
      secure.once("error", (error) => finish(new Error(`The proxy TLS handshake failed: ${errorMessage(error)}`)));
    });
    request.end();
  };

  (agent as unknown as { createConnection: typeof connection }).createConnection = connection;
  return { agent, connectTarget, destroy };
}
