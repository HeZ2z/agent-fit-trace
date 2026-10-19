import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decidePreferences,
  isMetadataRecord,
  mapPreferencesErrorStatus,
  mergePreferenceMetadata,
  metadataFromUserResponse,
  parseAccountPreferences,
  PreferencesError,
  toPreferencesError,
  type LocalPreferences,
} from "../mobile/src/preferences/preferencesModel.ts";

/**
 * Pure coverage for account-scoped skin + language preferences. No React,
 * AsyncStorage, expo or network is imported: only the deterministic
 * reconciliation and parsing rules are exercised, so the root `node:test`
 * suite never needs a native runtime.
 */

const LOCAL: LocalPreferences = { skin: "pixel", language: "en" };

test("isMetadataRecord accepts plain objects only", () => {
  assert.equal(isMetadataRecord({}), true);
  assert.equal(isMetadataRecord({ skin: "glass" }), true);
  assert.equal(isMetadataRecord([]), false);
  assert.equal(isMetadataRecord(null), false);
  assert.equal(isMetadataRecord("glass"), false);
  assert.equal(isMetadataRecord(undefined), false);
});

test("parseAccountPreferences keeps valid fields and drops invalid ones", () => {
  assert.deepEqual(parseAccountPreferences({ skin: "glass", language: "zh" }), {
    skin: "glass",
    language: "zh",
  });
  assert.deepEqual(parseAccountPreferences({ skin: "glass" }), { skin: "glass" });
  assert.deepEqual(parseAccountPreferences({ language: "zh" }), { language: "zh" });

  // Unknown/invalid values are absent, not an error; the caller fills them.
  assert.deepEqual(parseAccountPreferences({ skin: "neon", language: "fr" }), {});
  assert.deepEqual(parseAccountPreferences({ skin: null, language: "" }), {});
  assert.deepEqual(parseAccountPreferences({ skin: 1, language: true }), {});
  assert.deepEqual(parseAccountPreferences(null), {});
  assert.deepEqual(parseAccountPreferences(undefined), {});
  assert.deepEqual(parseAccountPreferences("glass"), {});
  assert.deepEqual(parseAccountPreferences([]), {});
});

test("first sign-in uploads both local choices when the account has none", () => {
  assert.deepEqual(decidePreferences(undefined, LOCAL), {
    uploadLocal: { skin: "pixel", language: "en" },
  });
  assert.deepEqual(decidePreferences({}, LOCAL), {
    uploadLocal: { skin: "pixel", language: "en" },
  });
  // Missing and invalid metadata values are equally "not set yet".
  assert.deepEqual(decidePreferences({ skin: null, language: "" }, LOCAL), {
    uploadLocal: { skin: "pixel", language: "en" },
  });
  assert.deepEqual(decidePreferences({ skin: "neon", language: "fr" }, LOCAL), {
    uploadLocal: { skin: "pixel", language: "en" },
  });
});

test("account preferences win on sign-in and never get overwritten locally", () => {
  const account = { skin: "glass", language: "zh" };
  const decision = decidePreferences(account, LOCAL);

  assert.deepEqual(decision.applyLocal, { skin: "glass", language: "zh" });
  // Existing account values are never part of the upload patch.
  assert.equal(decision.uploadLocal, undefined);

  // Already-agreeing values produce no request at all.
  assert.deepEqual(
    decidePreferences(account, { skin: "glass", language: "zh" }),
    {},
  );

  // Partial metadata: apply what exists, upload only the missing field.
  assert.deepEqual(
    decidePreferences({ skin: "glass" }, { skin: "pixel", language: "zh" }),
    {
      applyLocal: { skin: "glass" },
      uploadLocal: { language: "zh" },
    },
  );
});

