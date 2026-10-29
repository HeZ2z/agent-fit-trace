/**
 * Pure interval rules for turning raw health-store sleep samples into one
 * duration.
 *
 * iOS HealthKit reports sleep as a flat stream of category samples: one sample
 * per stage (`asleepCore`, `asleepDeep`, `asleepREM`, `asleepUnspecified`,
 * `awake`, `inBed`), often written by several sources — the watch, a third-party
 * app, a manual entry — so the same wall-clock minutes can be reported more than
 * once. Android Health Connect instead groups stages under one session record.
 * Summing raw sample durations therefore over-counts on iOS, and the only sound
 * aggregate is the measure of the **union** of the asleep intervals.
 *
 * The union is computed here, environment-free: it imports no React, React
 * Native, Expo or native module and no Node built-ins, so the root `node:test`
 * suite loads it through Node's TypeScript type stripping. Instants are ISO
 * strings on the way in (what the bridges hand over); epoch milliseconds are the
 * internal unit.
 *
 * Android's `aggregateSleepHours` in `healthModel.ts` is deliberately left
 * untouched: Health Connect's session shape already deduplicates by
 * construction there, and this module adds the iOS rule beside it instead of
 * redefining the Android one.
 */

/** A provider-neutral half-open interval `[start, end)` as ISO instants. */
export interface SleepInterval {
  start: string;
  end: string;
}

/**
 * Sleep-stage codes from iOS HealthKit's `HKCategoryValueSleepAnalysis`,
 * mirrored as a plain const object for the same no-enum reason as
 * `SLEEP_STAGE` in `healthModel.ts` (the pure layer must stay erasable and must
 * not import the native library's TypeScript enum).
 *
 * `asleepUnspecified` and `asleep` share the value 1 in HealthKit (the framework
 * kept the alias when it introduced stage values), which is why the map below is
 * a set of numbers rather than of names.
 */
export const APPLE_SLEEP_VALUE = {
  IN_BED: 0,
  ASLEEP_UNSPECIFIED: 1,
  AWAKE: 2,
  ASLEEP_CORE: 3,
  ASLEEP_DEEP: 4,
  ASLEEP_REM: 5,
} as const;

/** Stage values that count as asleep: core, deep, REM and unspecified/asleep. */
const ASLEEP_VALUES: ReadonlySet<number> = new Set([
  APPLE_SLEEP_VALUE.ASLEEP_UNSPECIFIED,
  APPLE_SLEEP_VALUE.ASLEEP_CORE,
  APPLE_SLEEP_VALUE.ASLEEP_DEEP,
  APPLE_SLEEP_VALUE.ASLEEP_REM,
]);

/**
 * Whether one HealthKit sleep-analysis stage value counts toward sleep time.
 *
 * `inBed` and `awake` are excluded: in-bed covers the whole period the user lay
 * down (including time awake before falling asleep and after waking), so
 * including it would overstate sleep, and awake is explicitly not sleep.
 * Unknown values from a future HealthKit release read as "not asleep" rather
 * than inflating the total.
 */
export function isAsleepValue(value: number): boolean {
  return ASLEEP_VALUES.has(value);
}

/** The union of the asleep intervals inside one night window. */
export interface AsleepTotal {
  /** Union duration rounded once, at the end, to whole minutes. */
  totalMinutes: number;
  /** Valid intervals that contributed more than zero milliseconds. */
  intervalCount: number;
  /** Intervals left after clipping, sorting and merging overlapping runs. */
  mergedCount: number;
}

/** An empty aggregate: no input, or an invalid window. */
function emptyAsleepTotal(): AsleepTotal {
  return { totalMinutes: 0, intervalCount: 0, mergedCount: 0 };
}

