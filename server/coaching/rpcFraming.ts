/**
 * LF-delimited JSON-RPC framing for `pi --mode rpc`.
 *
 * pi docs (rpc.md:7-38): LF (`\n`) is the SOLE frame delimiter. Node's
 * `readline` is NON-compliant because it also splits on U+2028/U+2029; this
 * module splits only on `\n` (tolerating an optional preceding `\r` per
 * CRLF writers) and preserves U+2028/U+2029 byte-for-byte inside frames.
 *
 * The byte framer below is the stdout path: it decodes raw process bytes
 * with a real UTF-8 `StringDecoder` so multibyte characters split across
 * chunks reassemble correctly, then feeds the shared text splitter. There
 * is exactly one splitting implementation.
 *
 * The byte cap applies per frame and to the trailing partial buffer — NOT
 * to total bytes pushed. Many small valid frames coalesced in one chunk
 * succeed; a single line (or an unterminated tail) larger than the cap
 * throws `RpcFrameError` so a runaway process cannot grow memory without
 * bound.
 */
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class RpcFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcFrameError";
  }
}

export interface RpcFrameSplitter {
  /** Push a raw stdout chunk; returns complete frames (without delimiters). */
  push(chunk: string): string[];
  /** Remaining buffered partial frame (no trailing newline seen yet). */
  buffered(): string;
}

/** Create an LF-only splitter. Never splits on U+2028/U+2029. */
export function createRpcFrameSplitter(options?: { maxBytes?: number }): RpcFrameSplitter {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
  let buffer = "";
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const frames: string[] = [];
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        let frame = buffer.slice(0, index);
        if (frame.endsWith("\r")) frame = frame.slice(0, -1);
        if (Buffer.byteLength(frame, "utf8") > maxBytes) {
          throw new RpcFrameError(`frame exceeded ${maxBytes} bytes`);
        }
        frames.push(frame);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > maxBytes) {
        throw new RpcFrameError(`frame buffer exceeded ${maxBytes} bytes without LF delimiter`);
      }
      return frames;
    },
    buffered(): string {
      return buffer;
    },
  };
}

export interface RpcByteFramer {
  /** Push raw process bytes (or text); returns complete frames (no delimiters). */
  push(chunk: Uint8Array | string): string[];
  /** Remaining buffered partial frame (decoded text, no trailing newline yet). */
  buffered(): string;
}

/**
 * Create a byte-oriented LF-only framer backed by a UTF-8 StringDecoder.
 * Split multibyte sequences across chunks decode correctly; only `\n`
 * delimits frames (optional preceding `\r` stripped). Decoded text feeds
 * the shared {@link createRpcFrameSplitter}, which enforces the cap.
 */
export function createRpcByteFramer(options?: { maxBytes?: number }): RpcByteFramer {
  const decoder = new StringDecoder("utf8");
  const inner = createRpcFrameSplitter(options);
  return {
    push(chunk: Uint8Array | string): string[] {
      const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
      return inner.push(text);
    },
    buffered(): string {
      return inner.buffered();
    },
  };
}

/** Encode one RPC request as a single LF-delimited line. */
export function encodeRpcRequest(request: Record<string, unknown>): string {
  return `${JSON.stringify(request)}\n`;
}
