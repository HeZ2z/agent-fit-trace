import assert from "node:assert/strict";
import { test } from "node:test";

import { CURRENT_SCHEMA_VERSION } from "@pi-fit-trace/core";
import type { LogFormDraft } from "../mobile/src/data/logModel.ts";
import {
  LOG_DRAFT_ID,
  buildWorkoutRecord,
  createLogDraft,
  parseOptionalNumber,
  toSaveInput,
  todayLocalDate,
  validateLogDraft,
} from "../mobile/src/data/logModel.ts";

/**
 * Pure coverage for the Log form model. The screen and the SQLite repository
 * are intentionally not imported: only the dependency-free draft builder and
 * core-validator bridge are exercised, so the root `node:test` suite never
 * needs a native runtime.
 */

function filledDraft(overrides: Partial<LogFormDraft> = {}): LogFormDraft {
  return {
    ...createLogDraft("2026-09-01"),
    exercises: [{ name: "Back squat", sets: [{ reps: "5", weight: "100", rpe: "8" }] }],
    ...overrides,
  };
}

function issueCodes(draft: LogFormDraft): string[] {
  const result = validateLogDraft(draft);
  assert.equal(result.ok, false, "expected the draft to be rejected");
  if (result.ok) throw new Error("unreachable");
  return result.issues.map((issue) => issue.code).sort();
}

test("createLogDraft starts with a blank strength session and one empty set", () => {
  const draft = createLogDraft("2026-09-01");

  assert.equal(draft.date, "2026-09-01");
  assert.equal(draft.sessionType, "strength");
  assert.deepEqual(draft.exercises, [{ name: "", sets: [{ reps: "", weight: "", rpe: "" }] }]);
  assert.equal(draft.notes, "");
  assert.equal(draft.painArea, "");
  assert.equal(draft.painLevel, "");
  assert.equal(draft.exercises[0]?.sets.length, 1);
});

