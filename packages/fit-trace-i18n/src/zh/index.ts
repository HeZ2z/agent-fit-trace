import { messages as chrome } from "./chrome.ts";
import { messages as screensHistory } from "./screens-history.ts";
import { messages as screensAnalysisPlan } from "./screens-analysis-plan.ts";
import { messages as screensCoachMe } from "./screens-coach-me.ts";
import { messages as domain } from "./domain.ts";
import { messages as mobile } from "./mobile.ts";
import { messages as mobileCoach } from "./mobile-coach.ts";

/**
 * The Chinese display-layer dictionary, keyed by the exact English source
 * string. Built by merging per-area tables so slices can grow independently;
 * a later table wins only if the same source is listed twice.
 */
export const ZH_MESSAGES: Record<string, string> = {
  ...chrome,
  ...screensHistory,
  ...screensAnalysisPlan,
  ...screensCoachMe,
  ...domain,
  ...mobile,
  ...mobileCoach,
};
