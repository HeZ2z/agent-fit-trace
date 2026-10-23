/**
 * Best-effort live-session feedback: the rest-ended cue and haptics.
 *
 * Both helpers are deliberately fire-and-forget. Sound and vibration are
 * enhancements, not session state: a browser with no Web Audio support, a
 * blocked/suspended audio context, or a platform without the Vibration API must
 * degrade silently rather than throw into a reducer or render path. Every
 * browser/SSR guard lives here so callers stay thin.
 */

type AudioContextConstructor = new () => AudioContext;

/** Duration of the rest-ended tone in seconds. */
const REST_CUE_DURATION_S = 0.2;

/** A short two-burst haptic pattern for the rest-ended cue. */
export const REST_ENDED_VIBRATION: readonly number[] = [80, 40, 80];

/** A single short pulse when a set is checked. */
export const SET_CHECKED_VIBRATION_MS = 30;

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as typeof globalThis & {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * One shared context, created lazily so iOS/Safari do not run out of
 * per-page contexts. Browsers may start it suspended until a user gesture; the
 * cue resumes it on a best-effort basis and stays quiet when that is refused.
 */
let sharedContext: AudioContext | null = null;

function resolveContext(ctor: AudioContextConstructor): AudioContext {
  if (sharedContext === null || sharedContext.state === "closed") {
    sharedContext = new ctor();
  }
  return sharedContext;
}

/**
 * Play a short rest-ended tone.
 *
 * No-ops when Web Audio is unavailable (SSR, jsdom, locked-down browsers) and
 * swallows every failure, including autoplay refusal, a closed context or an
 * oscillator that cannot start.
 */
export function playRestCue(): void {
  try {
    const ctor = resolveAudioContextConstructor();
    if (ctor === null) return;

    const context = resolveContext(ctor);
    if (context.state === "suspended") {
      void context.resume().catch(() => {});
    }

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    // Quick exponential fade so the cue is audible but not a click/pop.
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + REST_CUE_DURATION_S);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + REST_CUE_DURATION_S);
  } catch {
    // Feedback must never break the session.
  }
}

/**
 * Trigger a haptic pattern when the Vibration API exists; otherwise no-op.
 *
 * The call is wrapped because some platforms expose `vibrate` but reject the
 * call (permissions, battery saver) or throw from a stubbed implementation.
 */
export function vibrate(pattern: number | readonly number[]): void {
  try {
    const target = globalThis.navigator;
    if (target === undefined || typeof target.vibrate !== "function") return;
    target.vibrate(pattern as number | number[]);
  } catch {
    // Haptics are an enhancement; never surface a failed pulse.
  }
}
