import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  MAX_COACHING_SSE_FRAME_BYTES,
  MalformedResponseError,
  NetworkError,
} from "@pi-fit-trace/api-contracts";
import type { CoachingEventEnvelope } from "@pi-fit-trace/api-contracts";
import { CloudCoachingClient } from "./cloudCoachingClient.ts";

const SESSION = "s-1";
const RUN = "r-1";
const EVENTS_PATH = `/api/v1/coaching/cloud/runs/${RUN}/events`;

interface SeenRequest {
  url: string;
  method: string;
  authorization: string | null;
}

function envelope(seq: number, event: CoachingEventEnvelope["event"]): CoachingEventEnvelope {
  return { protocolVersion: 1, sessionId: SESSION, runId: RUN, seq, event };
}

function frame(entry: CoachingEventEnvelope): string {
  return `id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`;
}

function sseResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function textResponse(text: string): Response {
  return sseResponse([new TextEncoder().encode(text)]);
}

function pagesFetch(pages: Response[], seen: SeenRequest[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      authorization: headers.get("authorization"),
    });
    const page = pages.shift();
    if (page === undefined) throw new Error(`unexpected fetch: ${url}`);
    return page;
  }) as typeof fetch;
}

function client(fetchImpl: typeof fetch, initialBackoffMs = 5, maxTailMs = 5_000) {
  return new CloudCoachingClient({
    fetchImpl,
    getAccessToken: () => "token-a",
    tail: { initialBackoffMs, maxBackoffMs: initialBackoffMs, maxTailMs },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("CloudCoachingClient.subscribeRunEvents", () => {
  it("tails two GET pages to the terminal without a second POST", async () => {
    const seen: SeenRequest[] = [];
    const first = frame(envelope(0, { type: "text_delta", delta: "cloud ✓" }));
    const firstBytes = new TextEncoder().encode(first);
    // Split inside the UTF-8 ellipsis/check sequence: the incremental decoder
    // must not corrupt a multibyte character at a chunk boundary.
    const checkLead = firstBytes.indexOf(0xe2);
    const pages = [
      sseResponse([firstBytes.slice(0, checkLead + 1), firstBytes.slice(checkLead + 1)]),
      textResponse(frame(envelope(1, { type: "terminal", status: "completed" }))),
    ];
    const received: CoachingEventEnvelope[] = [];
    const subscription = client(pagesFetch(pages, seen)).subscribeRunEvents(
      { runId: RUN, sessionId: SESSION, fromSeq: 0 },
      (entry) => received.push(entry),
    );

    await expect(subscription.done).resolves.toEqual({ aborted: false, lastConsumed: 1 });
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(received[0]?.event).toEqual({ type: "text_delta", delta: "cloud ✓" });
    expect(seen.map((entry) => entry.url)).toEqual([
      `${EVENTS_PATH}?fromSeq=0`,
      `${EVENTS_PATH}?fromSeq=1`,
    ]);
    expect(seen.every((entry) => entry.method === "GET")).toBe(true);
    expect(seen[0]?.authorization).toBe("Bearer token-a");
  });

  it("backs off after an empty successful page instead of hot-looping", async () => {
    const seen: SeenRequest[] = [];
    const pages = [
      textResponse(""),
      textResponse(frame(envelope(0, { type: "terminal", status: "completed" }))),
    ];
    const subscription = client(pagesFetch(pages, seen), 40).subscribeRunEvents(
      { runId: RUN, sessionId: SESSION, fromSeq: 0 },
      () => {},
    );

    await waitFor(() => seen.length === 1);
    const firstAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toHaveLength(1);
    await expect(subscription.done).resolves.toEqual({ aborted: false, lastConsumed: 0 });
    expect(seen).toHaveLength(2);
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(25);
    expect(seen[1]?.url).toContain("fromSeq=0");
  });

  it("cancels an active page reader on close without a further GET", async () => {
    const seen: SeenRequest[] = [];
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            frame(envelope(0, { type: "text_delta", delta: "partial cloud" })),
          ),
        );
        // Stay open: the reader is parked waiting for the next page event.
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
    const received: CoachingEventEnvelope[] = [];
    const subscription = client(pagesFetch([response], seen)).subscribeRunEvents(
      { runId: RUN, sessionId: SESSION, fromSeq: 0 },
      (entry) => received.push(entry),
    );

    await waitFor(() => received.length === 1);
    subscription.close();
    await expect(subscription.done).resolves.toEqual({ aborted: true, lastConsumed: 0 });
    await waitFor(() => cancelled);
    expect(seen).toHaveLength(1);
  });

  it("aborts the backoff and issues no further GET", async () => {
    const seen: SeenRequest[] = [];
    const pages = [
      textResponse(""),
      textResponse(frame(envelope(0, { type: "terminal", status: "completed" }))),
    ];
    const subscription = client(pagesFetch(pages, seen), 60).subscribeRunEvents(
      { runId: RUN, sessionId: SESSION, fromSeq: 0 },
      () => {},
    );

    await waitFor(() => seen.length === 1);
    subscription.close();
    await expect(subscription.done).resolves.toEqual({ aborted: true, lastConsumed: -1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(seen).toHaveLength(1);
  });

  it("refuses an oversized frame instead of buffering it", async () => {
    const seen: SeenRequest[] = [];
    const oversized = textResponse("x".repeat(MAX_COACHING_SSE_FRAME_BYTES + 1));
    const subscription = client(pagesFetch([oversized], seen)).subscribeRunEvents(
      { runId: RUN, sessionId: SESSION, fromSeq: 0 },
      () => {},
    );

    await expect(subscription.done).rejects.toBeInstanceOf(MalformedResponseError);
    expect(seen).toHaveLength(1);
  });

  it("bounds an oversized error body and keeps the API failure", async () => {
    const seen: SeenRequest[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024));
        // Stay open: an unbounded reader would wait forever here.
      },
    });
    const response = new Response(stream, { status: 500 });
    const subscription = client(pagesFetch([response], seen)).subscribeRunEvents(
      { runId: RUN, sessionId: SESSION, fromSeq: 0 },
      () => {},
    );

    await expect(subscription.done).rejects.toMatchObject({
      code: API_ERROR_CODES.API_ERROR,
      status: 500,
    });
    expect(seen).toHaveLength(1);
  });

  it("ends with an ambiguous error at the bounded tail time budget", async () => {
    const seen: SeenRequest[] = [];
    const fetchAlwaysEmpty = (async (input: unknown, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        authorization: null,
      });
      return textResponse("");
    }) as typeof fetch;
    const subscription = client(fetchAlwaysEmpty, 10, 60).subscribeRunEvents(
      { runId: RUN, sessionId: SESSION, fromSeq: 0 },
      () => {},
    );

    await expect(subscription.done).rejects.toBeInstanceOf(NetworkError);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThan(20);
    expect(seen.every((entry) => entry.method === "GET")).toBe(true);
  });
});

