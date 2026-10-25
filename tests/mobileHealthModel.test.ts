import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  aggregateSleepHours,
  createSingleFlightInit,
  evaluatePermissionGrant,
  formatSleepHours,
  healthConnectStatusKey,
  importUnavailableReason,
  isIsoDate,
  mapHealthConnectStatus,
  nightWindowFor,
  parseStoredHealthConnectEnabled,
  SLEEP_STAGE,
  SDK_AVAILABILITY_STATUS,
  type SleepSessionLike,
} from "../mobile/src/health/healthModel.ts";
import {
  HEALTH_CONNECT_STORAGE_KEY,
  parseStoredHealthConnectEnabled as parseDeviceToggle,
} from "../mobile/src/preferences/deviceHealth.ts";

/**
 * Pure coverage for the Health Connect sleep import. Only the pure functions of
 * `mobile/src/health/healthModel.ts` and `mobile/src/preferences/deviceHealth.ts`
 * are imported — no React, React Native, native module or storage backend runs
 * here, so the root `node:test` suite never needs an Android device. The thin
 * native adapter (`healthConnect.ts`) is deliberately never imported.
 */

/** Session builder: instants are UTC ISO strings, as Health Connect returns. */
function session(
  start: string,
  end: string,
  stages?: Array<{ stage: number; start: string; end: string }>,
): SleepSessionLike {
  return { start, end, ...(stages ? { stages } : {}) };
}

/* ── native-import guard ─────────────────────────────────────────── */

