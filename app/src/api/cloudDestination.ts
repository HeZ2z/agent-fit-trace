/**
 * Same-origin client for the daemon-local cloud destination setting (#87).
 *
 * This is intentionally separate from `CloudCoachingClient`: that client
 * carries coaching traffic to a destination, while this one configures which
 * destination the daemon's proxy may use. The routes exist only on the local
 * daemon; a hosted deployment answers 404 and the settings surface stays off.
 */
import {
  API_ERROR_CODES,
  ApiError,
  MalformedResponseError,
  parseCloudDestinationCheck,
  parseCloudDestinationStatus,
} from "@agent-fit-trace/api-contracts";
import type { CloudDestinationCheck, CloudDestinationStatus } from "@agent-fit-trace/api-contracts";

const DEFAULT_BASE_URL = "/api/v1";
/** The status/check payloads are tiny; never buffer an unbounded hostile body. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface CloudDestinationClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  getAccessToken: () => string | null | Promise<string | null>;
}

function assertSameOriginBase(baseUrl: string): void {
  if (
    baseUrl === "" ||
    baseUrl.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(baseUrl) ||
    !baseUrl.startsWith("/") ||
    baseUrl.includes("?") ||
    baseUrl.includes("#") ||
    baseUrl.includes("\\")
  ) {
    throw new ApiError({
      code: API_ERROR_CODES.VALIDATION_ERROR,
      message: "Cloud destination client baseUrl must stay same-origin (\"\" or a root-relative path).",
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError({
          code: API_ERROR_CODES.MALFORMED_RESPONSE,
          message: "Cloud server configuration response is too large.",
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function toApiError(parsed: unknown, status: number): ApiError {
  const error = isObject(parsed) ? parsed.error : undefined;
  if (isObject(error) && typeof error.code === "string" && typeof error.message === "string") {
    return new ApiError({ code: error.code, message: error.message, status });
  }
  return new ApiError({
    code: API_ERROR_CODES.API_ERROR,
    message: `The cloud server setting request failed with status ${String(status)}.`,
    status,
  });
}

function readData(parsed: unknown): unknown {
  if (!isObject(parsed) || !("data" in parsed)) {
    throw new MalformedResponseError("data", "is missing");
  }
  return parsed.data;
}

async function request(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  options: CloudDestinationClientOptions,
  body?: unknown,
): Promise<unknown> {
  const token = await options.getAccessToken();
  if (typeof token !== "string" || token === "") {
    throw new ApiError({
      code: API_ERROR_CODES.UNAUTHENTICATED,
      message: "Sign in to change the cloud server.",
      status: 401,
    });
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  assertSameOriginBase(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await readBoundedText(response);
  let parsed: unknown;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    throw new MalformedResponseError("(root)", "is not valid JSON");
  }
  if (!response.ok) throw toApiError(parsed, response.status);
  return readData(parsed);
}

export async function readCloudDestination(
  options: CloudDestinationClientOptions,
): Promise<CloudDestinationStatus> {
  return parseCloudDestinationStatus(await request("/coaching/cloud/destination", "GET", options));
}

export async function previewCloudDestination(
  address: string,
  options: CloudDestinationClientOptions,
): Promise<CloudDestinationCheck> {
  return parseCloudDestinationCheck(
    await request("/coaching/cloud/destination/preview", "POST", options, { address }),
  );
}

export async function confirmCloudDestination(
  address: string,
  confirmHost: string,
  options: CloudDestinationClientOptions,
): Promise<CloudDestinationStatus> {
  return parseCloudDestinationStatus(
    await request("/coaching/cloud/destination", "PUT", options, { address, confirmHost }),
  );
}

export async function resetCloudDestination(
  options: CloudDestinationClientOptions,
): Promise<CloudDestinationStatus> {
  return parseCloudDestinationStatus(await request("/coaching/cloud/destination", "DELETE", options));
}
