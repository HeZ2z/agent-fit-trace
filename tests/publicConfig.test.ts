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

test("guest upgrade capability is off by default and requires the exact opt-in", () => {
  for (const value of [undefined, "", "0", "true", "YES", " 1 "]) {
    const env = value === undefined ? baseEnv : { ...baseEnv, FIT_TRACE_GUEST_UPGRADE: value };
    assert.equal(getPublicConfig(env)?.guestUpgradeEnabled, false);
  }
  assert.equal(
    getPublicConfig({ ...baseEnv, FIT_TRACE_GUEST_UPGRADE: "1" })?.guestUpgradeEnabled,
    true,
  );
});

test("required CAPTCHA is explicit and default-off", () => {
  assert.equal(getPublicConfig(baseEnv)?.guestSignInCaptchaRequired, false);
  assert.equal(
    getPublicConfig({ ...baseEnv, FIT_TRACE_GUEST_CAPTCHA_REQUIRED: "1" })
      ?.guestSignInCaptchaRequired,
    true,
  );
  for (const value of ["", "0", "true", "YES", " 1 "]) {
    assert.equal(
      getPublicConfig({ ...baseEnv, FIT_TRACE_GUEST_CAPTCHA_REQUIRED: value })
        ?.guestSignInCaptchaRequired,
      false,
    );
  }
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
