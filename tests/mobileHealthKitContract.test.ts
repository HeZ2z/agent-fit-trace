import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  appleHealthStatusKey,
  healthKitAuthorizationFromStatus,
  healthPlatformFor,
  healthStatusView,
  needsHealthKitAuthorizationRequest,
  previousIsoDate,
  sleepReadUsable,
  tzOffsetMinutesForDate,
  HEALTHKIT_AUTHORIZATION_REQUEST_STATUS,
  type HealthAuthorization,
} from "../mobile/src/health/healthModel.ts";

/**
 * Issue #51 contract for the Apple Health provider.
 *
 * Only pure rules and source text are exercised here. The native adapters
 * (`healthKit.ts`, `healthConnect.ts`, `healthProvider.ts`) import React Native
 * and their native modules, so they are never loaded by this suite — their
 * invariants are pinned by grepping the source, which is what the guards below
 * do. Behavior that would need a device (the actual HealthKit query, the system
 * sheet) is listed as an unverified gap in `docs/mobile.md` instead of being
 * faked into a passing test.
 */

const HEALTH_KIT_SOURCE = new URL("../mobile/src/health/healthKit.ts", import.meta.url);
const HEALTH_PROVIDER_SOURCE = new URL("../mobile/src/health/healthProvider.ts", import.meta.url);
const HEALTH_CONNECT_SOURCE = new URL("../mobile/src/health/healthConnect.ts", import.meta.url);

function readSource(url: URL): string {
  return readFileSync(url, "utf8");
}

/* ── read-only guarantee ─────────────────────────────────────────── */

test("the HealthKit adapter contains no write API call", () => {
  const source = readSource(HEALTH_KIT_SOURCE);
  // Read-only toward Apple Health: no sample saving, no sharing scopes, no
  // object deletion. These names are the library's write surface.
  assert.ok(!/\bsaveCategorySample\b/.test(source));
  assert.ok(!/\bsaveQuantitySample\b/.test(source));
  assert.ok(!/\bsaveCorrelationSample\b/.test(source));
  assert.ok(!/\bsaveWorkoutSample\b/.test(source));
  assert.ok(!/\bdeleteObjects\b/.test(source));
  assert.ok(!/\btoShare\b/.test(source));
  // No background delivery: the plugin config sets `background: false`, and the
  // adapter must not re-enable it at runtime.
  assert.ok(!/\benableBackgroundDelivery\b/.test(source));
  assert.ok(!/\bconfigureBackgroundTypes\b/.test(source));
  assert.ok(!/\bsubscribeToChanges\b/.test(source));
});

test("no health adapter under mobile/src/health writes to any health store", () => {
  for (const url of [HEALTH_KIT_SOURCE, HEALTH_CONNECT_SOURCE, HEALTH_PROVIDER_SOURCE]) {
    const source = readSource(url);
    // Shared write-API guard across every adapter file, so a write cannot be
    // sneaked into the picker module either.
    assert.ok(
      !/\b(saveCategorySample|saveQuantitySample|insertRecords|updateRecords|deleteRecords|writeRecords)\b/.test(
        source,
      ),
      `${url.pathname} must stay read-only`,
    );
  }
});

/* ── lazy native loading and platform gating ─────────────────────── */

test("the HealthKit adapter loads its native module lazily and only on iOS", () => {
  const source = readSource(HEALTH_KIT_SOURCE);
  // A static import would touch the Nitro module on every platform, which
  // crashes off-iOS. Only a `require` inside the loader is acceptable, guarded
  // by a Platform.OS check in the same function.
  assert.ok(!/^\s*import\s[^;]*from\s+"@kingstinct\/react-native-healthkit"/m.test(source));
  assert.ok(!/import\s*\(\s*"@kingstinct\/react-native-healthkit"\s*\)/.test(source));
  assert.equal(
    (source.match(/require\("@kingstinct\/react-native-healthkit"\)/g) ?? []).length,
    1,
  );
  // The one require sits behind the iOS gate.
  const loader = source.slice(
    source.indexOf("function loadNativeHealthKit"),
    source.indexOf("const HEALTHKIT_READ_SCOPES"),
  );
  assert.ok(loader.includes('Platform.OS !== "ios"'));
  assert.ok(loader.includes('require("@kingstinct/react-native-healthkit")'));
});

test("the provider picker never imports a native module eagerly", () => {
  const source = readSource(HEALTH_PROVIDER_SOURCE);
  // The picker chooses per platform; the adapters it imports each keep their
  // own lazy require. A direct native import here would defeat that.
  assert.ok(!/react-native-health-connect/.test(source));
  assert.ok(!/@kingstinct\/react-native-healthkit/.test(source));
  // Both adapters are reached through the picker.
  assert.ok(/getHealthConnectProvider/.test(source));
  assert.ok(/getHealthKitProvider/.test(source));
});

