import { useCallback } from "react";
import { useAudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";

import restCueSource from "@/assets/sounds/rest-complete.wav";

/**
 * Best-effort live-session feedback: haptics and the bundled rest-ended cue.
 *
 * Both are enhancements, not session state. A device without a haptics module, a
 * player that fails to load the asset or a call rejected by the platform must
 * degrade silently instead of throwing into a reducer or render path, so every
 * helper is fire-and-forget and swallows its own failures.
 */

/** A short pulse when a set is checked off. */
export function vibrateSetChecked(): void {
  try {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
      // Haptics are an enhancement; a failed pulse is never surfaced.
    });
  } catch {
    // The native module can be unavailable (for example a web/test fallback).
  }
}

/** A success pattern when the rest countdown settles. */
export function vibrateRestEnded(): void {
  try {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {
      // Haptics are an enhancement; a failed pulse is never surfaced.
    });
  } catch {
    // The native module can be unavailable (for example a web/test fallback).
  }
}

/**
 * Load the bundled rest cue once and return a callback that plays it from the
 * start.
 *
 * The player is created by `useAudioPlayer`, which also releases it when the
 * screen unmounts. The cue is rewound before every play so a second rest can
 * never be silent because the previous playback reached the end.
 */
export function useRestCue(): () => void {
  const player = useAudioPlayer(restCueSource);

  return useCallback((): void => {
    void (async () => {
      try {
        await player.seekTo(0);
        player.play();
      } catch {
        // Sound is an enhancement; a blocked or unavailable player stays quiet.
      }
    })();
  }, [player]);
}
