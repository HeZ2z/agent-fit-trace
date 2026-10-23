/**
 * Browser-safe public surface of the fit-trace domain contract.
 *
 * Everything exported here is pure TypeScript with no Node built-ins, so it can
 * be consumed by both the pi Extension (Node) and the React app (browser).
 * Node-only persistence lives in the extension's `store.ts`, never here.
 */
export * from "./types.ts";
export * from "./errors.ts";
export * from "./schema.ts";
export * from "./metrics.ts";
export * from "./analyze.ts";
export * from "./plan.ts";
export * from "./canonical.ts";
export * from "./plates.ts";
export * from "./exercises/index.ts";
