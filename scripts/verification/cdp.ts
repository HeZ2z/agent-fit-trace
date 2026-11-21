/**
 * Minimal Chrome DevTools Protocol client for the acceptance harness.
 *
 * No Playwright/Puppeteer: Node 24's global `WebSocket` talks to Chrome's
 * browser-level endpoint, and `Target.createTarget` + `Target.attachToTarget`
 * (flatten) give one page session. Only the domains the flow needs are used:
 * Page, Runtime, Emulation, and Browser.
 *
 * The client is intentionally small but defensive: pending requests reject on
 * socket close, event waits time out, page exceptions surface with the failing
 * expression, and navigation waits for an actual load event rather than a
 * possibly-stale `document.readyState`.
 */

import { setTimeout as delay } from "node:timers/promises";

interface WebSocketMessageEvent {
  data: unknown;
}

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
  readyState: number;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Default per-command deadline; a stuck command must not hang the whole run. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

interface EventWaiter {
  method: string;
  sessionId: string | undefined;
  predicate: (params: unknown) => boolean;
  resolve: (params: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CdpErrorPayload {
  message?: string;
  data?: string;
}

interface CdpEventMessage {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: CdpErrorPayload;
}

/** Convert a WebSocket text/binary data payload to a string. */
async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  const maybeBlob = data as { text?: () => Promise<string> };
  if (typeof maybeBlob.text === "function") return await maybeBlob.text();
  return String(data);
}

function socketConstructor(): WebSocketConstructor {
  const ctor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (ctor === undefined) {
    throw new Error("This Node runtime has no global WebSocket; Node 24 is required.");
  }
  return ctor;
}

/** One CDP websocket connection (browser-level or flattened page session). */
export class CdpClient {
  #socket: WebSocketLike;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #waiters: EventWaiter[] = [];
  #closed = false;
  #closeError: Error | null = null;
  #commandTimeoutMs: number;

