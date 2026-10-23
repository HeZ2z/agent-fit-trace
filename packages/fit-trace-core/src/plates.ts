/**
 * Barbell plate-loading math, shared by the web and mobile editors.
 *
 * Pure and browser-safe: given a target weight it returns the plates to load on
 * each side of the bar, the achievable weight, and the remainder. Weights are
 * quantized to grams internally so decimal plates (2.5, 1.25) never accumulate
 * binary floating-point drift.
 */

export const DEFAULT_BAR_WEIGHT_KG = 20;

/** Selectable bar weights, heaviest first. */
export const BAR_WEIGHTS_KG = [20, 15] as const;
export type BarWeightKg = (typeof BAR_WEIGHTS_KG)[number];

/** Available plates per side, heaviest first. */
export const PLATE_DENOMINATIONS_KG = [20, 15, 10, 5, 2.5, 1.25] as const;
export type PlateDenominationKg = (typeof PLATE_DENOMINATIONS_KG)[number];

/** How many plates of one denomination to load on ONE side of the bar. */
export interface PlateCount {
  plateKg: PlateDenominationKg;
  count: number;
}

export interface PlateBreakdown {
  /** Target total weight, quantized to the nearest gram. */
  targetKg: number;
  /** Bar weight used for this breakdown. */
  barKg: number;
  /** Per-side load, heaviest first. Denominations with zero plates are omitted. */
  plates: PlateCount[];
  /** Total weight reachable with this bar and plate set; never above `targetKg`. */
  loadedKg: number;
  /** `targetKg - loadedKg`; 0 when the plates balance the target exactly. */
  remainderKg: number;
  /** True when the loaded barbell weighs exactly the target. */
  exact: boolean;
}

const GRAMS_PER_KG = 1000;

const PLATE_DEFINITIONS: readonly { plateKg: PlateDenominationKg; grams: number }[] =
  PLATE_DENOMINATIONS_KG.map((plateKg) => ({ plateKg, grams: Math.round(plateKg * GRAMS_PER_KG) }));

function toPositiveGrams(kg: number, label: string): number {
  if (!Number.isFinite(kg)) {
    throw new RangeError(`${label} must be a finite number of kilograms`);
  }
  const grams = Math.round(kg * GRAMS_PER_KG);
  if (grams <= 0) {
    throw new RangeError(`${label} must be greater than 0 kg`);
  }
  return grams;
}

/**
 * Compute the per-side plate load for a target total weight.
 *
 * Plates are symmetric, so the target is split into two equal per-side loads.
 * From there a descending greedy pass fills the heaviest plates first. The plate
 * set is complete down to 1.25 kg, so any target that is a multiple of 2.5 kg
 * above the bar is balanced exactly; otherwise `remainderKg` reports the true
 * shortfall to the heaviest loadable weight below the target.
 *
 * `targetKg` and `barKg` are quantized to the nearest gram before the math, so
 * the result is stable for decimal inputs such as 62.5 or 61.3. Inputs must be
 * finite and positive, and the target cannot be lighter than the bar.
 */
export function computePlateBreakdown(
  targetKg: number,
  options: { barKg?: number } = {},
): PlateBreakdown {
  const targetGrams = toPositiveGrams(targetKg, "targetKg");
  const barGrams = toPositiveGrams(options.barKg ?? DEFAULT_BAR_WEIGHT_KG, "barKg");
  if (targetGrams < barGrams) {
    throw new RangeError("targetKg cannot be lighter than barKg");
  }

  // Plates are symmetric: an odd gram of per-side load can never be loaded.
  const targetPerSideGrams = Math.floor((targetGrams - barGrams) / 2);
  let remainingPerSideGrams = targetPerSideGrams;

  const plates: PlateCount[] = [];
  for (const { plateKg, grams } of PLATE_DEFINITIONS) {
    const count = Math.floor(remainingPerSideGrams / grams);
    if (count === 0) continue;
    plates.push({ plateKg, count });
    remainingPerSideGrams -= count * grams;
  }

  const loadedPerSideGrams = targetPerSideGrams - remainingPerSideGrams;
  const loadedGrams = barGrams + 2 * loadedPerSideGrams;
  const remainderGrams = targetGrams - loadedGrams;

  return {
    targetKg: targetGrams / GRAMS_PER_KG,
    barKg: barGrams / GRAMS_PER_KG,
    plates,
    loadedKg: loadedGrams / GRAMS_PER_KG,
    remainderKg: remainderGrams / GRAMS_PER_KG,
    exact: remainderGrams === 0,
  };
}
