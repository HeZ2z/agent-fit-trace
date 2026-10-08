import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import { startDevApiServer } from "../../../server/devApiServer.ts";
import type { DevApiServer } from "../../../server/devApiServer.ts";

/**
 * Smoke check that the committed Vite config actually forwards `/api` to
 * the dev API. Starts the REAL dev API on an ephemeral port, points
 * `FIT_TRACE_DEV_API_PORT` at it, boots a REAL Vite dev server from the
 * project `configFile` (so the committed proxy target is exercised), and
 * fetches `/api/v1/workouts` through the proxy.
 */
describe("Vite /api proxy to the dev API", () => {
  const previousPort = process.env.FIT_TRACE_DEV_API_PORT;
  let api: DevApiServer | undefined;
  let vite: ViteDevServer | undefined;

  afterEach(async () => {
    if (previousPort === undefined) delete process.env.FIT_TRACE_DEV_API_PORT;
    else process.env.FIT_TRACE_DEV_API_PORT = previousPort;
    if (vite) await vite.close();
    if (api) await api.close();
    vite = undefined;
    api = undefined;
  });

  it("forwards /api/v1/workouts to the loopback dev API", async () => {
    api = await startDevApiServer({ port: 0 });
    // The proxy target is derived from this variable at config load time,
    // so it must be set BEFORE the Vite server below reads vite.config.ts.
    process.env.FIT_TRACE_DEV_API_PORT = String(api.port);

    vite = await createServer({
      // Vitest runs with the app directory as cwd, so resolve the committed
      // config from there (import.meta.url is not a file URL under vitest).
      // Pin an ephemeral loopback port: the committed proxy target comes
      // from the config file, only the bind port is overridden here.
      configFile: resolve(process.cwd(), "vite.config.ts"),
      server: { host: "127.0.0.1", port: 0, strictPort: true },
      logLevel: "silent",
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    const vitePort =
      typeof address === "object" && address !== null ? address.port : undefined;
    expect(vitePort).toBeDefined();

    const response = await fetch(`http://127.0.0.1:${vitePort}/api/v1/workouts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    expect(body.data).toEqual([]);
  }, 30_000);
});