/**
 * Measure of the union of `intervals` clipped to `[windowStartMs, windowEndMs)`.
 *
 * Rules, applied in this order:
 *
 * - An interval whose instants do not parse, or whose end is not after its
 *   start, is dropped rather than trusted. A negative or zero-length interval
 *   would otherwise subtract time from the union.
 * - Each surviving interval is clipped to the window; a clip that leaves zero
 *   length is dropped (it contributes nothing and must not inflate
 *   `intervalCount`).
 * - The clipped intervals are sorted by start, then by end, so the result does
 *   not depend on the order the health store returned samples in.
 * - Overlapping, nested, duplicated and exactly-adjacent intervals are merged
 *   into one run. Adjacency has to merge: two stages that meet at an instant
 *   belong to one continuous period of sleep, and counting them separately
 *   would let the same instant be counted twice.
 * - The merged lengths are summed and rounded to whole minutes once, at the
 *   end, so many small fragments cannot each round up.
 *
 * An invalid window (`end <= start`) returns an empty aggregate: callers
 * validate the night window before reading, so this can only mean a caller bug,
 * and returning zeros keeps it a data-shaped result instead of a throw inside a
 * native read.
 */
export function unionAsleepMinutes(
  intervals: readonly SleepInterval[],
  windowStartMs: number,
  windowEndMs: number,
): AsleepTotal {
  if (!(windowEndMs > windowStartMs)) return emptyAsleepTotal();

  const clipped: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const start = Date.parse(interval.start);
    const end = Date.parse(interval.end);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    const clippedStart = Math.max(start, windowStartMs);
    const clippedEnd = Math.min(end, windowEndMs);
    // Half-open: an interval that merely touches the window edge has zero
    // length and is not a contribution.
    if (clippedEnd <= clippedStart) continue;
    clipped.push({ start: clippedStart, end: clippedEnd });
  }

  if (clipped.length === 0) return emptyAsleepTotal();

  clipped.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));

  let totalMs = 0;
  let mergedCount = 0;
  let runStart = clipped[0].start;
  let runEnd = clipped[0].end;
  for (let index = 1; index < clipped.length; index += 1) {
    const next = clipped[index];
    // `<=` merges adjacency as well as overlap: contiguous stages form one run.
    if (next.start <= runEnd) {
      if (next.end > runEnd) runEnd = next.end;
      continue;
    }
    totalMs += runEnd - runStart;
    mergedCount += 1;
    runStart = next.start;
    runEnd = next.end;
  }
  totalMs += runEnd - runStart;
  mergedCount += 1;

  return {
    totalMinutes: Math.round(totalMs / 60_000),
    intervalCount: clipped.length,
    mergedCount,
  };
}

/** One resting-heart-rate sample as the adapter normalizes it. */
export interface RestingHeartRateSample {
  /** Sample start instant, ISO. */
  start: string;
  /** Beats per minute. */
  bpm: number;
}

/**
 * The resting heart rate to report for one night window: the **latest** sample
 * that starts inside `[windowStartMs, windowEndMs)` and carries a plausible
 * positive value, rounded to a whole bpm. `null` when there is none.
 *
 * Latest-sample selection (rather than an average) mirrors how Apple Health
 * itself presents resting heart rate as one value per day, and it keeps the
 * number traceable to a single sample the user can see in the Health app. Only
 * in-window samples count, so a stale reading from an earlier day is never
 * reported as last night's.
 *
 * The value has no persistence contract in this slice — `WorkoutRecord` carries
 * only `sleep_hours` — so callers may display it but must not claim it was
 * imported into the workout record. See the resting-heart-rate gap in
 * `docs/mobile.md`.
 */
export function selectRestingHeartRate(
  samples: readonly RestingHeartRateSample[],
  windowStartMs: number,
  windowEndMs: number,
): number | null {
  if (!(windowEndMs > windowStartMs)) return null;
  let latestStartMs = Number.NEGATIVE_INFINITY;
  let latestBpm: number | null = null;
  for (const sample of samples) {
    if (!Number.isFinite(sample.bpm) || sample.bpm <= 0) continue;
    const startMs = Date.parse(sample.start);
    if (Number.isNaN(startMs)) continue;
    if (startMs < windowStartMs || startMs >= windowEndMs) continue;
    if (startMs >= latestStartMs) {
      latestStartMs = startMs;
      latestBpm = Math.round(sample.bpm);
    }
  }
  return latestBpm;
}
