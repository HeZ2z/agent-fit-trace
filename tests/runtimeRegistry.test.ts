import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCoachingRuntimeRegistry,
  createReplaceableCoachingRuntimeRegistry,
} from "../server/coaching/runtimeRegistry.ts";
import type {
  CoachingRuntimeRegistration,
  RuntimeFactory,
  RuntimeHandle,
} from "../server/coaching/runtimeRegistry.ts";
import type { CoachingBackendId } from "@agent-fit-trace/api-contracts";

/**
 * The replaceable registry is the seam that lets a late CLI probe update
 * discovery without a restart (#68): `createCoachingService` captures the
 * registry OBJECT, so the object must stay stable while its CONTENTS change.
 * These tests pin exactly that contract — delegation, atomic swap, validation
 * failure leaving the previous snapshot serving — because a regression here is
 * invisible until a user runs a coached session against stale discovery.
 */

/** Minimal handle: nothing here launches a run, so it only has to typecheck. */
const inertFactory: RuntimeFactory = (): RuntimeHandle => ({
  start(): void {},
  cancel(): void {},
  async close(): Promise<void> {},
});

function available(backendId: CoachingBackendId, overrides: Partial<CoachingRuntimeRegistration> = {}): CoachingRuntimeRegistration {
  const runtimeId = backendId === "local-codex" ? "codex" : backendId === "local-opencode" ? "opencode" : "pi";
  return {
    backendId,
    runtimeId,
    executionLocation: "local",
    displayName: `${backendId} display`,
    available: true,
    factory: inertFactory,
    ...overrides,
  } as CoachingRuntimeRegistration;
}

function unavailable(backendId: CoachingBackendId, message: string): CoachingRuntimeRegistration {
  const runtimeId = backendId === "local-codex" ? "codex" : backendId === "local-opencode" ? "opencode" : "pi";
  return {
    backendId,
    runtimeId,
    executionLocation: "local",
    displayName: `${backendId} display`,
    available: false,
    unavailableReason: { code: "cli-not-installed", message },
  } as CoachingRuntimeRegistration;
}

test("get and list delegate to the snapshot that was supplied at construction", () => {
  const registry = createReplaceableCoachingRuntimeRegistry([available("local-pi")]);
  assert.equal(registry.get("local-pi")?.backendId, "local-pi");
  assert.deepEqual(
    registry.list().map((entry) => entry.backendId),
    ["local-pi"],
  );
  // A backend that was never registered reads as absent, never as a throw —
  // the discovery path calls `get` for EVERY backend id on every request.
  assert.equal(registry.get("local-codex"), undefined);
});

test("an empty construction list leaves an empty but usable registry", () => {
  const registry = createReplaceableCoachingRuntimeRegistry();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get("local-pi"), undefined);
  // `current()` is the same immutable snapshot view, not a second live object.
  assert.deepEqual(registry.current().list(), []);
});

test("replace is observed by a reader that captured the registry object", () => {
  const registry = createReplaceableCoachingRuntimeRegistry([available("local-pi")]);
  // The service captures the OBJECT, exactly like `createCoachingService` does.
  const captured = registry;
  assert.deepEqual(captured.list().map((entry) => entry.backendId), ["local-pi"]);

  registry.replace([available("local-pi"), unavailable("local-codex", "codex CLI is not available on PATH.")]);

  // The same reference now serves the new contents: no re-wiring, no restart.
  assert.deepEqual(
    captured.list().map((entry) => entry.backendId),
    ["local-pi", "local-codex"],
  );
  assert.equal(captured.get("local-codex")?.available, false);
  assert.equal(
    captured.get("local-codex")?.unavailableReason?.message,
    "codex CLI is not available on PATH.",
  );
});