describe("CloudCoachingClient non-SSE body bounds", () => {
  function hugeResponse(status: number): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        // Stay open: an unbounded reader would keep buffering.
      },
    });
    return new Response(stream, {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function jsonClient(status: number): CloudCoachingClient {
    return new CloudCoachingClient({
      fetchImpl: (async () => hugeResponse(status)) as typeof fetch,
      getAccessToken: () => "token-a",
    });
  }

  it("refuses an oversized success body instead of buffering it", async () => {
    await expect(jsonClient(200).readCapabilities()).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
  });

  it("turns an oversized error body into a bounded API failure", async () => {
    await expect(jsonClient(500).readCapabilities()).rejects.toMatchObject({
      code: API_ERROR_CODES.API_ERROR,
      status: 500,
    });
  });
});

describe("CloudCoachingClient default fetch receiver", () => {
  it("calls the global fetch with globalThis, never the client object", async () => {
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    const capabilities = {
      enabled: true,
      providerConfigured: true,
      providerEnabled: true,
      accountFormal: true,
      quotaConfigured: true,
      budgetConfigured: true,
      concurrentLimit: 4,
      reservedCount: 0,
      tokensRemaining: 200_000,
      tokensReserved: 0,
      perRunTokenBudget: 20_000,
      perStepTokenBudget: 4_096,
      perRunRequestLimit: 8,
      tools: ["get_training_history", "analyze_progress"],
      maxSteps: 4,
      maxTokens: 2_048,
      timeoutMs: 60_000,
    };
    globalThis.fetch = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(
        new Response(JSON.stringify({ data: capabilities }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof fetch;
    try {
      const unbound = new CloudCoachingClient({ getAccessToken: () => "token-a" });
      await expect(unbound.readCapabilities()).resolves.toMatchObject({
        providerConfigured: true,
      });
      expect(receivers).toHaveLength(1);
      expect(receivers[0]).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});
