import { messages as chrome } from "./chrome.ts";
import { messages as screensHistory } from "./screens-history.ts";
import { messages as screensAnalysisPlan } from "./screens-analysis-plan.ts";
import { messages as screensCoachMe } from "./screens-coach-me.ts";
import { messages as screensWorkoutSession } from "./screens-workout-session.ts";
import { messages as domain } from "./domain.ts";
import { messages as mobile } from "./mobile.ts";
import { messages as mobileCoach } from "./mobile-coach.ts";

/**
 * The Chinese display-layer dictionary, keyed by the exact English source
 * string. Built by merging per-area tables so slices can grow independently;
 * a later table wins only if the same source is listed twice.
 *
 * Catalog-backed exercise names are not interface copy: they are keyed by
 * canonical English exercise name and exported separately from
 * `./exercises.ts`, never merged into ZH_MESSAGES.
 */
export const ZH_MESSAGES: Record<string, string> = {
  ...chrome,
  ...screensHistory,
  ...screensAnalysisPlan,
  ...screensCoachMe,
  ...screensWorkoutSession,
  ...domain,
  ...mobile,
  ...mobileCoach,
};

export { EXERCISE_ALIASES_ZH, EXERCISE_DISPLAY_NAMES_ZH } from "./exercises.ts";
