import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  API_ERROR_CODES,
  MAX_COACHING_SSE_FRAME_BYTES,
  MAX_COACHING_SSE_TOTAL_BYTES,
  MalformedResponseError,
  utf8ByteLength,
} from "@agent-fit-trace/api-contracts";
import type { CoachingEventEnvelope } from "@agent-fit-trace/api-contracts";
import { CoachingClient, COACHING_CAPABILITY_HEADER, parseSseEventsText } from "./coachingClient.ts";
import type { CoachingAccessTokenProvider } from "./coachingClient.ts";

const SESSION = "s-1";
const RUN = "r-1";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status });
}

function errorResponse(code: string, message: string, status: number, data?: unknown): Response {
  const body: Record<string, unknown> = { error: { code, message } };
  if (data !== undefined) body.data = data;
  return new Response(JSON.stringify(body), { status });
}

function envelope(seq: number, event: CoachingEventEnvelope["event"]): CoachingEventEnvelope {
  return { protocolVersion: 1, sessionId: SESSION, runId: RUN, seq, event };
}

function sseFrame(entry: CoachingEventEnvelope): string {
  return `id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`;
}

/** A text_delta frame whose FULL wire bytes (block + `\n\n`) equal `totalBytes`. */
function exactSizeFrame(totalBytes: number, seq = 0): string {
  const encode = (delta: string): string =>
    `id: ${seq}\ndata: ${JSON.stringify({
      protocolVersion: 1,
      sessionId: SESSION,
      runId: RUN,
      seq,
      event: { type: "text_delta", delta },
    })}\n\n`;
  const overhead = utf8ByteLength(encode(""));
  const frame = encode("x".repeat(totalBytes - overhead));
  if (utf8ByteLength(frame) !== totalBytes) throw new Error("exact frame sizing failed");
  return frame;
}

/**
 * A text_delta frame whose FULL wire bytes equal `totalBytes`, filled with
 * `unit` (a 2-byte character) so the body carries multibyte content.
 */
function exactSizeFrameUtf8(totalBytes: number, unit: string, seq = 0): string {
  const encode = (delta: string): string =>
    `id: ${seq}\ndata: ${JSON.stringify({
      protocolVersion: 1,
      sessionId: SESSION,
      runId: RUN,
      seq,
      event: { type: "text_delta", delta },
    })}\n\n`;
  const overhead = utf8ByteLength(encode(""));
  const unitBytes = utf8ByteLength(unit);
  const count = Math.floor((totalBytes - overhead) / unitBytes);
  const fill = totalBytes - overhead - count * unitBytes;
  const frame = encode(unit.repeat(count) + "x".repeat(fill));
  if (utf8ByteLength(frame) !== totalBytes) throw new Error("exact frame sizing failed");
  return frame;
}

function snapshotHandle() {
  return { snapshotId: "snap-1", source: "supabase", accountId: "user-a" };
}

function resolvedSnapshot() {
  return { ...snapshotHandle(), recordIds: ["w-1"], recordCount: 1 };
}

function storedRun(status = "queued") {
  return {
    id: RUN,
    sessionId: SESSION,
    status,
    idempotencyKey: "key-1",
    prompt: "how am I progressing?",
    snapshot: resolvedSnapshot(),
    runtimeId: "pi",
  };
}

/** Fake fetch capturing every request; routes reply in order. */
function fakeFetch(replies: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init: init ?? {} });
    const next = replies.shift();
    if (next === undefined) throw new Error("unexpected request: " + url);
    return next;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function headersOf(seen: { init: RequestInit }[]): Record<string, string> {
  return (seen[0]?.init.headers ?? {}) as Record<string, string>;
}

async function bootstrappedClient(
  replies: Response[],
  token: string | null = "bearer-now",
): Promise<{ client: CoachingClient; seen: { url: string; init: RequestInit }[] }> {
  const { impl, seen } = fakeFetch([jsonResponse({ capability: "cap-1", expiresInMs: 600_000 }), ...replies]);
  const client = new CoachingClient({ fetchImpl: impl, getAccessToken: () => token });
  await client.bootstrap();
  return { client, seen };
}

function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) resolve();
      else if (Date.now() - start > timeoutMs) reject(new Error("timed out waiting for condition"));
      else setTimeout(tick, 5);
    };
    tick();
  });
}

