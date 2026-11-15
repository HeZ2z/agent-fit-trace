import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@agent-fit-trace/api-contracts";
import {
  confirmCloudDestination,
  previewCloudDestination,
  readCloudDestination,
  resetCloudDestination,
} from "./cloudDestination.ts";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OFFICIAL = {
  source: "official",
  destination: "https://cloud.example.test/api/v1",
  host: "cloud.example.test",
  officialDestination: "https://cloud.example.test/api/v1",
  issuer: "https://project.example.test",
  binding: "binding-official",
  consent: "not-applicable",
};

describe("cloud destination client", () => {
  it("reads the status with the caller's bearer", async () => {
    const fetchImpl = vi.fn(async () => response(OFFICIAL));
    const status = await readCloudDestination({ fetchImpl, getAccessToken: () => "token-a" });
    expect(status.source).toBe("official");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/coaching/cloud/destination",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer token-a" }),
      }),
    );
  });

  it("parses a failed preview as a normal check result, not a transport error", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        ok: false,
        error: {
          code: "CLOUD_DESTINATION_ISSUER_INCOMPATIBLE",
          message: "This server uses a different account service.",
        },
      }),
    );
    const check = await previewCloudDestination("https://other.example.test/api/v1", {
      fetchImpl,
      getAccessToken: () => "token-a",
    });
    expect(check.ok).toBe(false);
    expect(check.error?.code).toBe("CLOUD_DESTINATION_ISSUER_INCOMPATIBLE");
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown[])[1] && ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({
      address: "https://other.example.test/api/v1",
    });
  });

  it("sends the canonical host on confirmation and accepts both verbs", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.method).toBe("PUT");
      expect(body).toEqual({
        address: "https://custom.example.test/api/v1",
        confirmHost: "custom.example.test",
      });
      return response({ ...OFFICIAL, source: "user", destination: body.address, host: body.confirmHost, consent: "confirmed" });
    });
    const status = await confirmCloudDestination(
      "https://custom.example.test/api/v1",
      "custom.example.test",
      { fetchImpl, getAccessToken: () => "token-a" },
    );
    expect(status.consent).toBe("confirmed");

    const resetFetch = vi.fn(async () => response(OFFICIAL));
    expect((await resetCloudDestination({ fetchImpl: resetFetch, getAccessToken: () => "token-a" })).source).toBe("official");
    expect((resetFetch.mock.calls[0] as unknown[])[1]).toMatchObject({ method: "DELETE" });
  });

  it("fails closed without a token and surfaces daemon error codes", async () => {
    const fetchImpl = vi.fn();
    await expect(
      readCloudDestination({ fetchImpl, getAccessToken: () => null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      readCloudDestination({
        fetchImpl: async () => errorResponse("CLOUD_DESTINATION_CONSENT_REQUIRED", "Confirm the server first.", 403),
        getAccessToken: () => "token-a",
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses a non-same-origin base", async () => {
    await expect(
      readCloudDestination({
        baseUrl: "https://cloud.example.test/api/v1",
        fetchImpl: async () => response(OFFICIAL),
        getAccessToken: () => "token-a",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
