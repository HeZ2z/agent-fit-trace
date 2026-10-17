/**
 * Browser-safe public surface of the fit-trace API contract.
 *
 * Like the core, everything exported here is pure TypeScript with no Node
 * built-ins, so it can be consumed by both the app (browser) and any Node
 * transport. This package owns the *shape* of the boundary — client surface,
 * envelope, errors, strict response guards, and deterministic ids — while all
 * domain computation stays in `@pi-fit-trace/core`.
 */
export * from "./types.ts";
export * from "./errors.ts";
export * from "./deriveWorkoutId.ts";
export * from "./validators.ts";
export * from "./imports.ts";
export * from "./importFiles.ts";
export * from "./coaching.ts";
export * from "./cloudCoaching.ts";
