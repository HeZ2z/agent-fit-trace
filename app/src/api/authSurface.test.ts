import { describe, expect, it } from "vitest";
import {
  LOCAL_GUEST_BEARER,
  LOCAL_GUEST_PRINCIPAL_ID,
  resolveAuthSurface,
} from "./authSurface.ts";
import type { PublicApiConfig } from "@agent-fit-trace/api-contracts";

function config(fields: Partial<PublicApiConfig>): PublicApiConfig {
  return {
    supabaseUrl: "http://127.0.0.1:54321",
    supabasePublishableKey: "pub",
    guestSignInEnabled: false,
    guestUpgradeEnabled: false,
    guestSignInCaptchaRequired: false,
    ...fields,
  };
}

describe("resolveAuthSurface", () => {
  it("keeps the strict supabase gate when the daemon marker is absent", () => {
    expect(resolveAuthSurface(null)).toBe("supabase");
    expect(resolveAuthSurface(config({}))).toBe("supabase");
  });

  it("enters guest-local only for a daemon without a configured auth", () => {
    expect(
      resolveAuthSurface({
        supabaseUrl: "",
        supabasePublishableKey: "",
        daemon: true,
        auth_configured: false,
      }),
    ).toBe("guest-local");
  });

  it("keeps the optional-login surface when the daemon has auth configured", () => {
    expect(resolveAuthSurface(config({ daemon: true, auth_configured: true }))).toBe(
      "daemon-optional",
    );
  });

  it("fails closed for anything that is not an explicit boolean marker", () => {
    // Only the explicit marker pair selects guest-local; a daemon that omits
    // `auth_configured` keeps today's login gate, and only `daemon === true`
    // leaves the supabase surface at all.
    expect(resolveAuthSurface({ ...config({ daemon: true }) })).toBe("daemon-optional");
    expect(
      resolveAuthSurface(config({ daemon: false, auth_configured: true })),
    ).toBe("supabase");
  });

  it("pins the daemon wire constants their server counterparts define", () => {
    // Mirrors `LOCAL_DAEMON_BEARER` / `LOCAL_GUEST_PRINCIPAL_ID` in
    // `server/auth/localVerifier.ts`; redefined, never imported.
    expect(LOCAL_GUEST_BEARER).toBe("fit-trace-local-daemon");
    expect(LOCAL_GUEST_PRINCIPAL_ID).toBe("guest");
  });
});
