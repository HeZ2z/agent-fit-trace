import assert from "node:assert/strict";
import { test } from "node:test";

import { getPublicConfig } from "../server/publicConfig.ts";

const baseEnv = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "public-anon-key",
};

test("guest sign-in capability is off by default", () => {
  const config = getPublicConfig({ ...baseEnv });
  assert.equal(config?.guestSignInEnabled, false);
  for (const value of ["", "0", "true", "YES", " 1 "]) {
    assert.equal(getPublicConfig({ ...baseEnv, FIT_TRACE_GUEST_SIGN_IN: value })?.guestSignInEnabled, false);
  }
});

test("guest sign-in capability requires the exact opt-in", () => {
  assert.equal(
    getPublicConfig({ ...baseEnv, FIT_TRACE_GUEST_SIGN_IN: "1" })?.guestSignInEnabled,
    true,
  );
});

test("guest capability is never served without a valid public config", () => {
  assert.equal(
    getPublicConfig({ FIT_TRACE_GUEST_SIGN_IN: "1" }),
    null,
  );
  assert.equal(
    getPublicConfig({ ...baseEnv, SUPABASE_PUBLISHABLE_KEY: "sb_secret_nope", FIT_TRACE_GUEST_SIGN_IN: "1" }),
    null,
  );
});