test("todayLocalDate renders the device-local calendar date with zero padding", () => {
  assert.equal(todayLocalDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(todayLocalDate(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
  assert.equal(todayLocalDate(new Date(2026, 8, 9, 12, 0)), "2026-09-09");
});

test("parseOptionalNumber treats blank input as absent and leaves invalid text visible", () => {
  assert.equal(parseOptionalNumber(""), undefined);
  assert.equal(parseOptionalNumber("   "), undefined);
  assert.equal(parseOptionalNumber(" 102.5 "), 102.5);
  assert.equal(parseOptionalNumber("0"), 0);
  assert.ok(Number.isNaN(parseOptionalNumber("abc")));
});

test("buildWorkoutRecord converts numeric strings and optional content", () => {
  const record = buildWorkoutRecord({
    date: "2026-09-01",
    sessionType: "strength",
    exercises: [
      {
        name: "Back squat",
        sets: [
          { reps: "5", weight: "102.5", rpe: "8.5" },
          { reps: "10", weight: "", rpe: "" },
        ],
      },
    ],
    notes: "  felt strong  ",
    painArea: " knee ",
    painLevel: "3",
  });

  assert.equal(record.id, LOG_DRAFT_ID);
  assert.equal(record.schema_version, CURRENT_SCHEMA_VERSION);
  assert.equal(record.date, "2026-09-01");
  assert.equal(record.session_type, "strength");
  assert.deepEqual(record.exercises, [
    {
      name: "Back squat",
      sets: [
        { reps: 5, weight: 102.5, rpe: 8.5 },
        { reps: 10 },
      ],
    },
  ]);
  assert.equal(record.notes, "felt strong");
  assert.deepEqual(record.pain, [{ area: "knee", level: 3 }]);
});

test("buildWorkoutRecord omits blank optional fields", () => {
  const record = buildWorkoutRecord(
    filledDraft({
      exercises: [{ name: "Pull-up", sets: [{ reps: "8", weight: "", rpe: "" }] }],
      notes: "   ",
      painArea: " ",
      painLevel: "",
    }),
  );

  assert.deepEqual(record.exercises, [{ name: "Pull-up", sets: [{ reps: 8 }] }]);
  assert.ok(!("notes" in record), "blank notes are omitted");
  assert.ok(!("pain" in record), "blank pain is omitted");
});

test("pain keeps only the fields the user filled in", () => {
  assert.deepEqual(buildWorkoutRecord(filledDraft({ painArea: "shoulder" })).pain, [
    { area: "shoulder" },
  ]);
  assert.deepEqual(buildWorkoutRecord(filledDraft({ painLevel: "4" })).pain, [{ level: 4 }]);
  assert.ok(!("pain" in buildWorkoutRecord(filledDraft())));
});

test("validateLogDraft accepts a complete draft and normalizes it through the core", () => {
  const result = validateLogDraft(
    filledDraft({
      exercises: [
        {
          name: "  Back squat  ",
          sets: [
            { reps: "5", weight: "100", rpe: "8" },
            { reps: "5", weight: "100", rpe: "" },
          ],
        },
      ],
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected the draft to validate");
  assert.equal(result.record.id, LOG_DRAFT_ID);
  assert.equal(result.record.exercises[0]?.name, "Back squat");
  assert.deepEqual(result.warnings, []);
  assert.ok(!("notes" in result.record));
});

test("validateLogDraft reports missing exercise names before set contents", () => {
  assert.deepEqual(issueCodes(createLogDraft("2026-09-01")), ["MISSING_EXERCISE_NAME"]);
});

test("validateLogDraft rejects missing and malformed set values", () => {
  const set = (reps: string, weight: string, rpe: string) =>
    filledDraft({
      exercises: [{ name: "Deadlift", sets: [{ reps, weight, rpe }] }],
    });

  assert.deepEqual(issueCodes(set("", "", "")), ["INVALID_REPS"]);

  const missingReps = validateLogDraft(set("", "", ""));
  if (missingReps.ok) throw new Error("expected missing reps to fail");
  assert.equal(missingReps.issues[0]?.path, "exercises[0].sets[0].reps");

  assert.deepEqual(issueCodes(set("5", "-2", "")), ["INVALID_WEIGHT"]);
  assert.deepEqual(issueCodes(set("5", "abc", "")), ["INVALID_WEIGHT"]);
  assert.deepEqual(issueCodes(set("5", "100", "11")), ["INVALID_RPE"]);
  assert.deepEqual(issueCodes(set("5", "100", "0")), ["INVALID_RPE"]);
  assert.deepEqual(issueCodes(set("abc", "100", "8")), ["INVALID_REPS"]);
});

test("validateLogDraft rejects invalid dates and session pain levels", () => {
  assert.deepEqual(issueCodes(filledDraft({ date: "09/01/2026" })), ["INVALID_DATE"]);
  assert.deepEqual(issueCodes(filledDraft({ date: "2026-02-30" })), ["INVALID_DATE"]);
  assert.deepEqual(issueCodes(filledDraft({ painLevel: "11" })), ["INVALID_PAIN_LEVEL"]);
});

test("validateLogDraft returns warnings for accepted-but-suspicious values", () => {
  const result = validateLogDraft(
    filledDraft({
      exercises: [
        {
          name: "Deadlift",
          sets: [
            { reps: "0", weight: "", rpe: "" },
            { reps: "5", weight: "0", rpe: "" },
          ],
        },
      ],
    }),
  );

  assert.equal(result.ok, true, "warnings must not block validation");
  if (!result.ok) throw new Error("expected warnings to be accepted");
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["ZERO_REPS", "ZERO_WEIGHT"],
  );
});

test("toSaveInput drops the placeholder id so the repository derives a content id", () => {
  const result = validateLogDraft(filledDraft());
  if (!result.ok) throw new Error("expected the draft to validate");

  const saveInput = toSaveInput(result.record);
  assert.equal(saveInput.id, "");
  assert.deepEqual({ ...saveInput, id: result.record.id }, result.record);
  assert.notEqual(saveInput, result.record);
});
