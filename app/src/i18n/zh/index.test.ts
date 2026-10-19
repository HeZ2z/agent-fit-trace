import { describe, expect, it } from "vitest";
import { ZH_MESSAGES } from "@pi-fit-trace/i18n";
import { messages as chrome } from "@pi-fit-trace/i18n/zh/chrome";
import { messages as domain } from "@pi-fit-trace/i18n/zh/domain";
import { messages as screensAnalysisPlan } from "@pi-fit-trace/i18n/zh/screens-analysis-plan";
import { messages as screensCoachMe } from "@pi-fit-trace/i18n/zh/screens-coach-me";
import { messages as screensHistory } from "@pi-fit-trace/i18n/zh/screens-history";
import { messages as mobile } from "@pi-fit-trace/i18n/zh/mobile";

const SLICES: readonly { name: string; messages: Record<string, string> }[] = [
  { name: "chrome", messages: chrome },
  { name: "screens-history", messages: screensHistory },
  { name: "screens-analysis-plan", messages: screensAnalysisPlan },
  { name: "screens-coach-me", messages: screensCoachMe },
  { name: "domain", messages: domain },
  { name: "mobile", messages: mobile },
];

describe("Chinese dictionary", () => {
  it("has no empty translations", () => {
    for (const slice of SLICES) {
      for (const [source, translation] of Object.entries(slice.messages)) {
        expect(translation.trim(), `${slice.name}: ${source}`).not.toBe("");
      }
    }
  });

  it("agrees across slices when a source string is shared", () => {
    const seen = new Map<string, { slice: string; translation: string }>();
    const conflicts: string[] = [];
    for (const slice of SLICES) {
      for (const [source, translation] of Object.entries(slice.messages)) {
        const earlier = seen.get(source);
        if (earlier === undefined) {
          seen.set(source, { slice: slice.name, translation });
          continue;
        }
        if (translation !== earlier.translation) {
          conflicts.push(
            `${source} → ${earlier.slice}: ${earlier.translation} | ${slice.name}: ${translation}`,
          );
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("merges every slice into the runtime table", () => {
    for (const slice of SLICES) {
      for (const [source, translation] of Object.entries(slice.messages)) {
        expect(ZH_MESSAGES[source], `missing from merge: ${source} (${slice.name})`).toBe(
          translation,
        );
      }
    }
  });
});
