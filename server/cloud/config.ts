/**
 * Server-only cloud coaching configuration.
 *
 * Safe defaults: cloud is OFF unless `FIT_TRACE_CLOUD_ENABLED=1`, the provider
 * key/model are explicitly configured, and the endpoint is the official
 * OpenRouter chat-completions endpoint. Missing/invalid configuration never
 * silently selects a paid model or a caller-supplied endpoint.
 *
 * The request path reads only the Supabase URL/publishable key (for the
 * caller-token RPC repository) and a provider-configured boolean. The worker
 * additionally requires `SUPABASE_SERVICE_ROLE_KEY`; that key is never used by
 * a browser-facing request.
 */
import { readSupabaseServerEnv } from "../db/env.ts";
import type { SupabaseServerEnv } from "../db/env.ts";

/** Fixed official endpoint. No client or env value can repoint production traffic. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_CHAT_COMPLETIONS_URL = `${OPENROUTER_BASE_URL}/chat/completions`;

/**
 * Worker-only agent runtime selection (`FIT_TRACE_CLOUD_AGENT`).
 *
 * `builtin` is the legacy bounded native-`fetch` loop and stays the default.
 * `pi-agent-core` embeds pi's real agent loop; see ADR 0002. The value is
 * case-sensitive. An absent or blank value means the default; any other
 * unrecognised value fails the worker closed instead of silently selecting a
 * runtime. See `docs/adr/0002-cloud-pi-agent-runtime.md`.
 */
export const CLOUD_AGENT_KINDS = ["builtin", "pi-agent-core"] as const;

export type CloudAgentKind = (typeof CLOUD_AGENT_KINDS)[number];

export const DEFAULT_CLOUD_AGENT: CloudAgentKind = "builtin";

/** Resolve the configured runtime. `null` means invalid configuration. */
export function readCloudAgentKind(
  env: Record<string, string | undefined> = process.env,
): CloudAgentKind | null {
  const raw = (env.FIT_TRACE_CLOUD_AGENT ?? "").trim();
  if (raw === "") return DEFAULT_CLOUD_AGENT;
  return (CLOUD_AGENT_KINDS as readonly string[]).includes(raw) ? (raw as CloudAgentKind) : null;
}

export const CLOUD_SAFE_DEFAULTS = {
  maxSteps: 4,
  maxTokens: 2048,
  maxTokensPerStep: 512,
  maxInputBytes: 256 * 1024,
  timeoutMs: 60_000,
  // Must cover a full bounded provider loop (maxSteps × timeout).
  workerLeaseMs: 300_000,
  workerPollMs: 1_000,
  workerBatch: 4,
  ssePollMs: 1_000,
  sseMaxDurationMs: 15_000,
  ssePageLimit: 200,
} as const;

const MAX_STEPS = 8;
const MAX_TOKENS = 8192;
const MAX_TOKENS_PER_STEP = 4096;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_WORKER_LEASE_MS = 300_000;
const MIN_WORKER_LEASE_MS = 15_000;

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl: typeof OPENROUTER_BASE_URL;
  endpoint: typeof OPENROUTER_CHAT_COMPLETIONS_URL;
  maxSteps: number;
  maxTokens: number;
  maxTokensPerStep: number;
  maxInputBytes: number;
  timeoutMs: number;
}

/**
 * Read the documented `FIT_TRACE_OPENROUTER_*` shape. A blank key/model, or a
 * base URL other than the official one, is unconfigured (null) — never a
 * fallback to another endpoint.
 */
