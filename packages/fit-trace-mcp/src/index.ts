/**
 * Public surface of `@agent-fit-trace/mcp`: the transport-agnostic server
 * factory, tool/resource registration, skill-prompt loading, and the pure
 * startup config helpers — everything except the stdio entrypoint.
 */
export { createCloudFitTraceStore } from "./cloudStore.ts";
export type { CloudFitTraceStoreOptions } from "./cloudStore.ts";
export { checkNodeRuntime, parseArgs, resolveMcpStore, resolveSkillPath, resolveStorePath } from "./config.ts";
export type { McpArgs, ResolvedMcpStore, StoreKind } from "./config.ts";
export { SkillFileNotFoundError, loadTrainingCoachPrompt } from "./prompts.ts";
export { registerFitTraceResources } from "./resources.ts";
export { createFitTraceMcpServer } from "./server.ts";
export type { FitTraceMcpServerOptions } from "./server.ts";
export type { FitTraceStore } from "./store.ts";
export { registerFitTraceTools } from "./tools.ts";
