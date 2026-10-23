import assert from "node:assert/strict";
import { test } from "node:test";

import { stableStringify } from "@agent-fit-trace/core";
import {
  CORRUPT_SESSION_DRAFT,
  SessionDraftCorruptionError,
  createSessionDraft,
  decodeSessionDraft,
  encodeSessionDraft,
  validateSessionDraft,
} from "../packages/fit-trace-workout-session/src/index.ts";
import type { SessionDraft } from "../packages/fit-trace-workout-session/src/index.ts";

/**
 * Persistence is strict about structure but permissive about editability.
 *
 * These tests prove the draft payload round-trips (including an invalid
 * mid-edit draft), never carries runtime/rest state, and fails closed with a
 * typed error instead of migrating or silently repairing anything.
 */

const DATE = "2026-10-23";

function timedDraft(): SessionDraft {
  return {
    ...createSessionDraft(DATE),
    timing: {
      startedAtMs: 1_000,
      endedAtMs: null,
      pausedAtMs: null,
      pausedTotalMs: 0,
      lastActiveAtMs: 1_000,
    },
  };
}

function parsePayload(source: SessionDraft = createSessionDraft(DATE)): Record<string, unknown> {
  return JSON.parse(encodeSessionDraft(source)) as Record<string, unknown>;
}

function payloadWith(
  mutate: (root: Record<string, unknown>) => void,
  source: SessionDraft = createSessionDraft(DATE),
): string {
  const root = parsePayload(source);
  mutate(root);
  return JSON.stringify(root);
}

function firstExercise(root: Record<string, unknown>): Record<string, unknown> {
  return (root.exercises as Record<string, unknown>[])[0];
}

function firstSet(root: Record<string, unknown>): Record<string, unknown> {
  return (firstExercise(root).sets as Record<string, unknown>[])[0];
}

function assertCorrupt(payload: string, pattern?: RegExp): void {
  assert.throws(
    () => decodeSessionDraft(payload),
    (error: unknown) => {
      assert.ok(error instanceof SessionDraftCorruptionError, "throws a typed corruption error");
      assert.equal(error.name, "SessionDraftCorruptionError");
      assert.equal(error.code, CORRUPT_SESSION_DRAFT);
      if (pattern !== undefined) assert.match(error.message, pattern);
      return true;
    },
  );
}

test("round-trips a freshly created draft as canonical JSON", () => {
  const draft = createSessionDraft(DATE);
  const payload = encodeSessionDraft(draft);

  assert.equal(payload, stableStringify(draft), "encoding uses core canonical JSON");
  assert.deepEqual(decodeSessionDraft(payload), draft);
  assert.equal(encodeSessionDraft(decodeSessionDraft(payload)), payload, "re-encode is stable");
});

test("restores an invalid mid-edit draft without core validation", () => {
  const midEdit: SessionDraft = {
    ...createSessionDraft(""),
    date: "",
    durationMinutes: "forty-five",
    sleepHours: "??",
    notes: "  halfway through typing  ",
    exercises: [
      {
        key: 1,
        name: "",
        restSeconds: 90,
        sets: [{ key: 2, reps: "", weight: "abc", rpe: "-", done: false, prefilled: true }],
      },
    ],
    pain: [{ key: 3, area: " knee ", level: "?" }],
    timing: {
      startedAtMs: 1_000,
      endedAtMs: null,
      pausedAtMs: 2_000,
      pausedTotalMs: 1_000,
      lastActiveAtMs: 2_000,
    },
  };

  const restored = decodeSessionDraft(encodeSessionDraft(midEdit));
  assert.deepEqual(restored, midEdit, "in-progress input is preserved verbatim");

  // The core still rejects it; persistence recovery and save validation stay
  // independent concerns.
  const validation = validateSessionDraft(restored, 2_000);
  assert.equal(validation.ok, false);
});

test("serializes the draft only, never runtime or rest state", () => {
  const payload = encodeSessionDraft(createSessionDraft(DATE));
  const parsed = JSON.parse(payload) as Record<string, unknown>;

  assert.deepEqual(Object.keys(parsed).sort(), [
    "date",
    "durationMinutes",
    "exercises",
    "notes",
    "pain",
    "sessionType",
    "sleepHours",
    "timing",
    "version",
  ]);
  assert.equal(payload.includes('"rest"'), false);

  // Runtime state injected by a buggy caller is rejected, not silently dropped.
  assertCorrupt(JSON.stringify({ ...parsed, rest: { durationMs: 90_000 } }), /unknown field/);
});

test("fails closed on unsupported or missing versions", () => {
  assertCorrupt(payloadWith((root) => { root.version = 2; }), /version 2/);
  assertCorrupt(payloadWith((root) => { root.version = "1"; }), /version/);
  assertCorrupt(payloadWith((root) => { delete root.version; }), /version/);
});

test("throws a typed corruption error for malformed JSON", () => {
  assertCorrupt("{not json", /JSON/);
  assertCorrupt("", /JSON/);
  assertCorrupt("null", /payload/);
  assertCorrupt("[]", /payload/);
});

