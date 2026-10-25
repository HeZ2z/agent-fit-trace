import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  aggregateSleepHours,
  createHealthConnectToggle,
  createSingleFlightInit,
  evaluatePermissionGrant,
  formatSleepHours,
  healthConnectStatusKey,
  importUnavailableReason,
  isIsoDate,
  mapHealthConnectStatus,
  nightWindowFor,
  nightWindowRange,
  parseStoredHealthConnectEnabled,
  SLEEP_STAGE,
  SDK_AVAILABILITY_STATUS,
  sleepImportMatchesDraft,
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
 * native adapter (`healthConnect.ts`) is deliberately never imported; its
 * source text is only read to guard the read-only contract.
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

test("health adapter never writes back to Health Connect", () => {
  // Product contract: the Health Connect integration is read-only — data
  // flows from Health Connect into the app, never the other way. Guard the
  // adapter's source text so a write call cannot creep in unnoticed. Word
  // boundaries keep the guard from tripping on `readRecords` in comments.
  const source = readFileSync(
    new URL("../mobile/src/health/healthConnect.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!/\b(insertRecords|deleteRecords|updateRecords|writeRecords)\b/.test(source));
  // The one requestPermission call passes the read-only permission bodies
  // (readPermissions() builds only accessType "read"); the SDK's own
  // `"read" | "write"` signature shape in the interface type is not a call.
  assert.ok(/\brequestPermission\(readPermissions\(\)\)/.test(source));
  assert.ok(/accessType: "read" as const/.test(source));
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

test("nightWindowRange takes each edge's own offset across a DST switch", () => {
  // EU spring-forward: 2024-03-30 is CET (UTC+1), 2024-03-31 is CEST (UTC+2).
  // Local [Mar 30 20:00 CET, Mar 31 12:00 CEST] is UTC [Mar 30 19:00, Mar 31 10:00].
  assert.deepEqual(nightWindowRange("2024-03-31", 60, 120), {
    startMs: Date.UTC(2024, 2, 30, 19, 0),
    endMs: Date.UTC(2024, 2, 31, 10, 0),
  });
  // Equal offsets degrade to the single-offset window.
  assert.deepEqual(nightWindowRange("2024-03-31", 60, 60), nightWindowFor("2024-03-31", 60));
  assert.equal(nightWindowRange("2026-13-01", 0, 0), null);
  assert.equal(nightWindowRange("not-a-date", 0, 0), null);
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
      0,
    ),
    { kind: "ok", hoursText: "7.0", totalMinutes: 420, sessionCount: 2 },
  );
});

test("aggregateSleepHours falls back to session duration without stages", () => {
  assert.deepEqual(
    aggregateSleepHours([session("2024-05-14T23:00:00.000Z", "2024-05-15T07:00:00.000Z")], "2024-05-15", 0, 0),
    { kind: "ok", hoursText: "8.0", totalMinutes: 480, sessionCount: 1 },
  );
});

test("aggregateSleepHours aggregates a session on the 2024 leap day", () => {
  assert.deepEqual(
    aggregateSleepHours(
      [session("2024-02-28T21:00:00.000Z", "2024-02-29T05:00:00.000Z")],
      "2024-02-29",
      0,
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
      -300,
    ),
    { kind: "ok", hoursText: "8.0", totalMinutes: 480, sessionCount: 1 },
  );
});

test("aggregateSleepHours hits a window that spans the 2024 EU spring-forward switch", () => {
  // Workout date 2024-03-31 (CEST, UTC+2); its D-1 evening 2024-03-30 is CET
  // (UTC+1). The mixed-offset window is UTC [Mar 30 19:00, Mar 31 10:00].
  // A session fully inside contributes fully.
  assert.deepEqual(
    aggregateSleepHours(
      [session("2024-03-30T20:00:00.000Z", "2024-03-31T02:00:00.000Z")],
      "2024-03-31",
      60, // D-1 evening edge: CET
      120, // D noon edge: CEST
    ),
    { kind: "ok", hoursText: "6.0", totalMinutes: 360, sessionCount: 1 },
  );
});

test("aggregateSleepHours clips both edges with their own offset on a DST switch day", () => {
  // Start edge: a session beginning before local 20:00 on D-1 is clipped at
  // Mar 30 20:00 CET (19:00 UTC) — not 18:00 UTC, which the old single-offset
  // window (D's CEST for both edges) would have used and which would overcount
  // the pre-window hour.
  assert.deepEqual(
    aggregateSleepHours(
      [session("2024-03-30T16:00:00.000Z", "2024-03-31T02:00:00.000Z")],
      "2024-03-31",
      60,
      120,
    ),
    { kind: "ok", hoursText: "7.0", totalMinutes: 420, sessionCount: 1 },
  );
  // End edge: a session spanning the whole window is clipped at
  // Mar 31 12:00 CEST (10:00 UTC) — not 11:00 UTC, which the old single-offset
  // window (D-1's CET for both edges) would have used and which would overcount
  // the post-window hour.
  assert.deepEqual(
    aggregateSleepHours(
      [session("2024-03-30T18:00:00.000Z", "2024-03-31T14:00:00.000Z")],
      "2024-03-31",
      60,
      120,
    ),
    { kind: "ok", hoursText: "15.0", totalMinutes: 900, sessionCount: 1 },
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
    0,
  );
  assert.ok(exact.kind === "ok" && exact.hoursText === "24.0");
});

test("aggregateSleepHours reports no-data and errors for degenerate input", () => {
  assert.equal(
    aggregateSleepHours([session("2024-05-14T22:00:00.000Z", "2024-05-15T06:00:00.000Z")], "2024-05-16", 0, 0).kind,
    "no-data",
  );
  assert.equal(aggregateSleepHours([], "2024-05-15", 0, 0).kind, "no-data");
  // Inverted/malformed sessions are skipped, not fatal.
  assert.equal(
    aggregateSleepHours([session("2024-05-15T06:00:00.000Z", "2024-05-14T22:00:00.000Z")], "2024-05-15", 0, 0).kind,
    "no-data",
  );
  // Malformed workout dates are an error, not a crash.
  assert.ok(aggregateSleepHours([], "2024-05", 0, 0).kind === "error");
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

/* ── sleep import → draft staleness rule ─────────────────────────── */

test("sleepImportMatchesDraft applies only to the captured draft snapshot", () => {
  const captured = { date: "2024-05-15", revision: 7 };
  // Same date, same revision: the read was started for exactly this draft.
  assert.equal(sleepImportMatchesDraft(captured, { date: "2024-05-15", revision: 7 }), true);
  // The date was edited while the read was in flight: the result would fill
  // the wrong night's sleep into the new date.
  assert.equal(sleepImportMatchesDraft(captured, { date: "2024-05-16", revision: 8 }), false);
  // Any edit bumps the revision, even of another field: a late result must
  // never overwrite newer draft content.
  assert.equal(sleepImportMatchesDraft(captured, { date: "2024-05-15", revision: 8 }), false);
  // A cleared or switched draft (discard and owner loads bump the revision
  // too): a late result must not resurrect the cleared editor.
  assert.equal(sleepImportMatchesDraft(captured, { date: "2024-05-15", revision: 99 }), false);
});

/* ── device-local toggle state machine (memory-first, write rollback) ── */

test("the toggle reads storage once, then serves the memory value", async () => {
  const backing = new Map<string, string>();
  let reads = 0;
  const storage = {
    async getItem(key: string): Promise<string | null> {
      reads += 1;
      return backing.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      backing.set(key, value);
    },
  };
  const toggle = createHealthConnectToggle(storage, HEALTH_CONNECT_STORAGE_KEY);

  // First read hits storage (default off).
  assert.equal(await toggle.read(), false);
  assert.equal(reads, 1);
  // A storage change behind the cache is ignored: memory wins.
  backing.set(HEALTH_CONNECT_STORAGE_KEY, "true");
  assert.equal(await toggle.read(), false);
  assert.equal(reads, 1);
  // A successful write updates memory first, so later reads see it without
  // another storage round-trip — and storage actually holds the new value.
  await toggle.write(true);
  assert.equal(await toggle.read(), true);
  assert.equal(reads, 1);
  assert.equal(backing.get(HEALTH_CONNECT_STORAGE_KEY), "true");
});

test("a failed toggle write rolls the memory value back and rethrows", async () => {
  const backing = new Map<string, string>([[HEALTH_CONNECT_STORAGE_KEY, "true"]]);
  let failWrites = true;
  const storage = {
    async getItem(key: string): Promise<string | null> {
      return backing.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      if (failWrites) throw new Error("disk full");
      backing.set(key, value);
    },
  };
  const toggle = createHealthConnectToggle(storage, HEALTH_CONNECT_STORAGE_KEY);
  assert.equal(await toggle.read(), true); // cached from storage

  // The write must surface its failure, not swallow it: the Me screen reports
  // it instead of showing a state storage never received.
  await assert.rejects(toggle.write(false), /disk full/);
  // The memory value rolled back to what storage actually holds, and storage
  // is unchanged — a later read (the Log screen's) stays consistent.
  assert.equal(await toggle.read(), true);
  assert.equal(readsInStorage(backing), true);

  // Once persistence recovers, the same write succeeds and sticks.
  failWrites = false;
  await toggle.write(false);
  assert.equal(await toggle.read(), false);
  assert.equal(readsInStorage(backing), false);
});

/** What the (fake) storage actually holds for the toggle key, parsed. */
function readsInStorage(backing: Map<string, string>): boolean {
  return parseStoredHealthConnectEnabled(backing.get(HEALTH_CONNECT_STORAGE_KEY) ?? null);
}

test("an unreadable storage read is off and is not cached", async () => {
  let failReads = true;
  let reads = 0;
  const backing = new Map<string, string>([[HEALTH_CONNECT_STORAGE_KEY, "true"]]);
  const storage = {
    async getItem(key: string): Promise<string | null> {
      reads += 1;
      if (failReads) throw new Error("storage unavailable");
      return backing.get(key) ?? null;
    },
    async setItem(key: string, value: string): Promise<void> {
      backing.set(key, value);
    },
  };
  const toggle = createHealthConnectToggle(storage, HEALTH_CONNECT_STORAGE_KEY);
  assert.equal(await toggle.read(), false);
  assert.equal(await toggle.read(), false);
  assert.equal(reads, 2); // the failure is retried, not pinned in memory
  failReads = false;
  assert.equal(await toggle.read(), true);
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
  // The sleep read gates the whole import: a missing sleep grant is
  // "no-permission" even when resting heart rate is granted (e.g. the grant
  // was revoked in the system Health Connect settings), and so is a fully
  // empty grant. A missing resting-heart-rate grant beside a granted sleep
  // scope stays "partial" (asserted above).
  assert.equal(
    healthConnectStatusKey(true, { kind: "supported" }, { granted: ["RestingHeartRate"], missing: ["SleepSession"] }),
    "no-permission",
  );
  assert.equal(
    healthConnectStatusKey(
      true,
      { kind: "supported" },
      { granted: [], missing: ["SleepSession", "RestingHeartRate"] },
    ),
    "no-permission",
  );
});
