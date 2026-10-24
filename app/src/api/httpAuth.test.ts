import { describe, expect, it } from "vitest";
import { analyzeProgress, validateWorkoutRecord } from "@agent-fit-trace/core";
import {
  API_ERROR_CODES,
  ApiError,
  buildImportedArtifact,
  MalformedResponseError,
} from "@agent-fit-trace/api-contracts";
import { HttpFitTraceClient } from "./httpFitTraceClient.ts";
import type { HttpResponseLike } from "./httpFitTraceClient.ts";
import { fetchPublicConfig } from "./publicConfig.ts";

function seedRecord() {
  return validateWorkoutRecord({
    schema_version: 1,
    id: "w-1",
    date: "2026-09-01",
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 80, reps: 5, rpe: 7 }] }],
  }).record;
}

describe("HttpFitTraceClient credentials", () => {
  it("attaches the bearer token per request", async () => {
    const seen: Record<string, string>[] = [];
    const client = new HttpFitTraceClient({
      getAccessToken: () => "session-token",
      fetchImpl: (async (_input: string, init?: { headers?: Record<string, string> }) => {
        seen.push(init?.headers ?? {});
        return {
          status: 200,
          text: () => JSON.stringify({ data: [] }),
        } satisfies HttpResponseLike;
      }) as HttpFitTraceClient["fetchImpl"],
    });
    await client.listWorkouts();
    expect(seen[0]?.authorization).toBe("Bearer session-token");
  });

  it("binds a snapshot save to the account token captured before digesting", async () => {
    const input = {
      kind: "analysis",
      payload_schema_version: 1,
      payload: analyzeProgress([seedRecord()]),
      source_filename: "analysis.json",
    } as const;
    const stored = await buildImportedArtifact(input, {
      created_at: "2026-09-01T00:00:00.000Z",
    });

    // The live session switches from A to B while the digest await is in
    // flight (as a cross-tab sign-in would). The save must still carry A's
    // captured token; it must never resolve B's token for A's file.
    let token: string | null = "token-a";
    const seenAuthorization: (string | undefined)[] = [];
    const client = new HttpFitTraceClient({
      getAccessToken: () => {
        const captured = token;
        token = "token-b";
        return captured;
      },
      fetchImpl: (async (_input: string, init?: { headers?: Record<string, string> }) => {
        seenAuthorization.push(init?.headers?.authorization);
        return {
          status: 201,
          text: () =>
            JSON.stringify({
              data: { artifact: stored, duplicate: false, warnings: [] },
            }),
        } satisfies HttpResponseLike;
      }) as HttpFitTraceClient["fetchImpl"],
    });

    const result = await client.saveImportedArtifact(input);

    expect(seenAuthorization).toEqual(["Bearer token-a"]);
    expect(result.artifact.id).toBe(stored.id);
  });

  it("sends no credentials when signed out (server answers 401)", async () => {
    let headers: Record<string, string> | undefined;
    const client = new HttpFitTraceClient({
      getAccessToken: () => null,
      fetchImpl: (async (_input: string, init?: { headers?: Record<string, string> }) => {
        headers = init?.headers;
        return {
          status: 401,
          text: () =>
            JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } }),
        } satisfies HttpResponseLike;
      }) as HttpFitTraceClient["fetchImpl"],
    });
    const error = await client.listWorkouts().catch((caught: unknown) => caught);
    expect(headers?.authorization).toBeUndefined();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(API_ERROR_CODES.UNAUTHENTICATED);
    expect((error as ApiError).status).toBe(401);
  });

  it("maps 403 FORBIDDEN and never retries a 401 write", async () => {
    let requests = 0;
    const client = new HttpFitTraceClient({
      getAccessToken: () => "stale-token",
      fetchImpl: (async () => {
        requests += 1;
        return {
          status: 403,
          text: () => JSON.stringify({ error: { code: "FORBIDDEN", message: "Denied." } }),
        } satisfies HttpResponseLike;
      }) as HttpFitTraceClient["fetchImpl"],
    });
    const forbidden = await client.analyze().catch((caught: unknown) => caught);
    expect(forbidden).toBeInstanceOf(ApiError);
    expect((forbidden as ApiError).code).toBe(API_ERROR_CODES.FORBIDDEN);

    let writes = 0;
    const writer = new HttpFitTraceClient({
      getAccessToken: () => "stale-token",
      fetchImpl: (async () => {
        writes += 1;
        return {
          status: 401,
          text: () =>
            JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Expired." } }),
        } satisfies HttpResponseLike;
      }) as HttpFitTraceClient["fetchImpl"],
    });
    const failed = await writer.createWorkout(seedRecord()).catch((caught: unknown) => caught);
    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).code).toBe(API_ERROR_CODES.UNAUTHENTICATED);
    expect(writes).toBe(1);
  });

  it("does not replay a failed 401 write after credentials recover", async () => {
    const seenAuth: (string | undefined)[] = [];
    let token: string | null = "stale-token";
    let writes = 0;
    const client = new HttpFitTraceClient({
      getAccessToken: () => token,
      fetchImpl: (async (_input: string, init?: { headers?: Record<string, string> }) => {
        writes += 1;
        seenAuth.push(init?.headers?.authorization);
        return {
          status: 401,
          text: () =>
            JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Expired." } }),
        } satisfies HttpResponseLike;
      }) as HttpFitTraceClient["fetchImpl"],
    });
    const failed = await client.createWorkout(seedRecord()).catch((caught: unknown) => caught);
    expect((failed as ApiError).code).toBe(API_ERROR_CODES.UNAUTHENTICATED);
    // Credentials recover (as after a refresh); the failed write is never replayed.
    token = "fresh-token";
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes).toBe(1);
    expect(seenAuth).toEqual(["Bearer stale-token"]);
  });
});