test("rejects wrong field types", () => {
  const cases: Array<[(root: Record<string, unknown>) => void, RegExp]> = [
    [(root) => { root.date = 20_261_023; }, /date/],
    [(root) => { root.sessionType = "yoga"; }, /sessionType/],
    [(root) => { root.durationMinutes = 45; }, /durationMinutes/],
    [(root) => { root.sleepHours = null; }, /sleepHours/],
    [(root) => { root.notes = 7; }, /notes/],
    [(root) => { root.exercises = {}; }, /exercises/],
    [(root) => { root.pain = {}; }, /pain/],
    [(root) => { root.timing = "active"; }, /timing/],
    [(root) => { firstExercise(root).key = "1"; }, /key/],
    [(root) => { firstExercise(root).name = 1; }, /name/],
    [(root) => { firstExercise(root).restSeconds = -1; }, /restSeconds/],
    [(root) => { firstExercise(root).restSeconds = 1.5; }, /restSeconds/],
    [(root) => { firstSet(root).key = "2"; }, /key/],
    [(root) => { firstSet(root).reps = 5; }, /reps/],
    [(root) => { firstSet(root).weight = 80; }, /weight/],
    [(root) => { firstSet(root).rpe = 8; }, /rpe/],
    [(root) => { firstSet(root).done = "yes"; }, /done/],
    [(root) => { firstSet(root).prefilled = "yes"; }, /prefilled/],
    [(root) => { (root.pain as unknown[]).push({ key: 99, area: 1, level: "" }); }, /area/],
  ];

  for (const [mutate, pattern] of cases) {
    assertCorrupt(payloadWith(mutate), pattern);
  }
});

test("rejects duplicate keys across exercises, sets and pain", () => {
  assertCorrupt(
    payloadWith((root) => {
      const sets = firstExercise(root).sets as Record<string, unknown>[];
      sets.push({ ...firstSet(root) });
    }),
    /duplicate key/,
  );

  assertCorrupt(
    payloadWith((root) => {
      (root.exercises as Record<string, unknown>[]).push({ ...firstExercise(root) });
    }),
    /duplicate key/,
  );

  assertCorrupt(
    payloadWith((root) => {
      (root.pain as Record<string, unknown>[]).push({
        key: firstSet(root).key,
        area: "",
        level: "",
      });
    }),
    /duplicate key/,
  );
});

test("rejects inconsistent timing payloads", () => {
  assertCorrupt(
    payloadWith((root) => {
      const timing = root.timing as Record<string, unknown>;
      timing.endedAtMs = 5_000;
      timing.pausedAtMs = 1_000;
    }, timedDraft()),
    /timing/,
  );

  assertCorrupt(
    payloadWith((root) => {
      (root.timing as Record<string, unknown>).pausedTotalMs = -1;
    }, timedDraft()),
    /pausedTotalMs/,
  );

  assertCorrupt(
    payloadWith((root) => {
      (root.timing as Record<string, unknown>).startedAtMs = "1000";
    }, timedDraft()),
    /startedAtMs/,
  );
});

test("rejects unknown fields at every level, including rest", () => {
  assertCorrupt(payloadWith((root) => { root.runtime = null; }), /unknown field/);
  assertCorrupt(payloadWith((root) => { root.rest = null; }), /unknown field/);
  assertCorrupt(payloadWith((root) => { firstExercise(root).nextKey = 1; }), /unknown field/);
  assertCorrupt(payloadWith((root) => { firstSet(root).rest = null; }), /unknown field/);
  assertCorrupt(
    payloadWith((root) => {
      (root.timing as Record<string, unknown>).rest = null;
    }, timedDraft()),
    /unknown field/,
  );
  assertCorrupt(
    payloadWith((root) => {
      (root.pain as Record<string, unknown>[]).push({
        key: 3,
        area: "",
        level: "",
        note: "x",
      });
    }),
    /unknown field/,
  );
});

test("rejects payloads with missing required fields", () => {
  assertCorrupt(payloadWith((root) => { delete root.notes; }), /missing field/);
  assertCorrupt(payloadWith((root) => { delete root.timing; }), /missing field/);
  assertCorrupt(payloadWith((root) => { delete firstExercise(root).name; }), /missing field/);
  assertCorrupt(payloadWith((root) => { delete firstSet(root).done; }), /missing field/);
  assertCorrupt(payloadWith((root) => { delete firstSet(root).prefilled; }), /missing field/);
});

test("accepts untimed, active, paused and finished timing states", () => {
  const untimed = createSessionDraft(DATE);
  const active = timedDraft();
  const paused: SessionDraft = {
    ...timedDraft(),
    timing: {
      startedAtMs: 1_000,
      endedAtMs: null,
      pausedAtMs: 5_000,
      pausedTotalMs: 0,
      lastActiveAtMs: 5_000,
    },
  };
  const finished: SessionDraft = {
    ...timedDraft(),
    timing: {
      startedAtMs: 1_000,
      endedAtMs: 9_000,
      pausedAtMs: null,
      pausedTotalMs: 4_000,
      lastActiveAtMs: 9_000,
    },
  };

  for (const draft of [untimed, active, paused, finished]) {
    assert.deepEqual(decodeSessionDraft(encodeSessionDraft(draft)), draft);
  }
});

test("corruption errors carry the stable code and message", () => {
  try {
    decodeSessionDraft("{not json");
    assert.fail("expected a corruption error");
  } catch (error) {
    assert.ok(error instanceof SessionDraftCorruptionError);
    assert.equal(error.name, "SessionDraftCorruptionError");
    assert.equal(error.code, "CORRUPT_DRAFT");
    assert.match(error.message, /Corrupt session draft/);
  }
});
