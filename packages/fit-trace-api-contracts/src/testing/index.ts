/**
 * Test-support surface for the API contract: the in-memory route handler and
 * the runner-agnostic client conformance suite. Both are browser-safe and free
 * of `node:` imports so app (vitest) and root (node:test) hosts can share them.
 */
export * from "./memoryHandler.ts";
export * from "./contractSuite.ts";
