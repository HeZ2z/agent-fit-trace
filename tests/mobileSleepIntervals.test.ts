import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  APPLE_SLEEP_VALUE,
  isAsleepValue,
  selectRestingHeartRate,
  unionAsleepMinutes,
  type RestingHeartRateSample,
  type SleepInterval,
} from "../mobile/src/health/sleepIntervals.ts";
import { formatSleepHours, nightWindowRange } from "../mobile/src/health/healthModel.ts";

/**
 * Pure coverage for the HealthKit interval union. Only
 * `mobile/src/health/sleepIntervals.ts` and the window/formatting helpers of
 * `healthModel.ts` are imported — no React, React Native, Expo or native module
 * runs here, so the root `node:test` suite never needs an iOS device.
 *
 * The window used throughout is the real night window for 2026-10-25 at UTC+0:
 * local `[2026-10-24 20:00, 2026-10-25 12:00]`.
 */

const WINDOW = nightWindowRange("2026-10-25", 0, 0);
assert.ok(WINDOW !== null, "the fixture window must be valid");
const WINDOW_START = WINDOW.startMs;
const WINDOW_END = WINDOW.endMs;

/** An ISO instant `minutes` after the window start. */
function at(minutes: number): string {
  return new Date(WINDOW_START + minutes * 60_000).toISOString();
}

/** One interval starting at `startMin` and spanning `lengthMin` minutes. */
function interval(startMin: number, lengthMin: number): SleepInterval {
  return { start: at(startMin), end: at(startMin + lengthMin) };
}