test("the HealthKit adapter requests authorization before querying", () => {
  const source = readSource(HEALTH_KIT_SOURCE);
  // The library crashes when a read runs before the sheet was shown, so every
  // query path must pass through `ensureAuthorizationRequested` first.
  const sleepQueryIndex = source.indexOf("native.queryCategorySamples(");
  const sleepEnsureIndex = source.indexOf("await ensureAuthorizationRequested(native)");
  assert.ok(sleepEnsureIndex > 0, "the sleep path must ensure the request");
  assert.ok(
    sleepEnsureIndex < sleepQueryIndex,
    "the authorization request must precede the sleep query",
  );
});

/* ── authorization model ─────────────────────────────────────────── */

test("healthKitAuthorizationFromStatus never claims a grant or a denial", () => {
  // Only `unnecessary` (the sheet was already shown) counts as "requested".
  assert.deepEqual(
    healthKitAuthorizationFromStatus(
      HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.unnecessary,
    ),
    { kind: "unknown", requested: true },
  );
  // `shouldRequest` means it was never shown.
  assert.deepEqual(
    healthKitAuthorizationFromStatus(
      HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.shouldRequest,
    ),
    { kind: "unknown", requested: false },
  );
  // `unknown` from the platform is not an answer either.
  assert.deepEqual(healthKitAuthorizationFromStatus(HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.unknown), {
    kind: "unknown",
    requested: false,
  });
  // A failed status read (null) is "not requested yet", never "denied".
  assert.deepEqual(healthKitAuthorizationFromStatus(null), {
    kind: "unknown",
    requested: false,
  });
  // The status code values are HealthKit's own, mirrored without the enum.
  assert.equal(HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.unknown, 0);
  assert.equal(HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.shouldRequest, 1);
  assert.equal(HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.unnecessary, 2);
});

test("needsHealthKitAuthorizationRequest requests unless the sheet was shown", () => {
  assert.equal(
    needsHealthKitAuthorizationRequest(HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.unnecessary),
    false,
  );
  assert.equal(
    needsHealthKitAuthorizationRequest(HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.shouldRequest),
    true,
  );
  assert.equal(needsHealthKitAuthorizationRequest(HEALTHKIT_AUTHORIZATION_REQUEST_STATUS.unknown), true);
  // A status read that threw must lead to a request, not to a query: querying
  // first crashes the bridge.
  assert.equal(needsHealthKitAuthorizationRequest(null), true);
});

test("an iOS authorization gates the sleep read on the request, never on a grant", () => {
  const requested: HealthAuthorization = { kind: "unknown", requested: true };
  const notRequested: HealthAuthorization = { kind: "unknown", requested: false };
  assert.equal(sleepReadUsable(requested), true);
  assert.equal(sleepReadUsable(notRequested), false);
});

/* ── status line, per platform ───────────────────────────────────── */

test("the iOS status line has no permission-denied state to report", () => {
  // The complete iOS key set: a "no-permission" state cannot be produced
  // because HealthKit never reveals a read denial.
  const keys = new Set(
    (
      [
        [false, null, null],
        [true, null, null],
        [true, { kind: "supported" }, null],
        [true, { kind: "supported" }, { kind: "unknown", requested: true }],
        [true, { kind: "unavailable", reason: "platform" }, null],
        [true, { kind: "unavailable", reason: "not-found" }, null],
      ] as const
    ).map(([enabled, availability, authorization]) =>
      appleHealthStatusKey(enabled, availability, authorization ?? null),
    ),
  );
  for (const key of keys) {
    assert.ok(key !== ("no-permission" as string), "iOS must never claim a denial");
  }
});

test("healthStatusView never routes an iOS authorization into the Android rule", () => {
  // An `unknown` authorization reaching the Android arm must read as "supported"
  // (hydrating), never as a revocation the Android rule would invent.
  assert.deepEqual(
    healthStatusView("ios", true, { kind: "supported" }, { kind: "unknown", requested: true }),
    { platform: "ios", key: "authorization-unknown" },
  );
  assert.deepEqual(
    healthStatusView("android", true, { kind: "supported" }, { kind: "unknown", requested: false }),
    { platform: "android", key: "supported" },
  );
  assert.deepEqual(healthStatusView("other", true, { kind: "supported" }, null), {
    platform: "other",
    key: "platform",
  });
});

/* ── shared window helpers ───────────────────────────────────────── */

test("the shared night-window helpers match the offsets each adapter used before", () => {
  // Both adapters compute the window through these two helpers, so the DST-safe
  // per-edge offset rule is one implementation, not two drifting copies.
  assert.equal(previousIsoDate("2024-03-01"), "2024-02-29");
  assert.equal(previousIsoDate("2024-01-01"), "2023-12-31");
  assert.equal(previousIsoDate("not-a-date"), null);
  // The offset is a plausible minutes-east-of-UTC value for any real zone.
  const offset = tzOffsetMinutesForDate("2024-03-31");
  assert.ok(Number.isFinite(offset));
  assert.ok(offset >= -14 * 60 && offset <= 14 * 60);
});