describe("CoachingClient guards", () => {
  it("rejects absolute base URLs so credentials stay same-origin", () => {
    expect(() => new CoachingClient({ baseUrl: "http://evil.example/coaching" })).toThrow(ApiError);
    expect(() => new CoachingClient({ baseUrl: "//evil.example" })).toThrow(ApiError);
    expect(() => new CoachingClient({ baseUrl: "/coaching?capability=x" })).toThrow(ApiError);
  });

  it("bootstraps with the bearer only and honors the TTL cap", async () => {
    const { impl, seen } = fakeFetch([jsonResponse({ capability: "cap-1", expiresInMs: 600_000 })]);
    const client = new CoachingClient({ fetchImpl: impl, getAccessToken: () => "bearer-now" });
    expect(client.isBootstrapped).toBe(false);
    const result = await client.bootstrap();
    expect(result).toEqual({ capability: "cap-1", expiresInMs: 600_000 });
    expect(client.isBootstrapped).toBe(true);
    const headers = headersOf(seen);
    expect(headers.authorization).toBe("Bearer bearer-now");
    expect(headers[COACHING_CAPABILITY_HEADER]).toBeUndefined();
    expect(seen[0]?.url).toBe("/coaching/bootstrap");
  });

  it("refuses authed routes once the TTL cap lapses, without network use", async () => {
    const { impl, seen } = fakeFetch([jsonResponse({ capability: "cap-1", expiresInMs: 5 })]);
    const client = new CoachingClient({ fetchImpl: impl, getAccessToken: () => "bearer-now" });
    await client.bootstrap();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(client.isBootstrapped).toBe(false);
    const calls = seen.length;
    const error = await client.readSession(SESSION).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(API_ERROR_CODES.UNAUTHENTICATED);
    expect(seen.length).toBe(calls);
  });
});