describe("fetchPublicConfig", () => {
  it("returns the public fields and rejects secret-bearing shapes", async () => {
    const ok = (async () =>
      new Response(
        JSON.stringify({
          data: { supabaseUrl: "http://x", supabasePublishableKey: "pub" },
        }),
      )) as unknown as typeof fetch;
    expect(await fetchPublicConfig("/api/v1", ok)).toEqual({
      supabaseUrl: "http://x",
      supabasePublishableKey: "pub",
      guestSignInEnabled: false,
      guestUpgradeEnabled: false,
      guestSignInCaptchaRequired: false,
    });

    const enabled = (async () =>
      new Response(
        JSON.stringify({
          data: {
            supabaseUrl: "http://x",
            supabasePublishableKey: "pub",
            guestSignInEnabled: true,
            guestUpgradeEnabled: true,
            guestSignInCaptchaRequired: true,
          },
        }),
      )) as unknown as typeof fetch;
    expect(await fetchPublicConfig("/api/v1", enabled)).toEqual({
      supabaseUrl: "http://x",
      supabasePublishableKey: "pub",
      guestSignInEnabled: true,
      guestUpgradeEnabled: true,
      guestSignInCaptchaRequired: true,
    });

    const malformedCapability = (async () =>
      new Response(
        JSON.stringify({
          data: {
            supabaseUrl: "http://x",
            supabasePublishableKey: "pub",
            guestSignInEnabled: "yes",
          },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchPublicConfig("/api/v1", malformedCapability)).rejects.toThrow(
      /guestSignInEnabled/,
    );

    const malformedUpgrade = (async () =>
      new Response(
        JSON.stringify({
          data: {
            supabaseUrl: "http://x",
            supabasePublishableKey: "pub",
            guestUpgradeEnabled: "yes",
          },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchPublicConfig("/api/v1", malformedUpgrade)).rejects.toThrow(
      /guestUpgradeEnabled/,
    );

    const malformedCaptcha = (async () =>
      new Response(
        JSON.stringify({
          data: {
            supabaseUrl: "http://x",
            supabasePublishableKey: "pub",
            guestSignInCaptchaRequired: "yes",
          },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchPublicConfig("/api/v1", malformedCaptcha)).rejects.toThrow(
      /guestSignInCaptchaRequired/,
    );

    const empty = (async () => new Response(JSON.stringify({ data: {} }))) as unknown as typeof fetch;
    await expect(fetchPublicConfig("/api/v1", empty)).rejects.toThrow(/supabaseUrl/);
  });

  it("parses the additive daemon markers strictly and backward compatibly", async () => {
    // Guest-local daemon: no Supabase project is configured, so the Supabase
    // fields are legitimately absent and the config boots the local guest.
    const daemonGuest = (async () =>
      new Response(
        JSON.stringify({ data: { daemon: true, auth_configured: false } }),
      )) as unknown as typeof fetch;
    expect(await fetchPublicConfig("/api/v1", daemonGuest)).toEqual({
      supabaseUrl: "",
      supabasePublishableKey: "",
      guestSignInEnabled: false,
      guestUpgradeEnabled: false,
      guestSignInCaptchaRequired: false,
      daemon: true,
      auth_configured: false,
    });

    // A configured daemon keeps every Supabase field and adds the markers.
    const daemonConfigured = (async () =>
      new Response(
        JSON.stringify({
          data: {
            supabaseUrl: "http://x",
            supabasePublishableKey: "pub",
            daemon: true,
            auth_configured: true,
          },
        }),
      )) as unknown as typeof fetch;
    expect(await fetchPublicConfig("/api/v1", daemonConfigured)).toEqual({
      supabaseUrl: "http://x",
      supabasePublishableKey: "pub",
      guestSignInEnabled: false,
      guestUpgradeEnabled: false,
      guestSignInCaptchaRequired: false,
      daemon: true,
      auth_configured: true,
    });

    // Markers must be booleans when present; any other shape is a typed
    // MalformedResponseError naming the offending field.
    const malformedDaemon = (async () =>
      new Response(
        JSON.stringify({
          data: { supabaseUrl: "http://x", supabasePublishableKey: "pub", daemon: "yes" },
        }),
      )) as unknown as typeof fetch;
    const daemonError = await fetchPublicConfig("/api/v1", malformedDaemon).catch(
      (caught: unknown) => caught,
    );
    expect(daemonError).toBeInstanceOf(MalformedResponseError);
    expect(daemonError).toMatchObject({ field: "daemon", code: "MALFORMED_RESPONSE" });

    const malformedAuthConfigured = (async () =>
      new Response(
        JSON.stringify({
          data: {
            supabaseUrl: "http://x",
            supabasePublishableKey: "pub",
            auth_configured: 1,
          },
        }),
      )) as unknown as typeof fetch;
    const authConfiguredError = await fetchPublicConfig("/api/v1", malformedAuthConfigured).catch(
      (caught: unknown) => caught,
    );
    expect(authConfiguredError).toBeInstanceOf(MalformedResponseError);
    expect(authConfiguredError).toMatchObject({ field: "auth_configured" });

    // A guest-local daemon still rejects malformed capability flags.
    const malformedGuestFlag = (async () =>
      new Response(
        JSON.stringify({
          data: { daemon: true, auth_configured: false, guestSignInEnabled: "yes" },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchPublicConfig("/api/v1", malformedGuestFlag)).rejects.toThrow(
      /guestSignInEnabled/,
    );

    // Without the guest-local marker pair, missing Supabase fields still fail
    // closed exactly as before (Vercel/launcher payloads unchanged).
    const daemonWithoutAuth = (async () =>
      new Response(JSON.stringify({ data: { daemon: true } }))) as unknown as typeof fetch;
    await expect(fetchPublicConfig("/api/v1", daemonWithoutAuth)).rejects.toThrow(/supabaseUrl/);
  });

  it("rejects secret-looking keys instead of publishing them", async () => {
    const secret = (async () =>
      new Response(
        JSON.stringify({
          data: { supabaseUrl: "http://x", supabasePublishableKey: "sb_secret_abc" },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchPublicConfig("/api/v1", secret)).rejects.toThrow(/publishable key/);

    // JWT with role service_role must never reach the browser.
    const header = btoa(JSON.stringify({ alg: "HS256" }));
    const payload = btoa(JSON.stringify({ role: "service_role" })).replace(/\+/g, "-").replace(/\//g, "_");
    const serviceJwt = `${header}.${payload}.sig`;
    const jwt = (async () =>
      new Response(
        JSON.stringify({ data: { supabaseUrl: "http://x", supabasePublishableKey: serviceJwt } }),
      )) as unknown as typeof fetch;
    await expect(fetchPublicConfig("/api/v1", jwt)).rejects.toThrow(/publishable key/);
  });
});
