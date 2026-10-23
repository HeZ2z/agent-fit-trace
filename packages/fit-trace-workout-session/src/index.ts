/**
 * Public surface of `@agent-fit-trace/workout-session`.
 *
 * Pure TypeScript with no React, expo, DOM or Node built-ins, so the same model
 * drives the web editor and the React Native Log screen. The package covers the
 * draft model, deterministic reducer, live timing + transient rest, the core
 * record bridge and the persisted draft payload.
 */
export * from "./types.ts";
export * from "./draft.ts";
export * from "./actions.ts";
export * from "./timing.ts";
export * from "./runtime.ts";
export * from "./reducer.ts";
export * from "./build.ts";
export * from "./persistence.ts";
