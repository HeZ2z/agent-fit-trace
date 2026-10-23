import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BAR_WEIGHTS_KG,
  DEFAULT_BAR_WEIGHT_KG,
  PLATE_DENOMINATIONS_KG,
  computePlateBreakdown,
} from "@agent-fit-trace/core";

test("exports the supported bar and plate sets", () => {
  assert.equal(DEFAULT_BAR_WEIGHT_KG, 20);
  assert.deepEqual([...BAR_WEIGHTS_KG], [20, 15]);
  assert.deepEqual([...PLATE_DENOMINATIONS_KG], [20, 15, 10, 5, 2.5, 1.25]);
});

test("balances an exact target with the default 20 kg bar", () => {
  const breakdown = computePlateBreakdown(100);

  assert.equal(breakdown.targetKg, 100);
  assert.equal(breakdown.barKg, 20);
  assert.deepEqual(breakdown.plates, [{ plateKg: 20, count: 2 }]);
  assert.equal(breakdown.loadedKg, 100);
  assert.equal(breakdown.remainderKg, 0);
  assert.equal(breakdown.exact, true);
});

test("balances relative to the selected 15 kg bar", () => {
  const breakdown = computePlateBreakdown(55, { barKg: 15 });

  assert.equal(breakdown.barKg, 15);
  assert.equal(breakdown.loadedKg, 55);
  assert.deepEqual(breakdown.plates, [{ plateKg: 20, count: 1 }]);
  assert.equal(breakdown.remainderKg, 0);
  assert.equal(breakdown.exact, true);
});

test("loads fractional plates without floating-point drift", () => {
  const breakdown = computePlateBreakdown(62.5);

  assert.deepEqual(breakdown.plates, [
    { plateKg: 20, count: 1 },
    { plateKg: 1.25, count: 1 },
  ]);
  assert.equal(breakdown.loadedKg, 62.5);
  assert.equal(breakdown.remainderKg, 0);
  assert.equal(breakdown.exact, true);
});

test("uses heavier plates first when the load needs several denominations", () => {
  const breakdown = computePlateBreakdown(105);

  assert.deepEqual(breakdown.plates, [
    { plateKg: 20, count: 2 },
    { plateKg: 2.5, count: 1 },
  ]);
  assert.equal(breakdown.loadedKg, 105);
  assert.equal(breakdown.exact, true);
});

test("reports the remainder instead of rounding the target up", () => {
  const breakdown = computePlateBreakdown(61.3);

  assert.deepEqual(breakdown.plates, [{ plateKg: 20, count: 1 }]);
  assert.equal(breakdown.loadedKg, 60);
  assert.equal(breakdown.remainderKg, 1.3);
  assert.equal(breakdown.exact, false);
  assert.ok(
    breakdown.remainderKg < 2.5,
    "remainder is smaller than the smallest loadable increment",
  );
});

test("needs no plates when the target equals the bar", () => {
  const breakdown = computePlateBreakdown(20);

  assert.deepEqual(breakdown.plates, []);
  assert.equal(breakdown.loadedKg, 20);
  assert.equal(breakdown.remainderKg, 0);
  assert.equal(breakdown.exact, true);
});

test("quantizes inputs to grams before computing", () => {
  const rounded = computePlateBreakdown(60.0004);
  assert.equal(rounded.targetKg, 60);
  assert.equal(rounded.exact, true);

  const short = computePlateBreakdown(60.001);
  assert.equal(short.targetKg, 60.001);
  assert.equal(short.loadedKg, 60);
  assert.equal(short.remainderKg, 0.001);
  assert.equal(short.exact, false);
});

test("omits zero-count entries and orders plates heaviest first", () => {
  const breakdown = computePlateBreakdown(220);
  assert.deepEqual(breakdown.plates, [{ plateKg: 20, count: 5 }]);
  assert.equal(breakdown.exact, true);

  const mixed = computePlateBreakdown(85);
  assert.deepEqual(mixed.plates, [
    { plateKg: 20, count: 1 },
    { plateKg: 10, count: 1 },
    { plateKg: 2.5, count: 1 },
  ]);
  const positions = mixed.plates.map((plate) => PLATE_DENOMINATIONS_KG.indexOf(plate.plateKg));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "every denomination appears after a heavier one",
  );
});

test("rejects non-finite, non-positive, and below-bar inputs", () => {
  for (const targetKg of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -20,
  ]) {
    assert.throws(() => computePlateBreakdown(targetKg), RangeError);
  }
  assert.throws(() => computePlateBreakdown(19.5), /lighter than barKg/);
  assert.throws(() => computePlateBreakdown(0.0004), /greater than 0 kg/);

  for (const barKg of [Number.NaN, Number.POSITIVE_INFINITY, 0, -20]) {
    assert.throws(() => computePlateBreakdown(100, { barKg }), RangeError);
  }
});

test("never loads more than the target and never misses an exact load", () => {
  for (let targetKg = DEFAULT_BAR_WEIGHT_KG; targetKg <= 320; targetKg += 0.5) {
    const breakdown = computePlateBreakdown(targetKg);

    assert.ok(breakdown.loadedKg <= breakdown.targetKg, `overloaded ${targetKg}`);
    assert.ok(breakdown.remainderKg >= 0, `negative remainder for ${targetKg}`);
    assert.ok(breakdown.remainderKg < 2.5, `remainder too large for ${targetKg}`);
    assert.equal(
      Math.round((breakdown.loadedKg + breakdown.remainderKg) * 1000),
      Math.round(breakdown.targetKg * 1000),
      `loaded + remainder must equal the target for ${targetKg}`,
    );
    for (const plate of breakdown.plates) {
      assert.ok(Number.isInteger(plate.count) && plate.count > 0, `bad count for ${targetKg}`);
      assert.ok(
        PLATE_DENOMINATIONS_KG.includes(plate.plateKg),
        `unknown plate for ${targetKg}`,
      );
    }
  }
});

test("balances every target that is a multiple of 2.5 kg above the bar", () => {
  for (let targetKg = DEFAULT_BAR_WEIGHT_KG; targetKg <= 220; targetKg += 2.5) {
    const breakdown = computePlateBreakdown(targetKg);
    assert.equal(breakdown.exact, true, `expected exact load for ${targetKg}`);
    assert.equal(breakdown.remainderKg, 0);
    assert.equal(breakdown.loadedKg, targetKg);
  }
});

test("is deterministic for identical inputs", () => {
  assert.deepEqual(computePlateBreakdown(123.75), computePlateBreakdown(123.75));
});
