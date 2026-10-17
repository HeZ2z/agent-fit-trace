import { describe, expect, it } from "vitest";
import { validateWorkoutRecord } from "@pi-fit-trace/core";
import { API_ERROR_CODES, ApiError } from "@pi-fit-trace/api-contracts";
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