test("applying account values cannot echo back as a write", () => {
  const account = { skin: "glass", language: "zh" };
  const first = decidePreferences(account, LOCAL);
  assert.ok(first.applyLocal !== undefined);

  // The exact local state produced by applying the account is stable: a
  // re-render/reconciliation decides there is nothing left to apply or upload.
  const applied = { ...LOCAL, ...first.applyLocal };
  assert.deepEqual(decidePreferences(account, applied), {});

  // Partial metadata settles after the missing field is uploaded once.
  const partialAccount = { skin: "glass" };
  const local: LocalPreferences = { skin: "pixel", language: "zh" };
  const partial = decidePreferences(partialAccount, local);
  assert.deepEqual(partial.applyLocal, { skin: "glass" });
  assert.deepEqual(partial.uploadLocal, { language: "zh" });

  const merged = mergePreferenceMetadata(partialAccount, partial.uploadLocal ?? {});
  const afterPartial = { ...local, ...partial.applyLocal };
  assert.deepEqual(decidePreferences(merged, afterPartial), {});
});

test("mergePreferenceMetadata preserves unrelated account metadata", () => {
  assert.deepEqual(
    mergePreferenceMetadata(
      { display_name: "Ada", skin: "pixel", theme: "legacy" },
      { skin: "glass", language: "zh" },
    ),
    { display_name: "Ada", skin: "glass", theme: "legacy", language: "zh" },
  );
  assert.deepEqual(mergePreferenceMetadata(null, { language: "zh" }), {
    language: "zh",
  });
  assert.deepEqual(mergePreferenceMetadata("not metadata", { skin: "glass" }), {
    skin: "glass",
  });
  // An empty patch must not drop existing fields.
  assert.deepEqual(mergePreferenceMetadata({ skin: "glass" }, {}), {
    skin: "glass",
  });
});

test("metadataFromUserResponse reads user_metadata and fails closed on bad shapes", () => {
  assert.deepEqual(
    metadataFromUserResponse({
      id: "user-1",
      user_metadata: { skin: "glass", language: "zh" },
    }),
    { skin: "glass", language: "zh" },
  );
  // Missing/null metadata is an account with no preferences, not an error.
  assert.deepEqual(metadataFromUserResponse({ id: "user-1" }), {});
  assert.deepEqual(metadataFromUserResponse({ id: "user-1", user_metadata: null }), {});

  // A malformed response/container must not be overwritten with a fresh object.
  assert.equal(metadataFromUserResponse(null), null);
  assert.equal(metadataFromUserResponse([]), null);
  assert.equal(metadataFromUserResponse("user"), null);
  assert.equal(metadataFromUserResponse({ id: "user-1", user_metadata: [] }), null);
  assert.equal(metadataFromUserResponse({ id: "user-1", user_metadata: "glass" }), null);

  // The returned object is a copy: mutating it never mutates the response.
  const metadata = { skin: "glass" };
  const parsed = metadataFromUserResponse({ user_metadata: metadata });
  assert.ok(parsed !== null);
  parsed.skin = "pixel";
  assert.equal(metadata.skin, "glass");
});

test("mapPreferencesErrorStatus distinguishes transient and auth failures", () => {
  assert.equal(mapPreferencesErrorStatus(429), "rate-limited");
  assert.equal(mapPreferencesErrorStatus(500), "service-unavailable");
  assert.equal(mapPreferencesErrorStatus(503), "service-unavailable");
  assert.equal(mapPreferencesErrorStatus(401), "unauthorized");
  assert.equal(mapPreferencesErrorStatus(403), "unauthorized");
  assert.equal(mapPreferencesErrorStatus(400), "unknown");
  assert.equal(mapPreferencesErrorStatus(404), "unknown");
  assert.equal(mapPreferencesErrorStatus(422), "unknown");
});

test("toPreferencesError redacts unknown causes and preserves known ones", () => {
  const network = toPreferencesError(new TypeError("fetch failed"));
  assert.equal(network.code, "network");
  assert.equal(network.name, "PreferencesError");

  const known = new PreferencesError("invalid-response", { status: 200 });
  assert.equal(toPreferencesError(known), known);
  assert.equal(known.code, "invalid-response");
  assert.equal(known.status, 200);

  const unknown = toPreferencesError({ secret: "provider body" });
  assert.equal(unknown.code, "unknown");
  assert.equal(unknown.message, "unknown");
  assert.equal(unknown.status, undefined);
});
