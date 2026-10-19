/**
 * Configurable long-running cloud worker entrypoint.
 *
 * Run it as its own process (container/Fly/Render/VM):
 *
 *   FIT_TRACE_CLOUD_ENABLED=1 \
 *   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   FIT_TRACE_OPENROUTER_API_KEY=... FIT_TRACE_OPENROUTER_MODEL=... \
 *   FIT_TRACE_CLOUD_AGENT=builtin|pi-agent-core \
 *   node server/cloud/workerEntrypoint.ts
 *
 * It never spawns a serverless function or a child process. If the kill
 * switch is off, any required secret is missing, or the agent runtime name is
 * invalid, it exits non-zero; it never starts with an unconfigured provider.
 */
import { pathToFileURL } from "node:url";
import { readCloudWorkerEnv } from "./config.ts";
import type { CloudWorkerEnv } from "./config.ts";
import { createCloudOutboxWorker, runCloudWorkerLoop } from "./outboxWorker.ts";
import type { CloudCoachingProvider } from "./openRouterProvider.ts";
import { createOpenRouterProvider } from "./openRouterProvider.ts";
import { createPiAgentProvider } from "./piAgentProvider.ts";
import { createSupabaseCoachingWorkerRepository } from "./supabaseCoachingRepository.ts";

export interface CloudWorkerRuntimeOptions {
  signal?: AbortSignal;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

export interface CloudWorkerRuntime {
  stop(): void;
  done: Promise<void>;
}

/**
 * Select the worker's agent loop. `builtin` remains the default and unchanged
 * path; `pi-agent-core` embeds pi's real loop behind the same provider seam.
 * Configuration validation already rejected unknown values, so this switch
 * only chooses between two known implementations.
 */
export function createCloudWorkerProvider(
  env: CloudWorkerEnv,
  options: { fetchImpl?: typeof fetch } = {},
): CloudCoachingProvider {
  const fetchOption = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };
  return env.agent === "pi-agent-core"
    ? createPiAgentProvider({ config: env.provider, ...fetchOption })
    : createOpenRouterProvider({ config: env.provider, ...fetchOption });
}

/** Start the bounded poll loop. One worker process, no child processes. */
export function startCloudWorkerRuntime(options: CloudWorkerRuntimeOptions = {}): CloudWorkerRuntime | null {
  const env = readCloudWorkerEnv();
  if (env === null) return null;
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const log = options.log ?? ((event, details) => {
    console.log(JSON.stringify({ event, ...(details ?? {}) }));
  });

  const repository = createSupabaseCoachingWorkerRepository({
    supabaseUrl: env.supabase.supabaseUrl,
    serviceRoleKey: env.serviceRoleKey,
  });
  const provider = createCloudWorkerProvider(env);
  const worker = createCloudOutboxWorker({
    repository,
    provider,
    enabled: true,
    workerId: env.workerId,
    leaseMs: env.leaseMs,
    batch: env.batch,
    logger: log,
  });

  const done = runCloudWorkerLoop({
    tick: () => worker.tick(),
    pollMs: env.pollMs,
    signal,
    log,
  });

  return {
    stop(): void {
      controller.abort();
    },
    done,
  };
}

const invokedAsMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  const runtime = startCloudWorkerRuntime();
  if (runtime === null) {
    console.error(
      "cloud worker not started: set FIT_TRACE_CLOUD_ENABLED=1, Supabase URL/publishable/service keys, FIT_TRACE_OPENROUTER_API_KEY/MODEL, and FIT_TRACE_CLOUD_AGENT=builtin|pi-agent-core",
    );
    process.exitCode = 1;
  } else {
    const stop = (): void => runtime.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runtime.done;
  }
}
