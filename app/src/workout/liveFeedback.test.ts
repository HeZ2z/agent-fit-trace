import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Browser feedback guards. Each test imports a fresh module instance so the
 * lazily shared AudioContext never leaks between cases.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (navigator as unknown as Record<string, unknown>).vibrate;
});

async function loadFeedback(): Promise<typeof import("./liveFeedback.ts")> {
  return import("./liveFeedback.ts");
}

describe("playRestCue", () => {
  it("no-ops when Web Audio is unavailable", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const { playRestCue } = await loadFeedback();

    expect(() => playRestCue()).not.toThrow();
  });

  it("plays one short fade-out tone", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const connectOscillator = vi.fn();
    const connectGain = vi.fn();
    const setValueAtTime = vi.fn();
    const exponentialRampToValueAtTime = vi.fn();

    class FakeAudioContext {
      state = "running";
      currentTime = 1;
      destination = {};
      resume = vi.fn(() => Promise.resolve());

      createOscillator() {
        return {
          type: "sine",
          frequency: { value: 0 },
          connect: connectOscillator,
          start,
          stop,
        };
      }

      createGain() {
        return {
          gain: { setValueAtTime, exponentialRampToValueAtTime },
          connect: connectGain,
        };
      }
    }

    vi.stubGlobal("AudioContext", FakeAudioContext);
    const { playRestCue } = await loadFeedback();

    expect(() => playRestCue()).not.toThrow();

    expect(start).toHaveBeenCalledWith(1);
    expect(stop).toHaveBeenCalledWith(1.2);
    expect(setValueAtTime).toHaveBeenCalledWith(0.12, 1);
    expect(exponentialRampToValueAtTime).toHaveBeenCalledTimes(1);
    expect(connectOscillator).toHaveBeenCalledTimes(1);
    expect(connectGain).toHaveBeenCalledTimes(1);
  });

  it("resumes a suspended context before playing", async () => {
    const resume = vi.fn(() => Promise.resolve());
    const start = vi.fn();

    class SuspendedAudioContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume = resume;

      createOscillator() {
        return {
          type: "sine",
          frequency: { value: 0 },
          connect: vi.fn(),
          start,
          stop: vi.fn(),
        };
      }

      createGain() {
        return {
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
      }
    }

    vi.stubGlobal("AudioContext", SuspendedAudioContext);
    const { playRestCue } = await loadFeedback();
    playRestCue();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing AudioContext constructor", async () => {
    class ThrowingAudioContext {
      constructor() {
        throw new Error("audio disabled");
      }
    }

    vi.stubGlobal("AudioContext", ThrowingAudioContext);
    const { playRestCue } = await loadFeedback();

    expect(() => playRestCue()).not.toThrow();
  });
});

describe("vibrate", () => {
  it("no-ops when the Vibration API is unavailable", async () => {
    const { vibrate } = await loadFeedback();

    expect(() => vibrate(30)).not.toThrow();
    expect(() => vibrate([80, 40, 80])).not.toThrow();
  });

  it("forwards the pattern and swallows a throwing implementation", async () => {
    const spy = vi.fn();
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: spy });
    const { vibrate } = await loadFeedback();

    expect(() => vibrate([80, 40, 80])).not.toThrow();
    expect(spy).toHaveBeenCalledWith([80, 40, 80]);

    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: () => {
        throw new Error("vibration blocked");
      },
    });
    expect(() => vibrate(30)).not.toThrow();
  });
});