test("healthPlatformFor is the single platform decision the picker uses", () => {
  assert.equal(healthPlatformFor("ios"), "ios");
  assert.equal(healthPlatformFor("android"), "android");
  assert.equal(healthPlatformFor("web"), "other");
});

/* ── review regressions (PR #54) ─────────────────────────────────── */

test("a failed authorization request stops the read instead of reporting no-data", () => {
  // Regression for the review finding: `ensureAuthorizationRequested` used to
  // discard the request outcome, so both query paths proceeded after a failed
  // request and an empty answer was reported as `no-data` — hiding a failure to
  // *ask* behind "nothing recorded". The gate must be a boolean the caller
  // checks, and the sleep path must return an error when it is false.
  const source = readSource(HEALTH_KIT_SOURCE);
  // The helper resolves a boolean, not void.
  assert.ok(
    /async function ensureAuthorizationRequested\(native: HealthKitNative\): Promise<boolean>/.test(
      source,
    ),
    "the authorization gate must resolve whether querying is safe",
  );
  // A sheet that was already shown needs no request.
  assert.ok(/if \(!needsHealthKitAuthorizationRequest\(status\)\) return true;/.test(source));
  // The request outcome is judged by the shared, tested rule.
  assert.ok(/return sleepReadUsable\(await requestReadAuthorization\(native\)\);/.test(source));
  // The sleep path refuses to query on a failed request and says why.
  const sleepGate = /if \(!\(await ensureAuthorizationRequested\(native\)\)\) \{\s*\n\s*return \{\s*\n\s*kind: "error"/;
  assert.ok(sleepGate.test(source), "a failed request must fail the sleep read, not fall through");
  // The recovery path stays optional: it returns no value rather than failing.
  assert.ok(
    /if \(!\(await ensureAuthorizationRequested\(native\)\)\) return null;/.test(source),
    "a failed request must make the optional recovery read yield no value",
  );
  // Neither query may run before the gate.
  for (const query of ["native.queryCategorySamples(", "native.queryQuantitySamples("]) {
    const gateIndex = source.indexOf("await ensureAuthorizationRequested(native)");
    const queryIndex = source.indexOf(query);
    assert.ok(gateIndex > 0 && gateIndex < queryIndex, `${query} must follow the gate`);
  }
});

test("the recovery value is tied to the newest imported night, not the first that has one", () => {
  // Regression for the review finding: the loop used `recoveryBpm === null` as
  // its stop condition, so a newest night with no sample left the slot open and
  // an older night's value was later labelled "last night". The attempt must be
  // tracked separately from its nullable result, and the notice must name the
  // night it describes.
  const source = readFileSync(
    new URL("../mobile/src/app/(tabs)/health.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    /let recoveryAttempted = false;/.test(source),
    "the attempt needs its own flag, separate from the nullable value",
  );
  // The stop condition is the attempt flag, never the value.
  assert.ok(
    /if \(platform === "ios" && !recoveryAttempted\) \{/.test(source),
    "only one night may be queried, whatever the result",
  );
  assert.ok(
    !/recoveryBpm === null\)\s*\{\s*\n\s*recoveryBpm = await/.test(source),
    "a null result must not allow a fall-through to an older night",
  );
  // The value is only shown together with the night it came from.
  assert.ok(
    /recoveryBpm === null \|\| recoveryDate === null/.test(source),
    "a value without its night must not be rendered",
  );
  assert.ok(/\{ bpm: recoveryBpm, date: recoveryDate \}/.test(source));
});

test("a failed enable-flow request is not reported as a shown sheet", () => {
  // Regression for the third review finding: when `requestReadPermissions`
  // answered `{ kind: "unknown", requested: false }` (the request itself
  // rejected), the enable flow rendered `applePermissionRequested` — "The
  // permission sheet was shown" — for a sheet that never appeared. The failure
  // needs its own copy; `applePermissionRequested` stays for completed
  // requests only.
  const source = readFileSync(
    new URL("../mobile/src/app/(tabs)/health.tsx", import.meta.url),
    "utf8",
  );
  // The unusable-authorization branch must not use the "shown" copy on iOS.
  const branch = source.slice(
    source.indexOf("if (!sleepReadUsable(authorization))"),
    source.indexOf("await writeHealthConnectEnabled(true)"),
  );
  assert.ok(branch.length > 0, "the enable flow must still gate on sleepReadUsable");
  assert.ok(
    branch.includes("copy.applePermissionRequestFailed"),
    "a failed request needs its own message",
  );
  assert.ok(
    !branch.includes("copy.applePermissionRequested"),
    "a failed request must not claim the sheet was shown",
  );
  // The success path still says the sheet was shown (that is all iOS reveals).
  assert.ok(
    /if \(platform === "ios"\) setHealthNotice\(t\(copy\.applePermissionRequested\)\);/.test(source),
  );
});