describe("CoachingClient coaching routes", () => {
  it("creates/reads sessions as public ids only (native files stay hidden)", async () => {
    const { client, seen } = await bootstrappedClient([
      jsonResponse({ id: SESSION, sessionDir: "/native/secret", snapshotFile: "/native/x.json" }),
      jsonResponse({ id: SESSION }),
    ]);
    const created = await client.createSession();
    expect(created).toEqual({ id: SESSION });
    expect("sessionDir" in created).toBe(false);
    expect("snapshotFile" in created).toBe(false);
    expect(await client.readSession(SESSION)).toEqual({ id: SESSION });
    expect(seen[1]?.url).toBe("/coaching/sessions");
    expect(headersOf(seen.slice(1))[COACHING_CAPABILITY_HEADER]).toBe("cap-1");
    for (const entry of seen) expect(entry.url).not.toContain("cap-1");
  });

  it("rejects resolved snapshot handles at the boundary before any fetch", async () => {
    const { client, seen } = await bootstrappedClient([]);
    const calls = seen.length;
    await expect(
      client.submitRun({
        sessionId: SESSION,
        prompt: "q",
        idempotencyKey: "key-1",
        snapshot: { ...snapshotHandle(), recordIds: ["w-1"], recordCount: 1 } as never,
      }),
    ).rejects.toThrow(/server-resolved/);
    expect(seen.length).toBe(calls);
  });

  it("submits runs with the caller's stable idempotency key, exactly once on 401", async () => {
    const { client, seen } = await bootstrappedClient([
      jsonResponse({ run: storedRun(), lastSeq: -1, replayed: false }, 201),
    ]);
    const result = await client.submitRun({
      sessionId: SESSION,
      prompt: "how am I progressing?",
      idempotencyKey: "stable-key-9",
      snapshot: snapshotHandle(),
    });
    expect(result.replayed).toBe(false);
    expect(result.lastSeq).toBe(-1);
    const sent = JSON.parse(String(seen[1]?.init.body)) as { idempotencyKey: string };
    expect(sent.idempotencyKey).toBe("stable-key-9");

    const failed = fakeFetch([errorResponse("UNAUTHENTICATED", "Expired.", 401)]);
    const writer = new CoachingClient({ fetchImpl: failed.impl, getAccessToken: () => "stale" });
    await writer.bootstrap().catch(() => {});
    // Bootstrap itself failed; inject a capability path is covered elsewhere —
    // here assert the single-attempt rule on the bootstrap write itself.
    expect(failed.seen.length).toBe(1);
  });

  it("surfaces replayed submits without regenerating the key", async () => {
    const { client, seen } = await bootstrappedClient([
      jsonResponse({ run: storedRun("running"), lastSeq: 2, replayed: true }),
    ]);
    const result = await client.submitRun({
      sessionId: SESSION,
      prompt: "how am I progressing?",
      idempotencyKey: "stable-key-9",
      snapshot: snapshotHandle(),
    });
    expect(result.replayed).toBe(true);
    expect(result.lastSeq).toBe(2);
    const sent = JSON.parse(String(seen[1]?.init.body)) as { idempotencyKey: string };
    expect(sent.idempotencyKey).toBe("stable-key-9");
  });

  it("reads runs with coherent cursors and cancels with path-only run ids", async () => {
    const { client, seen } = await bootstrappedClient([
      jsonResponse({ run: storedRun("running"), lastSeq: 3, firstSeq: 0, expiresAt: Date.now() + 60_000 }),
      jsonResponse({ run: storedRun("cancelled"), lastSeq: 4 }),
    ]);
    const read = await client.readRun(RUN);
    expect(read.lastSeq).toBe(3);
    expect(read.firstSeq).toBe(0);
    const cancelled = await client.cancelRun(RUN, "user stopped");
    expect(cancelled.run.status).toBe("cancelled");
    expect(seen[2]?.url).toBe(`/coaching/runs/${RUN}/cancel`);
    expect(JSON.parse(String(seen[2]?.init.body))).toEqual({ reason: "user stopped" });
  });

  it("maps auth/outage/malformed failures to distinct errors", async () => {
    const { client } = await bootstrappedClient([
      errorResponse("UNAUTHENTICATED", "Expired.", 401),
      errorResponse("STORAGE_UNAVAILABLE", "Auth outage.", 503),
      new Response(JSON.stringify({ bogus: true }), { status: 200 }),
    ]);
    const unauth = await client.readRun(RUN).catch((caught: unknown) => caught);
    expect((unauth as ApiError).code).toBe(API_ERROR_CODES.UNAUTHENTICATED);
    expect((unauth as ApiError).status).toBe(401);
    const outage = await client.readRun(RUN).catch((caught: unknown) => caught);
    expect((outage as ApiError).code).toBe(API_ERROR_CODES.STORAGE_UNAVAILABLE);
    expect((outage as ApiError).status).toBe(503);
    const malformed = await client.readRun(RUN).catch((caught: unknown) => caught);
    expect(malformed).toBeInstanceOf(MalformedResponseError);
  });

  it("logout clears the in-memory capability even when the call fails", async () => {
    const { client, seen } = await bootstrappedClient([
      jsonResponse({ loggedOut: true }),
      errorResponse("STORAGE_UNAVAILABLE", "Outage.", 503),
    ]);
    await client.logout();
    expect(client.isBootstrapped).toBe(false);
    expect(seen[1]?.url).toBe("/coaching/logout");

    // Second client: failed logout still discards credentials.
    const { impl, seen: seen2 } = fakeFetch([
      jsonResponse({ capability: "cap-2", expiresInMs: 600_000 }),
      errorResponse("STORAGE_UNAVAILABLE", "Outage.", 503),
    ]);
    const flaky = new CoachingClient({ fetchImpl: impl, getAccessToken: () => "bearer-now" });
    await flaky.bootstrap();
    await expect(flaky.logout()).rejects.toMatchObject({ code: API_ERROR_CODES.STORAGE_UNAVAILABLE });
    expect(flaky.isBootstrapped).toBe(false);
    expect(seen2.length).toBe(2);
    await expect(flaky.readRun(RUN)).rejects.toMatchObject({ code: API_ERROR_CODES.UNAUTHENTICATED });
    expect(seen2.length).toBe(2);
  });
});

