import { readFile } from "node:fs/promises";

/**
 * Loading of the training-coach skill prompt. There is deliberately no inline
 * fallback: the SKILL.md file is the coach behavior contract, so a missing or
 * unreadable file is a startup error, not something to paper over.
 */

/** Raised when the training-coach SKILL.md cannot be read. */
export class SkillFileNotFoundError extends Error {
  skillPath: string;

  constructor(skillPath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Failed to read the training-coach skill file: ${skillPath} (${reason}). ` +
        "Point --skill PATH or the FIT_TRACE_SKILL_PATH environment variable at a valid SKILL.md.",
    );
    this.name = "SkillFileNotFoundError";
    this.skillPath = skillPath;
    this.cause = cause;
  }
}

// Frontmatter section: the `---` … `---` block plus one blank separator line after it.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)(?:[ \t]*\r?\n)?/;

/** Strip a leading YAML frontmatter block (`---` … `---`); bodies without one pass through. */
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "");
}

/** Read the training-coach skill file and return its body without frontmatter. */
export async function loadTrainingCoachPrompt(skillPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(skillPath, "utf8");
  } catch (error) {
    throw new SkillFileNotFoundError(skillPath, error);
  }
  return stripFrontmatter(raw);
}