export function readOpenRouterConfig(
  env: Record<string, string | undefined> = process.env,
): OpenRouterConfig | null {
  const apiKey = (env.FIT_TRACE_OPENROUTER_API_KEY ?? "").trim();
  const model = (env.FIT_TRACE_OPENROUTER_MODEL ?? "").trim();
  if (apiKey === "" || model === "") return null;
  const rawBase = (env.FIT_TRACE_OPENROUTER_BASE_URL ?? "").trim();
  const base = rawBase === "" ? OPENROUTER_BASE_URL : rawBase.replace(/\/+$/, "");
  if (base !== OPENROUTER_BASE_URL) return null;
  return {
    apiKey,
    model,
    baseUrl: OPENROUTER_BASE_URL,
    endpoint: OPENROUTER_CHAT_COMPLETIONS_URL,
    maxSteps: clampInt(env.FIT_TRACE_OPENROUTER_MAX_STEPS, CLOUD_SAFE_DEFAULTS.maxSteps, 1, MAX_STEPS),
    maxTokens: clampInt(env.FIT_TRACE_OPENROUTER_MAX_TOKENS, CLOUD_SAFE_DEFAULTS.maxTokens, 128, MAX_TOKENS),
    maxTokensPerStep: clampInt(
      env.FIT_TRACE_OPENROUTER_MAX_TOKENS_PER_STEP,
      CLOUD_SAFE_DEFAULTS.maxTokensPerStep,
      64,
      MAX_TOKENS_PER_STEP,
    ),
    maxInputBytes: clampInt(
      env.FIT_TRACE_OPENROUTER_MAX_INPUT_BYTES,
      CLOUD_SAFE_DEFAULTS.maxInputBytes,
      16 * 1024,
      MAX_INPUT_BYTES,
    ),
    timeoutMs: clampInt(
      env.FIT_TRACE_OPENROUTER_TIMEOUT_MS,
      CLOUD_SAFE_DEFAULTS.timeoutMs,
      5_000,
      MAX_TIMEOUT_MS,
    ),
  };
}

export interface CloudRequestEnv {
  supabase: SupabaseServerEnv;
  provider: OpenRouterConfig | null;
  enabled: boolean;
}

/**
 * Request-path configuration. `null` means the deployed cloud slice is off;
 * callers must fail closed. A configured slice without a provider returns
 * `provider: null` so discovery/submit report `provider-unconfigured`
 * instead of reserving quota for a run that cannot execute.
 */
export function readCloudRequestEnv(
  env: Record<string, string | undefined> = process.env,
): CloudRequestEnv | null {
  if ((env.FIT_TRACE_CLOUD_ENABLED ?? "").trim() !== "1") return null;
  const supabase = readSupabaseServerEnv(env);
  if (supabase === null) return null;
  return { supabase, provider: readOpenRouterConfig(env), enabled: true };
}

export interface CloudWorkerEnv {
  supabase: SupabaseServerEnv;
  serviceRoleKey: string;
  provider: OpenRouterConfig;
  /** Agent loop used by the outbox worker. Defaults to the builtin loop. */
  agent: CloudAgentKind;
  workerId: string;
  leaseMs: number;
  pollMs: number;
  batch: number;
}

/** True only for a non-empty service key that is not the publishable key. */
export function readServiceRoleKey(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (key === "") return null;
  // A publishable key would give the worker no service privileges and is a
  // config mistake; reject it rather than run with an ineffective identity.
  if (key === (env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? "").trim()) return null;
  if (key.startsWith("sb_publishable_")) return null;
  return key;
}

/**
 * Worker configuration. Returns null (and the entrypoint refuses to start)
 * when the kill switch is off, Supabase is missing, the service key is
 * missing, or the provider is unconfigured.
 */
export function readCloudWorkerEnv(
  env: Record<string, string | undefined> = process.env,
): CloudWorkerEnv | null {
  if ((env.FIT_TRACE_CLOUD_ENABLED ?? "").trim() !== "1") return null;
  const supabase = readSupabaseServerEnv(env);
  const serviceRoleKey = readServiceRoleKey(env);
  const provider = readOpenRouterConfig(env);
  // An unrecognised runtime name is a configuration error, not a fallback.
  const agent = readCloudAgentKind(env);
  if (supabase === null || serviceRoleKey === null || provider === null || agent === null) return null;
  const leaseMs = clampInt(
    env.FIT_TRACE_CLOUD_WORKER_LEASE_MS,
    CLOUD_SAFE_DEFAULTS.workerLeaseMs,
    MIN_WORKER_LEASE_MS,
    MAX_WORKER_LEASE_MS,
  );
  return {
    supabase,
    serviceRoleKey,
    provider,
    agent,
    workerId: (env.FIT_TRACE_CLOUD_WORKER_ID ?? "").trim() || `worker-${process.pid}`,
    leaseMs,
    pollMs: clampInt(env.FIT_TRACE_CLOUD_WORKER_POLL_MS, CLOUD_SAFE_DEFAULTS.workerPollMs, 250, 30_000),
    batch: clampInt(env.FIT_TRACE_CLOUD_WORKER_BATCH, CLOUD_SAFE_DEFAULTS.workerBatch, 1, 10),
  };
}

/** Worker kill switch: true only for the explicit enabled value. */
export function cloudKillSwitchOpen(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.FIT_TRACE_CLOUD_ENABLED ?? "").trim() === "1";
}

export function isSafeHttpsEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "openrouter.ai";
  } catch {
    return false;
  }
}