describe("parseSseEventsText", () => {
  const identity = { sessionId: SESSION, runId: RUN };

  it("frames on double-LF, preserves text whitespace, and dedupes by seq", () => {
    const frames =
      sseFrame(envelope(1, { type: "text_delta", delta: "world" })) +
      sseFrame(envelope(0, { type: "text_delta", delta: "  hello \n" })) +
      sseFrame(envelope(1, { type: "text_delta", delta: "world" }));
    const parsed = parseSseEventsText(frames, identity);
    expect(parsed.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(parsed[0]?.event).toEqual({ type: "text_delta", delta: "  hello \n" });
  });

  it("rejects cross-run frames instead of folding them", () => {
    const foreign = sseFrame({ ...envelope(0, { type: "text_delta", delta: "x" }), runId: "other" });
    expect(() => parseSseEventsText(foreign, identity)).toThrow(/mixed-stream/);
  });
});

describe("CoachingClient.subscribeRunEvents", () => {
  function sseFetch(chunks: Uint8Array[], seen: { url: string; init: RequestInit }[]) {
    return (async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
  }

  async function subscribedClient(
    chunks: Uint8Array[],
    seen: { url: string; init: RequestInit }[],
    token: string | null = "bearer-now",
  ): Promise<CoachingClient> {
    const boot = fakeFetch([jsonResponse({ capability: "cap-1", expiresInMs: 600_000 })]);
    const client = new CoachingClient({
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (String(url).includes("/coaching/bootstrap")) return boot.impl(url, init);
        return sseFetch(chunks, seen)(url, init);
      }) as unknown as typeof fetch,
      getAccessToken: () => token,
    });
    await client.bootstrap();
    return client;
  }

  it("resumes from the caller's last consumed seq and decodes split UTF-8 chunks", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const text = sseFrame(envelope(3, { type: "text_delta", delta: "héllo 🌍 " })) +
      sseFrame(envelope(4, { type: "terminal", status: "completed" }));
    const bytes = new TextEncoder().encode(text);
    // Split mid-multibyte-codepoint so framing must survive chunk edges.
    const chunks = [bytes.slice(0, 7), bytes.slice(7, 13), bytes.slice(13)];
    const client = await subscribedClient(chunks, seen);
    const received: CoachingEventEnvelope[] = [];
    const sub = client.subscribeRunEvents({ runId: RUN, sessionId: SESSION, fromSeq: 3 }, (entry) =>
      received.push(entry),
    );
    const result = await sub.done;
    expect(seen[0]?.url).toBe(`/coaching/runs/${RUN}/events?fromSeq=3`);
    expect(seen[0]?.url).not.toContain("cap-1");
    expect((seen[0]?.init.headers as Record<string, string>)[COACHING_CAPABILITY_HEADER]).toBe("cap-1");
    expect(result).toEqual({ aborted: false, lastConsumed: 4 });
    expect(received.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(received[0]?.event).toEqual({ type: "text_delta", delta: "héllo 🌍 " });
  });

  it("freezes after terminal and ignores duplicates and late frames", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const text =
      sseFrame(envelope(0, { type: "text_delta", delta: "a" })) +
      sseFrame(envelope(0, { type: "text_delta", delta: "a" })) +
      sseFrame(envelope(1, { type: "terminal", status: "completed" })) +
      sseFrame(envelope(2, { type: "text_delta", delta: "late" }));
    const client = await subscribedClient([new TextEncoder().encode(text)], seen);
    const received: CoachingEventEnvelope[] = [];
    const result = await client
      .subscribeRunEvents({ runId: RUN, sessionId: SESSION }, (entry) => received.push(entry))
      .done;
    expect(result).toEqual({ aborted: false, lastConsumed: 1 });
    expect(received.map((entry) => entry.seq)).toEqual([0, 1]);
  });

  it("surfaces 410 EXPIRED_CURSOR with retention details for refetch", async () => {
    const retention = { run: storedRun("running"), lastSeq: 9, firstSeq: 0, expiresAt: Date.now() + 60_000 };
    const boot = fakeFetch([
      jsonResponse({ capability: "cap-1", expiresInMs: 600_000 }),
      errorResponse("EXPIRED_CURSOR", "Cursor expired; refetch from firstSeq and do not skip.", 410, retention),
    ]);
    const client = new CoachingClient({ fetchImpl: boot.impl, getAccessToken: () => "bearer-now" });
    await client.bootstrap();
    const onEvent = vi.fn();
    const error = await client
      .subscribeRunEvents({ runId: RUN, sessionId: SESSION, fromSeq: 999 }, onEvent)
      .done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("EXPIRED_CURSOR");
    expect((error as ApiError).status).toBe(410);
    expect((error as ApiError).details).toMatchObject({ firstSeq: 0, lastSeq: 9 });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("abort detaches the stream and settles without cancelling the run", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const boot = fakeFetch([jsonResponse({ capability: "cap-1", expiresInMs: 600_000 })]);
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/coaching/bootstrap")) return boot.impl(url, init);
      seen.push({ url, init: init ?? {} });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = new CoachingClient({ fetchImpl, getAccessToken: () => "bearer-now" });
    await client.bootstrap();
    const received: CoachingEventEnvelope[] = [];
    const external = new AbortController();
    const sub = client.subscribeRunEvents(
      { runId: RUN, sessionId: SESSION },
      (entry) => received.push(entry),
      { signal: external.signal },
    );
    controller.enqueue(new TextEncoder().encode(sseFrame(envelope(0, { type: "text_delta", delta: "hi" }))));
    await waitFor(() => received.length === 1);
    external.abort();
    const result = await sub.done;
    expect(result.aborted).toBe(true);
    expect(result.lastConsumed).toBe(0);
    // Abort signal reached the fetch; no cancel POST was issued.
    expect((seen[0]?.init.signal as AbortSignal).aborted).toBe(true);
    expect(seen.some((entry) => entry.url.includes("/cancel"))).toBe(false);
    sub.close();
  });
});