  constructor(socket: WebSocketLike, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    this.#socket = socket;
    this.#commandTimeoutMs =
      Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs > 0
        ? commandTimeoutMs
        : DEFAULT_COMMAND_TIMEOUT_MS;
    this.#socket.onmessage = (event) => {
      void this.#handleMessage(event.data);
    };
    this.#socket.onclose = () => {
      this.#shutdown(new Error("CDP websocket closed"));
    };
    this.#socket.onerror = () => {
      this.#shutdown(new Error("CDP websocket error"));
    };
  }

  /**
   * Open a CDP websocket and resolve once Chrome accepts the connection.
   *
   * `commandTimeoutMs` is the per-command default (see {@link send}); the
   * harness threads its `--timeout` budget here.
   */
  static connect(
    url: string,
    timeoutMs = 10_000,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<CdpClient> {
    const WebSocketCtor = socketConstructor();
    return new Promise((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = new WebSocketCtor(url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // already closed
        }
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms (${url})`));
      }, timeoutMs);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(socket, commandTimeoutMs));
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CDP websocket failed to open (${url})`));
      };
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Send one CDP command; resolves with the command result.
   *
   * Every command carries its own deadline (`options.timeoutMs`, else the
   * client default). A timed-out command rejects with its method name and its
   * pending entry is removed, so the connection stays usable — a single stuck
   * command never closes the socket or leaks a resolver.
   */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(this.#closeError ?? new Error("CDP connection is closed"));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    const timeoutMs =
      options.timeoutMs !== undefined &&
      Number.isSafeInteger(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : this.#commandTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // A pending command deadline must not keep the process alive on its own.
      timer.unref?.();
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.#socket.send(JSON.stringify(payload));
      } catch (error) {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        if (pending !== undefined) clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Wait for one matching CDP event, rejecting after `timeoutMs`. */
  waitForEvent<T = unknown>(
    method: string,
    sessionId: string | undefined,
    predicate: (params: unknown) => boolean,
    timeoutMs: number,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(this.#closeError ?? new Error("CDP connection is closed"));
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: EventWaiter = {
        method,
        sessionId,
        predicate,
        resolve: (params) => resolve(params as T),
        reject,
        timer: setTimeout(() => {
          this.#removeWaiter(waiter);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP event ${method}`));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  /** Close the websocket and reject everything still in flight. */
  close(): void {
    if (this.#closed) return;
    this.#shutdown(new Error("CDP connection closed by the harness"));
    try {
      this.#socket.close();
    } catch {
      // already closed
    }
  }

  #removeWaiter(waiter: EventWaiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index !== -1) this.#waiters.splice(index, 1);
    clearTimeout(waiter.timer);
  }

  #shutdown(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of [...this.#waiters]) {
      this.#removeWaiter(waiter);
      waiter.reject(error);
    }
  }

  async #handleMessage(data: unknown): Promise<void> {
    let message: CdpEventMessage;
    try {
      message = JSON.parse(await messageText(data)) as CdpEventMessage;
    } catch {
      // A malformed frame is not actionable; dropping it must not kill the run.
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const detail =
          message.error.data !== undefined && message.error.data !== ""
            ? `${message.error.message ?? "CDP error"}: ${message.error.data}`
            : (message.error.message ?? "CDP error");
        pending.reject(new Error(detail));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;
    const matching = this.#waiters.filter(
      (waiter) => waiter.method === message.method && waiter.sessionId === message.sessionId,
    );
    for (const waiter of matching) {
      if (!waiter.predicate(message.params)) continue;
      this.#removeWaiter(waiter);
      waiter.resolve(message.params);
    }
  }
}

/** A created and attached page target. */
export interface PageTarget {
  targetId: string;
  sessionId: string;
}

/** Create an about:blank page target and enable the domains the flow uses. */
export async function createPageTarget(
  client: CdpClient,
  options: { width: number; height: number },
): Promise<PageTarget> {
  const created = await client.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  const { sessionId } = attached;
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    },
    sessionId,
  );
  return { targetId: created.targetId, sessionId };
}

interface EvaluateResponse<T> {
  result: { type: string; value?: T; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** Evaluate an expression in the page and return its JSON value. */
export async function evaluate<T = unknown>(
  client: CdpClient,
  sessionId: string,
  expression: string,
  options: { awaitPromise?: boolean } = {},
): Promise<T> {
  const response = await client.send<EvaluateResponse<T>>(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise ?? true,
      userGesture: true,
    },
    sessionId,
  );
  if (response.exceptionDetails !== undefined) {
    const detail =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      "unknown page exception";
    throw new Error(`Page evaluation failed: ${detail}`);
  }
  return response.result.value as T;
}

/** Poll a page predicate until it is true or the timeout expires. */
export async function waitFor(
  client: CdpClient,
  sessionId: string,
  expression: string,
  options: { description: string; timeoutMs: number; pollMs?: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? 100;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const passed = await evaluate<boolean>(
        client,
        sessionId,
        `Boolean(${expression})`,
        { awaitPromise: false },
      );
      if (passed) return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await delay(pollMs);
  }
  const detail = lastError === null ? "" : ` (last evaluation error: ${lastError.message})`;
  throw new Error(
    `Timed out after ${options.timeoutMs}ms waiting for ${options.description}${detail}`,
  );
}

/** Navigate and wait for the document's load event. */
export async function navigate(
  client: CdpClient,
  sessionId: string,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const loaded = client.waitForEvent("Page.loadEventFired", sessionId, () => true, timeoutMs);
  // The load wait may reject after `Page.navigate` fails or times out. Attach a
  // handler immediately so that rejection can never surface as unhandled while
  // the harness still needs its cleanup/manifest path (the later `await loaded`
  // still observes the same rejection).
  loaded.catch(() => undefined);
  const response = await client.send<{ errorText?: string }>("Page.navigate", { url }, sessionId);
  if (response.errorText !== undefined && response.errorText !== "") {
    throw new Error(`Navigation to ${url} failed: ${response.errorText}`);
  }
  await loaded;
  await waitFor(client, sessionId, 'document.readyState === "complete"', {
    description: `readyState complete for ${url}`,
    timeoutMs,
  });
}

/** Reload the current document and wait for its fresh load event. */
export async function reload(
  client: CdpClient,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const loaded = client.waitForEvent("Page.loadEventFired", sessionId, () => true, timeoutMs);
  // See `navigate`: a rejected load wait must not become an unhandled rejection
  // when `Page.reload` fails before the event arrives.
  loaded.catch(() => undefined);
  await client.send("Page.reload", { ignoreCache: true }, sessionId);
  await loaded;
  await waitFor(client, sessionId, 'document.readyState === "complete"', {
    description: "readyState complete after reload",
    timeoutMs,
  });
}

/**
 * Set a React-controlled field through the native prototype setter and dispatch
 * the events React listens for. This is the raw-CDP equivalent of typing; it
 * keeps the controlled component's state in sync without CDP key events.
 */
export async function setFieldValue(
  client: CdpClient,
  sessionId: string,
  selector: string,
  value: string,
): Promise<void> {
  const result = await evaluate<{ ok: boolean; reason?: string; value?: string }>(
    client,
    sessionId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
        return { ok: false, reason: "element not found" };
      }
      el.focus();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor === undefined || typeof descriptor.set !== "function") {
        return { ok: false, reason: "no native value setter" };
      }
      descriptor.set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: el.value };
    })()`,
  );
  if (!result.ok) {
    throw new Error(`Could not set ${selector}: ${result.reason ?? "unknown reason"}`);
  }
}

/**
 * Click an element through the page's own click handling.
 *
 * Only for non-critical affordances: the user flow uses
 * {@link prepareClick} + {@link dispatchClick} so the same hit-testing a real
 * pointer gets is part of the assertion.
 */
export async function clickElement(
  client: CdpClient,
  sessionId: string,
  selector: string,
): Promise<void> {
  const clicked = await evaluate<boolean>(
    client,
    sessionId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`Could not click ${selector}: element not found`);
}

/** Result of scrolling an element into view and hit-testing its center. */
export interface ClickPreparation {
  ok: boolean;
  reason?: string;
  x: number;
  y: number;
}

/**
 * Scroll an element into view and locate the point a real pointer would hit.
 *
 * The element must have a rendered box, be visible (not `display:none`,
 * `visibility:hidden`, or fully transparent), place its center inside the
 * viewport, and be the topmost element at that point (or an ancestor/descendant
 * of it). Any failure is reported instead of clicking blindly.
 */
export async function prepareClick(
  client: CdpClient,
  sessionId: string,
  selector: string,
): Promise<ClickPreparation> {
  return await evaluate<ClickPreparation>(
    client,
    sessionId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLElement)) {
        return { ok: false, reason: "element not found", x: 0, y: 0 };
      }
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { ok: false, reason: "element has no rendered box", x: 0, y: 0 };
      }
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return { ok: false, reason: "element is not visible", x: 0, y: 0 };
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return { ok: false, reason: "element center is outside the viewport", x, y };
      }
      const hit = document.elementFromPoint(x, y);
      if (hit === null) {
        return { ok: false, reason: "no element at the click point", x, y };
      }
      if (!(el === hit || el.contains(hit) || hit.contains(el))) {
        return {
          ok: false,
          reason: "element is covered by " + hit.tagName.toLowerCase(),
          x,
          y,
        };
      }
      return { ok: true, x, y };
    })()`,
  );
}

/** Dispatch a real left-button click (press + release) at viewport coordinates. */
export async function dispatchClick(
  client: CdpClient,
  sessionId: string,
  x: number,
  y: number,
): Promise<void> {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  await client.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
    sessionId,
  );
}

/** Capture a PNG screenshot and return its bytes (the caller stores/hashes it). */
export async function captureScreenshot(
  client: CdpClient,
  sessionId: string,
): Promise<Buffer> {
  const response = await client.send<{ data: string }>(
    "Page.captureScreenshot",
    { format: "png", fromSurface: true, captureBeyondViewport: false },
    sessionId,
  );
  return Buffer.from(response.data, "base64");
}
