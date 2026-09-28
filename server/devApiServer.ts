import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { createMemoryHandler } from "@pi-fit-trace/api-contracts/testing";
import { createInMemoryWorkoutStore } from "./inMemoryWorkoutStore.ts";

export interface DevApiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function collectBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) resolve(undefined);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

/**
 * Start a loopback-only development API that runs the deterministic core
 * directly. One in-memory append-only store is created per server process;
 * restarting the process clears all records (non-durable by design).
 */
export async function startDevApiServer(
  options: { port?: number; host?: string } = {},
): Promise<DevApiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.FIT_TRACE_DEV_API_PORT ?? 5199);
  const store = createInMemoryWorkoutStore();
  const handler = createMemoryHandler(store);

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const rawPath = request.url ?? "/";
      // The public base is `/api/v1`, but the shared handler routes on bare
      // resource paths — strip the prefix so both speak the same routes.
      const rawUrl = new URL(rawPath, "http://127.0.0.1");
      const route = `${rawUrl.pathname.replace(/^\/api\/v1(?=\/|$)/, "")}${rawUrl.search}`;
      let body: string | undefined;
      try {
        body = await collectBody(request);
      } catch {
        body = undefined;
      }
      const result = await handler(route, { method, body });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(result.body);
    } catch {
      // Never leak stack traces over the wire; the handler already maps
      // domain errors, so reaching here means something unexpected failed.
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "API_ERROR", message: "Internal error." } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

const invokedAsMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  const server = await startDevApiServer();
  console.log(`fit-trace dev API listening at ${server.url}/api/v1`);
}