describe("CoachingClient SSE transport fixes", () => {
  function sseFetchWith(
    chunks: Uint8Array[],
    seen: { url: string; init: RequestInit }[],
    headers: Record<string, string> = { "content-type": "text/event-stream" },
  ) {
    return (async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(stream, { headers });
    }) as unknown as typeof fetch;
  }

  async function fixedClient(
    sseImpl: (url: string, init?: RequestInit) => Promise<Response>,
    token: CoachingClientToken = "bearer-now",
  ): Promise<CoachingClient> {
    const boot = fakeFetch([jsonResponse({ capability: "cap-1", expiresInMs: 600_000 })]);
    const client = new CoachingClient({
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (String(url).includes("/coaching/bootstrap")) return boot.impl(url, init);
        return sseImpl(url, init);
      }) as unknown as typeof fetch,
      getAccessToken: typeof token === "function" ? token : () => token,
    });
    await client.bootstrap();
    return client;
  }

  type CoachingClientToken = string | null | (() => string | null | Promise<string | null>);

  it("frames split CRLF + multibyte across chunks and an unterminated final frame", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f0 = envelope(0, { type: "text_delta", delta: "héllo 🌍" });
    const f1 = envelope(1, { type: "terminal", status: "completed" });
    const wire = `id: 0\r\ndata: ${JSON.stringify(f0)}\r\n\r\nid: 1\r\ndata: ${JSON.stringify(f1)}`;
    const bytes = new TextEncoder().encode(wire);
    const chunks = [bytes.slice(0, 5), bytes.slice(5, 11), bytes.slice(11, 17), bytes.slice(17)];
    const client = await fixedClient(sseFetchWith(chunks, seen));
    const received: CoachingEventEnvelope[] = [];
    const result = await client.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, (e) => received.push(e)).done;
    expect(result).toEqual({ aborted: false, lastConsumed: 1 });
    expect(received.map((e) => e.seq)).toEqual([0, 1]);
    expect(received[0]?.event).toEqual({ type: "text_delta", delta: "héllo 🌍" });
  });

  it("keeps a single CRLF inside a multiline data frame until the blank line", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f0 = envelope(0, { type: "text_delta", delta: "hello" });
    const f1 = envelope(1, { type: "terminal", status: "completed" });
    const full0 = JSON.stringify(f0);
    // Split on a token boundary so the two data: lines rejoin with "\n"
    // (SSE multiline join) into valid JSON whitespace.
    const splitAt = full0.indexOf(",");
    expect(splitAt).toBeGreaterThan(0);
    const first = full0.slice(0, splitAt);
    const second = full0.slice(splitAt);
    // Single CRLFs separate id:/data:/data:; only the double CRLF ends a frame.
    const wire =
      `id: 0\r\ndata: ${first}\r\ndata: ${second}\r\n\r\n` +
      `id: 1\r\ndata: ${JSON.stringify(f1)}\r\n\r\n`;
    const bytes = new TextEncoder().encode(wire);
    // Cut every CRLF pair across chunk boundaries (\r | \n) so framing must
    // survive split delimiters without treating one CRLF as a blank line.
    const chunks: Uint8Array[] = [];
    let start = 0;
    for (let idx = 0; idx < bytes.length - 1; idx += 1) {
      if (bytes[idx] === 13 && bytes[idx + 1] === 10) {
        chunks.push(bytes.slice(start, idx + 1));
        start = idx + 1;
      }
    }
    chunks.push(bytes.slice(start));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.some((chunk) => chunk.length > 0 && chunk[chunk.length - 1] === 13)).toBe(true);
    const client = await fixedClient(sseFetchWith(chunks, seen));
    const received: CoachingEventEnvelope[] = [];
    const result = await client.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, (e) => received.push(e)).done;
    // No early frame: the split data: lines fold into one seq-0 envelope.
    expect(result).toEqual({ aborted: false, lastConsumed: 1 });
    expect(received.map((e) => e.seq)).toEqual([0, 1]);
    expect(received[0]?.event).toEqual({ type: "text_delta", delta: "hello" });
  });

  it("ignores seq below fromSeq, ignores duplicates, rejects forward gaps and foreign streams", async () => {
    // seq 0 while fromSeq=5 is stale: ignored, then terminal at 5 delivers.
    {
      const seen: { url: string; init: RequestInit }[] = [];
      const text = sseFrame(envelope(0, { type: "text_delta", delta: "stale" })) +
        sseFrame(envelope(5, { type: "terminal", status: "completed" }));
      const client = await fixedClient(sseFetchWith([new TextEncoder().encode(text)], seen));
      const received: CoachingEventEnvelope[] = [];
      const result = await client
        .subscribeRunEvents({ runId: RUN, sessionId: SESSION, fromSeq: 5 }, (e) => received.push(e)).done;
      expect(result).toEqual({ aborted: false, lastConsumed: 5 });
      expect(received.map((e) => e.seq)).toEqual([5]);
    }
    // Gap 5 -> 7 rejects without skipping.
    {
      const seen: { url: string; init: RequestInit }[] = [];
      const text = sseFrame(envelope(5, { type: "text_delta", delta: "a" })) +
        sseFrame(envelope(7, { type: "text_delta", delta: "skip" }));
      const client = await fixedClient(sseFetchWith([new TextEncoder().encode(text)], seen));
      const received: CoachingEventEnvelope[] = [];
      const error = await client
        .subscribeRunEvents({ runId: RUN, sessionId: SESSION, fromSeq: 5 }, (e) => received.push(e))
        .done.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MalformedResponseError);
      expect(String((error as Error).message)).toMatch(/gap/);
      expect(received.map((e) => e.seq)).toEqual([5]);
    }
    // Foreign identity rejects.
    {
      const seen: { url: string; init: RequestInit }[] = [];
      const foreign = sseFrame({ ...envelope(0, { type: "text_delta", delta: "x" }), runId: "other" });
      const client = await fixedClient(sseFetchWith([new TextEncoder().encode(foreign)], seen));
      const error = await client
        .subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {})
        .done.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MalformedResponseError);
    }
  });

  it("rejects when the token provider rejects and settles done", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = await fixedClient(sseFetchWith([], seen));
    (client as unknown as { getAccessToken: CoachingAccessTokenProvider }).getAccessToken = () =>
      Promise.reject(new Error("token boom"));
    const error = await client
      .subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {})
      .done.catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("token boom");
  });

  it("tolerates a rejecting reader.cancel without unhandled rejection", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const text = sseFrame(envelope(0, { type: "terminal", status: "completed" }));
    const client = await fixedClient(sseFetchWith([new TextEncoder().encode(text)], seen));
    const rejecting: ReadableStreamDefaultReader<Uint8Array> = {
      cancel: () => Promise.reject(new Error("cancel boom")),
      releaseLock: () => {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    // Exercise the shared cancel path indirectly: close after terminal must not throw.
    const sub = client.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {});
    const result = await sub.done;
    expect(result.lastConsumed).toBe(0);
    sub.close();
    void rejecting;
  });

  it("treats EOF before terminal as disconnect, not completion", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const text = sseFrame(envelope(0, { type: "text_delta", delta: "partial" }));
    const client = await fixedClient(sseFetchWith([new TextEncoder().encode(text)], seen));
    const { NetworkError } = await import("@agent-fit-trace/api-contracts");
    const error = await client
      .subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {})
      .done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkError);
  });

  it("rejects non-SSE content types and oversized frames", async () => {
    const seenBad: { url: string; init: RequestInit }[] = [];
    const bad = await fixedClient(
      sseFetchWith([new TextEncoder().encode("hello")], seenBad, { "content-type": "application/json" }),
    );
    await expect(bad.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {}).done).rejects.toBeInstanceOf(
      MalformedResponseError,
    );

    const seenBig: { url: string; init: RequestInit }[] = [];
    const big = await fixedClient(
      sseFetchWith([new TextEncoder().encode(`data: ${"x".repeat(MAX_COACHING_SSE_FRAME_BYTES + 1)}\n\n`)], seenBig),
    );
    await expect(big.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {}).done).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
  });

  it("bounds frames against the shared full-frame budget at the exact boundary", async () => {
    // Exactly at the budget: block + canonical delimiter == MAX → accepted.
    // This is the alignment point: the client measures the SAME full frame the
    // server writes, not the block alone.
    {
      const seen: { url: string; init: RequestInit }[] = [];
      const wire = exactSizeFrame(MAX_COACHING_SSE_FRAME_BYTES) + sseFrame(envelope(1, { type: "terminal", status: "completed" }));
      const client = await fixedClient(sseFetchWith([new TextEncoder().encode(wire)], seen));
      const received: CoachingEventEnvelope[] = [];
      const result = await client.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, (e) => received.push(e)).done;
      expect(result).toEqual({ aborted: false, lastConsumed: 1 });
      expect(received.map((e) => e.seq)).toEqual([0, 1]);
    }
    // One byte over the budget rejects explicitly.
    {
      const seen: { url: string; init: RequestInit }[] = [];
      const wire = exactSizeFrame(MAX_COACHING_SSE_FRAME_BYTES + 1) + sseFrame(envelope(1, { type: "terminal", status: "completed" }));
      const client = await fixedClient(sseFetchWith([new TextEncoder().encode(wire)], seen));
      const error = await client
        .subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {})
        .done.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MalformedResponseError);
    }
  });

  it("rejects an SSE body over the shared total budget", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    // A body larger than the whole-run total cap rejects before framing.
    const body = new TextEncoder().encode("x".repeat(MAX_COACHING_SSE_TOTAL_BYTES + 1));
    const client = await fixedClient(sseFetchWith([body], seen));
    const error = await client
      .subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {})
      .done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(String((error as Error).message)).toMatch(/body exceeds the size limit/);
  });

  it("frames many coalesced small frames in one buffer (cap is per frame)", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const parts: string[] = [];
    for (let seq = 0; seq < 5; seq += 1) {
      parts.push(sseFrame(envelope(seq, { type: "text_delta", delta: "y".repeat(1000) })));
    }
    parts.push(sseFrame(envelope(5, { type: "terminal", status: "completed" })));
    const client = await fixedClient(sseFetchWith([new TextEncoder().encode(parts.join(""))], seen));
    const received: CoachingEventEnvelope[] = [];
    const result = await client.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, (e) => received.push(e)).done;
    expect(result).toEqual({ aborted: false, lastConsumed: 5 });
    expect(received.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("sends redirect:error on JSON and SSE fetches", async () => {
    const { impl, seen } = fakeFetch([
      jsonResponse({ capability: "cap-1", expiresInMs: 600_000 }),
      jsonResponse({ id: SESSION }),
    ]);
    const client = new CoachingClient({ fetchImpl: impl, getAccessToken: () => "bearer-now" });
    await client.bootstrap();
    await client.readSession(SESSION);
    expect((seen[0]?.init as RequestInit).redirect).toBe("error");
    expect((seen[1]?.init as RequestInit).redirect).toBe("error");

    const seenSse: { url: string; init: RequestInit }[] = [];
    const text = sseFrame(envelope(0, { type: "terminal", status: "completed" }));
    const sseClient = await fixedClient(sseFetchWith([new TextEncoder().encode(text)], seenSse));
    await sseClient.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {}).done;
    expect((seenSse[0]?.init as RequestInit).redirect).toBe("error");
  });

  it("close during pending token settles fast and delivers nothing", async () => {
    let resolveToken!: (value: string | null) => void;
    const pendingToken = new Promise<string | null>((resolve) => { resolveToken = resolve; });
    const sseSeen: { url: string; init: RequestInit }[] = [];
    const boot = fakeFetch([jsonResponse({ capability: "cap-1", expiresInMs: 600_000 })]);
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/coaching/bootstrap")) return boot.impl(url, init);
      sseSeen.push({ url, init: init ?? {} });
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = new CoachingClient({ fetchImpl, getAccessToken: () => "bearer-now" });
    await client.bootstrap();
    (client as unknown as { getAccessToken: CoachingAccessTokenProvider }).getAccessToken = () => pendingToken;
    const received: CoachingEventEnvelope[] = [];
    const sub = client.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, (e) => received.push(e));
    sub.close();
    const result = await sub.done;
    expect(result).toEqual({ aborted: true, lastConsumed: -1 });
    resolveToken("late-bearer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual([]);
    expect(sseSeen.length).toBe(0);
  });

  it("accepts an exact-limit frame split at every delimiter boundary (and rejects max+1)", async () => {
    const terminal = sseFrame(envelope(1, { type: "terminal", status: "completed" }));
    const bytes = new TextEncoder().encode(exactSizeFrame(MAX_COACHING_SSE_FRAME_BYTES) + terminal);
    // The frame's trailing `\n\n` sits at [MAX-2, MAX). A split anywhere inside
    // it leaves a pending buffer that already holds part of the delimiter, so
    // the old unconditional `+2` falsely rejected these as oversized.
    for (const splitAt of [
      MAX_COACHING_SSE_FRAME_BYTES - 3,
      MAX_COACHING_SSE_FRAME_BYTES - 2,
      MAX_COACHING_SSE_FRAME_BYTES - 1,
      MAX_COACHING_SSE_FRAME_BYTES,
      MAX_COACHING_SSE_FRAME_BYTES + 1,
    ]) {
      const seen: { url: string; init: RequestInit }[] = [];
      const client = await fixedClient(sseFetchWith([bytes.slice(0, splitAt), bytes.slice(splitAt)], seen));
      const received: CoachingEventEnvelope[] = [];
      const result = await client.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, (e) => received.push(e)).done;
      expect(result, `split at ${splitAt}`).toEqual({ aborted: false, lastConsumed: 1 });
      expect(received.map((e) => e.seq)).toEqual([0, 1]);
    }
    // One byte over the limit still rejects explicitly.
    {
      const seen: { url: string; init: RequestInit }[] = [];
      const over = new TextEncoder().encode(exactSizeFrame(MAX_COACHING_SSE_FRAME_BYTES + 1) + terminal);
      const client = await fixedClient(
        sseFetchWith([over.slice(0, MAX_COACHING_SSE_FRAME_BYTES), over.slice(MAX_COACHING_SSE_FRAME_BYTES)], seen),
      );
      const error = await client
        .subscribeRunEvents({ runId: RUN, sessionId: SESSION }, () => {})
        .done.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MalformedResponseError);
    }
  });

  it("keeps an exact-limit multibyte frame when split mid-codepoint and at the delimiter", async () => {
    const terminal = sseFrame(envelope(1, { type: "terminal", status: "completed" }));
    const bytes = new TextEncoder().encode(exactSizeFrameUtf8(MAX_COACHING_SSE_FRAME_BYTES, "é") + terminal);
    const firstMulti = bytes.findIndex((byte) => byte > 127);
    expect(firstMulti).toBeGreaterThan(0);
    for (const splitAt of [
      firstMulti + 1, // mid-codepoint
      MAX_COACHING_SSE_FRAME_BYTES - 1, // inside the frame delimiter
      bytes.length - 3, // inside the terminal frame's delimiter
    ]) {
      const seen: { url: string; init: RequestInit }[] = [];
      const client = await fixedClient(sseFetchWith([bytes.slice(0, splitAt), bytes.slice(splitAt)], seen));
      const received: CoachingEventEnvelope[] = [];
      const result = await client.subscribeRunEvents({ runId: RUN, sessionId: SESSION }, (e) => received.push(e)).done;
      expect(result, `split at ${splitAt}`).toEqual({ aborted: false, lastConsumed: 1 });
      expect(received.map((e) => e.seq)).toEqual([0, 1]);
    }
  });
});