test("replace is atomic: a reader never observes a partially applied set", () => {
  // Two backends in, one backend out, in a single call. If `replace` mutated
  // the previous set in place (remove-then-add), a concurrent `list()` could
  // see a mixture. Capturing the snapshot identity proves the swap is a
  // single reference assignment over an already-built registry.
  const registry = createReplaceableCoachingRuntimeRegistry([
    available("local-pi"),
    unavailable("local-codex", "codex CLI is not available on PATH."),
  ]);
  const before = registry.current();
  registry.replace([available("local-opencode", { runtimeId: "opencode" })]);
  const after = registry.current();

  assert.notEqual(after, before, "the snapshot object must be replaced, not mutated");
  assert.deepEqual(before.list().map((entry) => entry.backendId), ["local-pi", "local-codex"]);
  assert.deepEqual(after.list().map((entry) => entry.backendId), ["local-opencode"]);
  assert.equal(registry.get("local-pi"), undefined);
  // The old snapshot is a valid, self-consistent registry, not a husk.
  assert.equal(before.get("local-pi")?.available, true);
});

test("an invalid replacement throws and leaves the previous snapshot serving", () => {
  const registry = createReplaceableCoachingRuntimeRegistry([available("local-pi")]);
  const before = registry.current();

  assert.throws(
    () =>
      registry.replace([
        available("local-codex"),
        // Duplicate backend id: same backend registered twice.
        available("local-codex"),
      ]),
    /duplicate coaching backend local-codex/,
  );

  // A backend/runtime mismatch must be rejected for the same reason: it would
  // otherwise let a submission name a backend and launch a different engine.
  assert.throws(
    () => registry.replace([available("local-codex", { runtimeId: "pi" })]),
    /backend local-codex requires runtime codex/,
  );

  // An unavailable backend without a reason is not truthful discovery.
  assert.throws(
    () =>
      registry.replace([
        {
          backendId: "local-opencode",
          runtimeId: "opencode",
          executionLocation: "local",
          displayName: "OpenCode CLI (local)",
          available: false,
        },
      ]),
    /must state a reason/,
  );

  // After every rejected update the previous contents are still what readers
  // get: a failed probe must never disable a backend that was serving.
  assert.equal(registry.current(), before, "a rejected replace must not swap the snapshot");
  assert.deepEqual(registry.list().map((entry) => entry.backendId), ["local-pi"]);
  assert.equal(registry.get("local-pi")?.available, true);
});

test("replace with an empty list leaves an empty registry without throwing", () => {
  const registry = createReplaceableCoachingRuntimeRegistry([
    available("local-pi"),
    unavailable("local-codex", "codex CLI is not available on PATH."),
  ]);
  registry.replace([]);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get("local-pi"), undefined);
  assert.equal(registry.get("local-codex"), undefined);
  assert.deepEqual(registry.current().list(), []);
});

test("current() reflects the latest replacement", () => {
  const registry = createReplaceableCoachingRuntimeRegistry([]);
  assert.deepEqual(registry.current().list(), []);

  registry.replace([available("local-pi")]);
  assert.deepEqual(registry.current().list().map((entry) => entry.backendId), ["local-pi"]);

  registry.replace([available("local-pi"), available("local-codex")]);
  assert.deepEqual(
    registry.current().list().map((entry) => entry.backendId),
    ["local-pi", "local-codex"],
  );

  registry.replace([]);
  assert.deepEqual(registry.current().list(), []);
});

test("a replaced snapshot is frozen like the immutable registry", () => {
  // Registrations are copied and frozen at build time; a caller holding a
  // reference from `list()` must not be able to flip availability at runtime.
  const source = available("local-pi");
  const registry = createReplaceableCoachingRuntimeRegistry([source]);
  const listed = registry.list()[0];
  assert.ok(listed !== undefined);
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(listed, registry.get("local-pi"));

  // Mutating the SOURCE object after construction cannot reach the snapshot.
  source.available = false;
  assert.equal(registry.get("local-pi")?.available, true);
});

test("the immutable registry and the replaceable one agree on validation", () => {
  // Same rejection surface, so callers can swap one for the other without
  // changing which wiring bugs are caught.
  assert.throws(
    () => createCoachingRuntimeRegistry([available("local-pi"), available("local-pi")]),
    /duplicate coaching backend local-pi/,
  );
  assert.throws(
    () => createReplaceableCoachingRuntimeRegistry([available("local-pi"), available("local-pi")]),
    /duplicate coaching backend local-pi/,
  );
});