test("healthModel.ts stays free of native/platform dependencies", () => {
  // The pure layer is loaded by the root node:test suite through type
  // stripping; a single native import here would break that. Guard the source
  // text so the dependency cannot creep back in unnoticed. Word boundaries are
  // required: the substring "expo" occurs in every "export" keyword.
  const source = readFileSync(
    new URL("../mobile/src/health/healthModel.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!/\breact-native-health-connect\b/.test(source));
  assert.ok(!/\bexpo\b/.test(source));
});

/* ── SDK status mapping ──────────────────────────────────────────── */

test("createSingleFlightInit runs one initialize for concurrent and later callers", async () => {
  let calls = 0;
  const guard = createSingleFlightInit(async () => {
    calls += 1;
    await Promise.resolve(); // simulate the native round-trip
  });
  // Concurrent callers share the in-flight promise: one native initialize.
  await Promise.all([guard(), guard(), guard()]);
  assert.equal(calls, 1);
  // A caller after success reuses the cached result; initialize is not re-run.
  await guard();
  assert.equal(calls, 1);
});

test("createSingleFlightInit retries after a failed initialize instead of caching it", async () => {
  let calls = 0;
  const guard = createSingleFlightInit(async () => {
    calls += 1;
    await Promise.resolve();
    if (calls === 1) throw new Error("client not initialized");
  });
  await assert.rejects(guard(), /client not initialized/);
  // The rejection is not cached: the next caller retries from scratch.
  await guard();
  assert.equal(calls, 2);
});

test("createSingleFlightInit surfaces one failure to every concurrent caller and recovers", async () => {
  let calls = 0;
  const guard = createSingleFlightInit(async () => {
    calls += 1;
    await Promise.resolve();
    if (calls === 1) throw new Error("first attempt fails");
  });
  const results = await Promise.allSettled([guard(), guard(), guard()]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected", "rejected"],
  );
  assert.equal(calls, 1); // one shared attempt, not one per caller
  // The retry after the shared failure is single-flight again.
  await Promise.all([guard(), guard()]);
  assert.equal(calls, 2);
});


test("mapHealthConnectStatus maps every SDK status", () => {
  assert.deepEqual(mapHealthConnectStatus(SDK_AVAILABILITY_STATUS.SDK_AVAILABLE), {
    kind: "supported",
  });
  assert.deepEqual(mapHealthConnectStatus(SDK_AVAILABILITY_STATUS.SDK_UNAVAILABLE), {
    kind: "needs-install",
  });
  assert.deepEqual(
    mapHealthConnectStatus(SDK_AVAILABILITY_STATUS.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED),
    { kind: "needs-update" },
  );
  // Unknown status numbers degrade to a neutral "not found", never a throw.
  assert.deepEqual(mapHealthConnectStatus(0), { kind: "unavailable", reason: "not-found" });
  assert.deepEqual(mapHealthConnectStatus(99), { kind: "unavailable", reason: "not-found" });
});

test("importUnavailableReason carries install/update reasons into import results", () => {
  assert.equal(importUnavailableReason({ kind: "needs-install" }), "needs-install");
  assert.equal(importUnavailableReason({ kind: "needs-update" }), "needs-update");
  assert.equal(importUnavailableReason({ kind: "unavailable", reason: "platform" }), "platform");
  assert.equal(importUnavailableReason({ kind: "unavailable", reason: "not-found" }), "not-found");
});

/* ── granular permissions ────────────────────────────────────────── */

test("sleep granted and resting heart rate denied is partial with the right split", () => {
  const grant = evaluatePermissionGrant(
    ["SleepSession", "RestingHeartRate"],
    ["SleepSession"],
  );
  assert.deepEqual(grant, { granted: ["SleepSession"], missing: ["RestingHeartRate"] });
  // The Me status line projects the same split as the partial-permission state.
  assert.equal(healthConnectStatusKey(true, { kind: "supported" }, grant), "partial");
});

test("permission grants are recorded per scope, not as one blob", () => {
  assert.deepEqual(evaluatePermissionGrant(["SleepSession", "RestingHeartRate"], []), {
    granted: [],
    missing: ["SleepSession", "RestingHeartRate"],
  });
  assert.deepEqual(evaluatePermissionGrant(["SleepSession", "RestingHeartRate"], ["RestingHeartRate"]), {
    granted: ["RestingHeartRate"],
    missing: ["SleepSession"],
  });
  assert.deepEqual(
    evaluatePermissionGrant(["SleepSession", "RestingHeartRate"], [
      "SleepSession",
      "RestingHeartRate",
    ]),
    { granted: ["SleepSession", "RestingHeartRate"], missing: [] },
  );
  // Unknown granted scopes are not echoed as granted.
  assert.deepEqual(evaluatePermissionGrant(["SleepSession"], ["Steps"]), {
    granted: [],
    missing: ["SleepSession"],
  });
});

/* ── calendar-safe window math ───────────────────────────────────── */

test("isIsoDate accepts only real YYYY-MM-DD calendar dates", () => {
  assert.equal(isIsoDate("2024-02-29"), true); // leap day
  assert.equal(isIsoDate("2026-02-29"), false); // 2026 is not a leap year
  assert.equal(isIsoDate("2026-03-01"), true);
  assert.equal(isIsoDate("2024-2-15"), false); // unpadded
  assert.equal(isIsoDate("2024-13-01"), false); // month overflow
  assert.equal(isIsoDate("2024-05"), false);
  assert.equal(isIsoDate("15/05/2024"), false);
  assert.equal(isIsoDate(""), false);
});

test("nightWindowFor bridges the 2024 leap day and its neighbours", () => {
  // The leap day itself: local [Feb 28 20:00, Feb 29 12:00] (UTC, offset 0).
  assert.deepEqual(nightWindowFor("2024-02-29", 0), {
    startMs: Date.UTC(2024, 1, 28, 20, 0),
    endMs: Date.UTC(2024, 1, 29, 12, 0),
  });
  // D-1 of 2024-03-01 is the leap day 2024-02-29.
  assert.deepEqual(nightWindowFor("2024-03-01", 0), {
    startMs: Date.UTC(2024, 1, 29, 20, 0),
    endMs: Date.UTC(2024, 2, 1, 12, 0),
  });
});

test("nightWindowFor handles the non-leap 2026-02-28 → 2026-03-01 rollover", () => {
  // D-1 of 2026-03-01 is 2026-02-28 (2026 is not a leap year).
  assert.deepEqual(nightWindowFor("2026-03-01", 0), {
    startMs: Date.UTC(2026, 1, 28, 20, 0),
    endMs: Date.UTC(2026, 2, 1, 12, 0),
  });
});

test("nightWindowFor handles the year rollover and rejects malformed dates", () => {
  // Local [Dec 31 20:00, Jan 1 12:00] across the year boundary (UTC+1).
  assert.deepEqual(nightWindowFor("2024-01-01", 60), {
    startMs: Date.UTC(2023, 11, 31, 19, 0),
    endMs: Date.UTC(2024, 0, 1, 11, 0),
  });
  assert.equal(nightWindowFor("2026-13-01", 0), null);
  assert.equal(nightWindowFor("not-a-date", 0), null);
});

/* ── aggregation rules ───────────────────────────────────────────── */

test("aggregateSleepHours sums valid stages and excludes AWAKE/OUT_OF_BED", () => {
  // Window in UTC: [2024-05-14T20:00, 2024-05-15T12:00].
  assert.deepEqual(
    aggregateSleepHours(
      [
        session("2024-05-14T22:00:00.000Z", "2024-05-15T06:30:00.000Z", [
          { stage: SLEEP_STAGE.LIGHT, start: "2024-05-14T22:00:00.000Z", end: "2024-05-14T23:00:00.000Z" },
          { stage: SLEEP_STAGE.DEEP, start: "2024-05-14T23:00:00.000Z", end: "2024-05-15T01:00:00.000Z" },
          { stage: SLEEP_STAGE.REM, start: "2024-05-15T01:00:00.000Z", end: "2024-05-15T02:30:00.000Z" },
          { stage: SLEEP_STAGE.AWAKE, start: "2024-05-15T02:30:00.000Z", end: "2024-05-15T02:45:00.000Z" },
          { stage: SLEEP_STAGE.LIGHT, start: "2024-05-15T02:45:00.000Z", end: "2024-05-15T06:30:00.000Z" },
        ]),
      ],
      "2024-05-15",
      0,
    ),
    { kind: "ok", hoursText: "8.3", totalMinutes: 495, sessionCount: 1 },
  );
});

test("aggregateSleepHours counts UNKNOWN and skips OUT_OF_BED by the documented rule", () => {
  // UNKNOWN (0) counts; OUT_OF_BED (3) does not.
  assert.deepEqual(
    aggregateSleepHours(
      [
        session("2024-05-14T23:00:00.000Z", "2024-05-15T03:00:00.000Z", [
          { stage: SLEEP_STAGE.UNKNOWN, start: "2024-05-14T23:00:00.000Z", end: "2024-05-15T01:00:00.000Z" },
          { stage: SLEEP_STAGE.OUT_OF_BED, start: "2024-05-15T01:00:00.000Z", end: "2024-05-15T03:00:00.000Z" },
        ]),
      ],
      "2024-05-15",
      0,
    ),
    { kind: "ok", hoursText: "2.0", totalMinutes: 120, sessionCount: 1 },
  );
});

test("aggregateSleepHours sums every session of a fragmented night", () => {
  assert.deepEqual(
    aggregateSleepHours(
      [
        session("2024-05-14T22:00:00.000Z", "2024-05-15T01:00:00.000Z"),
        session("2024-05-15T02:00:00.000Z", "2024-05-15T06:00:00.000Z"),
      ],
      "2024-05-15",
      0,
    ),
    { kind: "ok", hoursText: "7.0", totalMinutes: 420, sessionCount: 2 },
  );
});

test("aggregateSleepHours falls back to session duration without stages", () => {
  assert.deepEqual(
    aggregateSleepHours([session("2024-05-14T23:00:00.000Z", "2024-05-15T07:00:00.000Z")], "2024-05-15", 0),
    { kind: "ok", hoursText: "8.0", totalMinutes: 480, sessionCount: 1 },
  );
});

test("aggregateSleepHours aggregates a session on the 2024 leap day", () => {
  assert.deepEqual(
    aggregateSleepHours(
      [session("2024-02-28T21:00:00.000Z", "2024-02-29T05:00:00.000Z")],
      "2024-02-29",
      0,
    ),
    { kind: "ok", hoursText: "8.0", totalMinutes: 480, sessionCount: 1 },
  );
});

test("aggregateSleepHours aggregates across the 2026-02-28 → 2026-03-01 rollover", () => {
  assert.deepEqual(
    aggregateSleepHours(
      [session("2026-02-28T21:00:00.000Z", "2026-03-01T02:00:00.000Z")],
      "2026-03-01",
      0,
    ),
    { kind: "ok", hoursText: "5.0", totalMinutes: 300, sessionCount: 1 },
  );
});

test("aggregateSleepHours converts UTC records through a non-zero device offset", () => {
  // UTC+8, workout date 2026-03-01: the local window
  // [Feb 28 20:00, Mar 1 12:00] is UTC [Feb 28 12:00, Mar 1 04:00].
  assert.deepEqual(
    aggregateSleepHours(
      [session("2026-02-28T14:00:00.000Z", "2026-02-28T22:00:00.000Z")],
      "2026-03-01",
      480,
    ),
    { kind: "ok", hoursText: "8.0", totalMinutes: 480, sessionCount: 1 },
  );
  // Ends at local 18:00 — before the D-1 20:00 window opens → excluded.
  assert.equal(
    aggregateSleepHours(
      [session("2026-02-28T04:00:00.000Z", "2026-02-28T10:00:00.000Z")],
      "2026-03-01",
      480,
    ).kind,
    "no-data",
  );
  // Starts at local 13:00 — after the D 12:00 window closes → excluded.
  assert.equal(
    aggregateSleepHours(
      [session("2026-03-01T05:00:00.000Z", "2026-03-01T09:00:00.000Z")],
      "2026-03-01",
      480,
    ).kind,
    "no-data",
  );
});

test("aggregateSleepHours treats the window as half-open at both boundaries", () => {
  // A session ending exactly when the window opens contributes nothing.
  assert.equal(
    aggregateSleepHours(
      [session("2026-02-28T08:00:00.000Z", "2026-02-28T12:00:00.000Z")],
      "2026-03-01",
      480,
    ).kind,
    "no-data",
  );
  // A session starting exactly when the window closes contributes nothing.
  assert.equal(
    aggregateSleepHours(
      [session("2026-03-01T04:00:00.000Z", "2026-03-01T08:00:00.000Z")],
      "2026-03-01",
      480,
    ).kind,
    "no-data",
  );
});

test("aggregateSleepHours clips partially overlapping sessions to the window", () => {
  assert.deepEqual(
    aggregateSleepHours(
      [
        session("2024-05-14T18:00:00.000Z", "2024-05-14T22:00:00.000Z"), // → 2 h
        session("2024-05-15T06:00:00.000Z", "2024-05-15T14:00:00.000Z"), // → 6 h
      ],
      "2024-05-15",
      0,
    ),
    { kind: "ok", hoursText: "8.0", totalMinutes: 480, sessionCount: 2 },
  );
});

test("aggregateSleepHours converts negative-offset (UTC-5) records", () => {
  // UTC-5: the local window is UTC [May 15 01:00, May 15 17:00].
  assert.deepEqual(
    aggregateSleepHours(
      [session("2024-05-15T02:00:00.000Z", "2024-05-15T10:00:00.000Z")],
      "2024-05-15",
      -300,
    ),
    { kind: "ok", hoursText: "8.0", totalMinutes: 480, sessionCount: 1 },
  );
});

test("aggregateSleepHours rejects totals beyond the core 24 h limit", () => {
  // Three overlapping 9 h readings (duplicate data origins) sum to 27 h.
  const result = aggregateSleepHours(
    [
      session("2024-05-14T21:00:00.000Z", "2024-05-15T06:00:00.000Z"),
      session("2024-05-14T21:30:00.000Z", "2024-05-15T06:30:00.000Z"),
      session("2024-05-14T22:00:00.000Z", "2024-05-15T07:00:00.000Z"),
    ],
    "2024-05-15",
    0,
  );
  assert.equal(result.kind, "error");
  assert.ok(result.kind === "error" && /24 h/.test(result.message));

  // Exactly 24 h (two duplicate 12 h readings) stays inside the domain limit.
  const exact = aggregateSleepHours(
    [
      session("2024-05-14T20:00:00.000Z", "2024-05-15T08:00:00.000Z"),
      session("2024-05-14T20:00:00.000Z", "2024-05-15T08:00:00.000Z"),
    ],
    "2024-05-15",
    0,
  );
  assert.ok(exact.kind === "ok" && exact.hoursText === "24.0");
});

test("aggregateSleepHours reports no-data and errors for degenerate input", () => {
  assert.equal(
    aggregateSleepHours([session("2024-05-14T22:00:00.000Z", "2024-05-15T06:00:00.000Z")], "2024-05-16", 0).kind,
    "no-data",
  );
  assert.equal(aggregateSleepHours([], "2024-05-15", 0).kind, "no-data");
  // Inverted/malformed sessions are skipped, not fatal.
  assert.equal(
    aggregateSleepHours([session("2024-05-15T06:00:00.000Z", "2024-05-14T22:00:00.000Z")], "2024-05-15", 0).kind,
    "no-data",
  );
  // Malformed workout dates are an error, not a crash.
  assert.ok(aggregateSleepHours([], "2024-05", 0).kind === "error");
});

test("aggregateSleepHours handles a real Health Connect SleepSessionRecord shape", () => {
  // Mirrors a SleepSessionRecord exactly as the SDK returns it (UTC ISO with
  // millisecond precision, numeric stage codes).
  const record = {
    recordType: "SleepSession",
    startTime: "2024-05-14T22:10:30.000Z",
    endTime: "2024-05-15T06:40:15.123Z",
    stages: [
      { startTime: "2024-05-14T22:10:30.000Z", endTime: "2024-05-14T23:40:30.000Z", stage: 4 },
      { startTime: "2024-05-14T23:40:30.000Z", endTime: "2024-05-15T01:10:30.000Z", stage: 5 },
      { startTime: "2024-05-15T01:10:30.000Z", endTime: "2024-05-15T02:40:30.000Z", stage: 6 },
      { startTime: "2024-05-15T02:40:30.000Z", endTime: "2024-05-15T02:55:30.000Z", stage: 1 },
      { startTime: "2024-05-15T02:55:30.000Z", endTime: "2024-05-15T06:40:15.123Z", stage: 4 },
    ],
  };
  assert.deepEqual(
    aggregateSleepHours(
      [
        {
          start: record.startTime,
          end: record.endTime,
          stages: record.stages.map((s) => ({ stage: s.stage, start: s.startTime, end: s.endTime })),
        },
      ],
      "2024-05-15",
      0,
    ),
    { kind: "ok", hoursText: "8.3", totalMinutes: 495, sessionCount: 1 },
  );
});

/* ── formatting ──────────────────────────────────────────────────── */

test("formatSleepHours always renders one decimal", () => {
  assert.equal(formatSleepHours(450), "7.5");
  assert.equal(formatSleepHours(480), "8.0");
  assert.equal(formatSleepHours(0), "0.0");
  assert.equal(formatSleepHours(495), "8.3");
});

/* ── device-local toggle (pure part of deviceHealth.ts) ──────────── */

test("the device toggle defaults to off", () => {
  assert.equal(parseStoredHealthConnectEnabled(null), false);
  assert.equal(parseStoredHealthConnectEnabled(undefined), false);
  assert.equal(parseDeviceToggle(null), false);
  assert.equal(parseDeviceToggle("false"), false);
  assert.equal(parseDeviceToggle("1"), false);
  assert.equal(parseDeviceToggle(""), false);
  assert.equal(parseDeviceToggle("TRUE"), false); // no case-insensitive escape hatch
});

test("the device toggle state machine flips only through explicit true", () => {
  // Stored-value transitions: default → enabled → disabled → enabled.
  let stored: string | null = null;
  const setToggle = (enabled: boolean): void => {
    stored = enabled ? "true" : "false";
  };
  assert.equal(parseStoredHealthConnectEnabled(stored), false); // default off
  setToggle(true);
  assert.equal(parseStoredHealthConnectEnabled(stored), true);
  setToggle(false);
  assert.equal(parseStoredHealthConnectEnabled(stored), false);
  setToggle(true);
  assert.equal(parseStoredHealthConnectEnabled(stored), true);

  // The write format round-trips: whatever the toggle writes, the parse reads.
  for (const enabled of [true, false]) {
    assert.equal(parseStoredHealthConnectEnabled(enabled ? "true" : "false"), enabled);
  }
  assert.equal(HEALTH_CONNECT_STORAGE_KEY, "agent-fit-trace:health-connect:v1");
});

/* ── Me status line projection ───────────────────────────────────── */

test("healthConnectStatusKey resolves every Me status line state", () => {
  // The off toggle wins over everything else, including hydration states.
  assert.equal(healthConnectStatusKey(false, { kind: "supported" }, null), "off");
  assert.equal(healthConnectStatusKey(null, null, null), "off");
  // Enabled but availability still loading reads as off.
  assert.equal(healthConnectStatusKey(true, null, null), "off");
  // Enabled with a non-supported runtime shows the reason.
  assert.equal(healthConnectStatusKey(true, { kind: "unavailable", reason: "platform" }, null), "platform");
  assert.equal(healthConnectStatusKey(true, { kind: "unavailable", reason: "not-found" }, null), "not-found");
  assert.equal(healthConnectStatusKey(true, { kind: "needs-install" }, null), "needs-install");
  assert.equal(healthConnectStatusKey(true, { kind: "needs-update" }, null), "needs-update");
  // Supported: full grant vs. partial grant.
  assert.equal(
    healthConnectStatusKey(true, { kind: "supported" }, { granted: ["SleepSession", "RestingHeartRate"], missing: [] }),
    "supported",
  );
  assert.equal(
    healthConnectStatusKey(true, { kind: "supported" }, { granted: ["SleepSession"], missing: ["RestingHeartRate"] }),
    "partial",
  );
});