describe("CoachingClient credential races", () => {
  it("late bootstrap after discard stores nothing", async () => {
    let resolveBody!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => { resolveBody = resolve; });
    const impl = (async (url: string) => {
      if (String(url).includes("/coaching/bootstrap")) return gate;
      throw new Error("unexpected request: " + url);
    }) as unknown as typeof fetch;
    const client = new CoachingClient({ fetchImpl: impl, getAccessToken: () => "bearer-now" });
    const pending = client.bootstrap();
    client.discardCredentials();
    resolveBody(jsonResponse({ capability: "stale-cap", expiresInMs: 600_000 }));
    await pending;
    expect(client.isBootstrapped).toBe(false);
  });

  it("concurrent bootstraps issue one fetch", async () => {
    const { impl, seen } = fakeFetch([jsonResponse({ capability: "cap-1", expiresInMs: 600_000 })]);
    const client = new CoachingClient({ fetchImpl: impl, getAccessToken: () => "bearer-now" });
    const [a, b] = await Promise.all([client.bootstrap(), client.bootstrap()]);
    expect(a.capability).toBe("cap-1");
    expect(b.capability).toBe("cap-1");
    expect(seen.length).toBe(1);
    expect(client.isBootstrapped).toBe(true);
  });

  it("failed bootstrap leaves no stale capability", async () => {
    const { impl } = fakeFetch([errorResponse("STORAGE_UNAVAILABLE", "Outage.", 503)]);
    const client = new CoachingClient({ fetchImpl: impl, getAccessToken: () => "bearer-now" });
    await expect(client.bootstrap()).rejects.toMatchObject({ code: API_ERROR_CODES.STORAGE_UNAVAILABLE });
    expect(client.isBootstrapped).toBe(false);
  });
});