test("sleepIntervals.ts stays free of native, platform and storage dependencies", () => {
  // The pure layer is loaded by the root node:test suite through type
  // stripping; a single native import would break that. Word boundaries are
  // required: the substring "expo" occurs in every "export" keyword.
  const source = readFileSync(
    new URL("../mobile/src/health/sleepIntervals.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!/\breact-native-healthkit\b/.test(source));
  assert.ok(!/\bexpo\b/.test(source));
  assert.ok(!/from "react-native"/.test(source));
  assert.ok(!/require\("react-native"\)/.test(source));
  assert.ok(!/\bfrom "\.\/healthKit(\.ts)?"/.test(source));
});

/* ── union rules ─────────────────────────────────────────────────── */

test("unionAsleepMinutes returns an empty aggregate for no intervals", () => {
  assert.deepEqual(unionAsleepMinutes([], WINDOW_START, WINDOW_END), {
    totalMinutes: 0,
    intervalCount: 0,
    mergedCount: 0,
  });
});

test("unionAsleepMinutes sums disjoint stages", () => {
  // 60 + 120 + 30 = 210 minutes across three separated blocks.
  assert.deepEqual(
    unionAsleepMinutes(
      [interval(0, 60), interval(120, 120), interval(300, 30)],
      WINDOW_START,
      WINDOW_END,
    ),
    { totalMinutes: 210, intervalCount: 3, mergedCount: 3 },
  );
});

test("unionAsleepMinutes counts duplicated samples once", () => {
  // The same watch interval reported twice (a sync replay) must not double.
  const duplicate = interval(60, 120);
  assert.deepEqual(
    unionAsleepMinutes([duplicate, duplicate, duplicate], WINDOW_START, WINDOW_END),
    { totalMinutes: 120, intervalCount: 3, mergedCount: 1 },
  );
});

test("unionAsleepMinutes merges partial overlaps without counting the shared minutes twice", () => {
  // [60, 180) and [120, 240) → union [60, 240) = 180 minutes, not 240.
  assert.deepEqual(
    unionAsleepMinutes([interval(60, 120), interval(120, 120)], WINDOW_START, WINDOW_END),
    { totalMinutes: 180, intervalCount: 2, mergedCount: 1 },
  );
});

test("unionAsleepMinutes merges a nested interval into its container", () => {
  // A short stage entirely inside a longer one (a source reporting coarser
  // stages): [60, 300) contains [120, 180).
  assert.deepEqual(
    unionAsleepMinutes([interval(60, 240), interval(120, 60)], WINDOW_START, WINDOW_END),
    { totalMinutes: 240, intervalCount: 2, mergedCount: 1 },
  );
});

test("unionAsleepMinutes merges exactly adjacent intervals", () => {
  // Two stages meeting at minute 180 belong to one continuous sleep period.
  assert.deepEqual(
    unionAsleepMinutes([interval(60, 120), interval(180, 60)], WINDOW_START, WINDOW_END),
    { totalMinutes: 180, intervalCount: 2, mergedCount: 1 },
  );
});

test("unionAsleepMinutes merges a chain of overlapping and adjacent intervals into one run", () => {
  // [60,120) + [110,150) + [150,200) + [190,210) → union [60, 210) = 150.
  assert.deepEqual(
    unionAsleepMinutes(
      [interval(60, 60), interval(110, 40), interval(150, 50), interval(190, 20)],
      WINDOW_START,
      WINDOW_END,
    ),
    { totalMinutes: 150, intervalCount: 4, mergedCount: 1 },
  );
});

test("unionAsleepMinutes does not depend on the order samples arrive in", () => {
  const ordered = [interval(60, 60), interval(130, 60), interval(300, 30)];
  const shuffled = [ordered[2], ordered[0], ordered[1]];
  assert.deepEqual(
    unionAsleepMinutes(shuffled, WINDOW_START, WINDOW_END),
    unionAsleepMinutes(ordered, WINDOW_START, WINDOW_END),
  );
});

test("unionAsleepMinutes clips both window edges", () => {
  // A block starting before the window and one running past its end: only the
  // in-window parts count. [-60, 60) ∪ [600, 1200) → 60 + 360 = 420.
  assert.deepEqual(
    unionAsleepMinutes(
      [{ start: at(-60), end: at(60) }, { start: at(600), end: at(1200) }],
      WINDOW_START,
      WINDOW_END,
    ),
    { totalMinutes: 420, intervalCount: 2, mergedCount: 2 },
  );
});

test("unionAsleepMinutes drops intervals that touch the window edge without entering it", () => {
  // Ends exactly at the window start, and starts exactly at the window end:
  // half-open, so neither contributes (and neither is counted).
  assert.deepEqual(
    unionAsleepMinutes(
      [{ start: at(-60), end: at(0) }, { start: at(960), end: at(1020) }],
      WINDOW_START,
      WINDOW_END,
    ),
    { totalMinutes: 0, intervalCount: 0, mergedCount: 0 },
  );
});

test("unionAsleepMinutes ignores invalid intervals instead of trusting them", () => {
  // Unparsable instants, an inverted interval and a zero-length interval are
  // all dropped; the one good interval still totals correctly.
  assert.deepEqual(
    unionAsleepMinutes(
      [
        { start: "not-a-date", end: at(60) },
        { start: at(60), end: "not-a-date" },
        { start: at(300), end: at(240) }, // inverted: would subtract 60
        { start: at(120), end: at(120) }, // zero length
        interval(60, 60),
      ],
      WINDOW_START,
      WINDOW_END,
    ),
    { totalMinutes: 60, intervalCount: 1, mergedCount: 1 },
  );
});

test("unionAsleepMinutes returns an empty aggregate for an invalid window", () => {
  assert.deepEqual(unionAsleepMinutes([interval(60, 60)], WINDOW_END, WINDOW_START), {
    totalMinutes: 0,
    intervalCount: 0,
    mergedCount: 0,
  });
  assert.deepEqual(unionAsleepMinutes([interval(60, 60)], WINDOW_START, WINDOW_START), {
    totalMinutes: 0,
    intervalCount: 0,
    mergedCount: 0,
  });
});

test("unionAsleepMinutes measures a window that crosses midnight", () => {
  // The fixture window itself spans midnight (20:00 → 12:00 next day); a block
  // from 22:00 to 06:30 is 510 minutes entirely inside it.
  assert.deepEqual(
    unionAsleepMinutes([interval(120, 510)], WINDOW_START, WINDOW_END),
    { totalMinutes: 510, intervalCount: 1, mergedCount: 1 },
  );
});

test("unionAsleepMinutes handles a window whose edges carry different DST offsets", () => {
  // EU spring-forward 2024-03-31: the evening edge is CET (UTC+1), the noon
  // edge CEST (UTC+2), so the window is UTC [Mar 30 19:00, Mar 31 10:00] — 15
  // real hours, not 16. A sample spanning the whole window totals 900 minutes.
  const dstWindow = nightWindowRange("2024-03-31", 60, 120);
  assert.ok(dstWindow !== null);
  const spanning: SleepInterval = {
    start: new Date(dstWindow.startMs - 3600_000).toISOString(),
    end: new Date(dstWindow.endMs + 3600_000).toISOString(),
  };
  assert.deepEqual(unionAsleepMinutes([spanning], dstWindow.startMs, dstWindow.endMs), {
    totalMinutes: 900,
    intervalCount: 1,
    mergedCount: 1,
  });
});

test("unionAsleepMinutes rounds once at the end, not per interval", () => {
  // Three 20-second fragments are 1 minute together; per-interval rounding
  // would report 0 (or 3, rounding each to 0.33 → 1). 3×20s = 60s = 1 min.
  const twentySeconds = 20_000;
  const fragments: SleepInterval[] = [0, 100, 200].map((offset) => ({
    start: new Date(WINDOW_START + offset * 60_000).toISOString(),
    end: new Date(WINDOW_START + offset * 60_000 + twentySeconds).toISOString(),
  }));
  assert.deepEqual(unionAsleepMinutes(fragments, WINDOW_START, WINDOW_END), {
    totalMinutes: 1,
    intervalCount: 3,
    mergedCount: 3,
  });
});

test("unionAsleepMinutes feeds formatSleepHours to one decimal", () => {
  // 7 h 31 m = 451 minutes → the existing formatter's "7.5".
  const total = unionAsleepMinutes([interval(0, 451)], WINDOW_START, WINDOW_END);
  assert.equal(total.totalMinutes, 451);
  assert.equal(formatSleepHours(total.totalMinutes), "7.5");
});

/* ── HealthKit stage values ──────────────────────────────────────── */

test("isAsleepValue counts the four asleep stages and excludes inBed and awake", () => {
  assert.equal(isAsleepValue(APPLE_SLEEP_VALUE.ASLEEP_CORE), true);
  assert.equal(isAsleepValue(APPLE_SLEEP_VALUE.ASLEEP_DEEP), true);
  assert.equal(isAsleepValue(APPLE_SLEEP_VALUE.ASLEEP_REM), true);
  assert.equal(isAsleepValue(APPLE_SLEEP_VALUE.ASLEEP_UNSPECIFIED), true);
  assert.equal(isAsleepValue(APPLE_SLEEP_VALUE.IN_BED), false);
  assert.equal(isAsleepValue(APPLE_SLEEP_VALUE.AWAKE), false);
  // Awake (2) sits between unspecified (1) and core (3) — the classic off-by-one.
  assert.equal(APPLE_SLEEP_VALUE.AWAKE, 2);
  assert.equal(APPLE_SLEEP_VALUE.ASLEEP_CORE, 3);
});

test("isAsleepValue treats unknown future stage values as not asleep", () => {
  assert.equal(isAsleepValue(6), false);
  assert.equal(isAsleepValue(99), false);
  assert.equal(isAsleepValue(-1), false);
});

/* ── resting heart rate ──────────────────────────────────────────── */

/** A resting-HR sample starting `minutes` after the window start. */
function hr(startMin: number, bpm: number): RestingHeartRateSample {
  return { start: at(startMin), bpm };
}

test("selectRestingHeartRate returns the latest in-window sample", () => {
  assert.equal(
    selectRestingHeartRate([hr(10, 54), hr(500, 52), hr(480, 58)], WINDOW_START, WINDOW_END),
    52,
  );
});

test("selectRestingHeartRate ignores out-of-window samples", () => {
  // Before the window and at/after its end: neither is last night's.
  assert.equal(
    selectRestingHeartRate([hr(-120, 40), hr(960, 44)], WINDOW_START, WINDOW_END),
    null,
  ); // the window is exactly 960 minutes long
});

test("selectRestingHeartRate ignores implausible values", () => {
  assert.equal(
    selectRestingHeartRate(
      [hr(10, 0), hr(20, -5), hr(30, Number.NaN), hr(40, Number.POSITIVE_INFINITY)],
      WINDOW_START,
      WINDOW_END,
    ),
    null,
  );
  // A plausible sample after the bad ones still wins.
  assert.equal(
    selectRestingHeartRate([hr(10, 0), hr(20, 55)], WINDOW_START, WINDOW_END),
    55,
  );
});

test("selectRestingHeartRate rounds to a whole bpm and rejects bad instants", () => {
  assert.equal(selectRestingHeartRate([hr(10, 54.6)], WINDOW_START, WINDOW_END), 55);
  assert.equal(
    selectRestingHeartRate(
      [{ start: "not-a-date", bpm: 50 }, hr(10, 61)],
      WINDOW_START,
      WINDOW_END,
    ),
    61,
  );
});

test("selectRestingHeartRate returns null for an invalid window or no samples", () => {
  assert.equal(selectRestingHeartRate([hr(10, 55)], WINDOW_END, WINDOW_START), null);
  assert.equal(selectRestingHeartRate([hr(10, 55)], WINDOW_START, WINDOW_START), null);
  assert.equal(selectRestingHeartRate([], WINDOW_START, WINDOW_END), null);
});
