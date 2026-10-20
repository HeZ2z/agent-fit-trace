import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMessages,
  buildReviewInput,
  formatReviewComment,
  isExcludedPath,
  parseReviewResponse,
  selectReviewableFiles,
  type ChangedFile,
  type PullRequestInfo,
} from "../scripts/ai-review.ts";

const PR: PullRequestInfo = {
  number: 42,
  title: "Test PR",
  body: "Body",
  draft: false,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

function file(
  filename: string,
  patch = "@@ -1 +1 @@\n- old\n+ new",
  overrides: Partial<ChangedFile> = {},
): ChangedFile {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch,
    ...overrides,
  };
}

test("skips generated, lockfile, binary and vendor paths", () => {
  for (const path of [
    "pnpm-lock.yaml",
    "packages/fit-trace-core/src/exercises/catalog.generated.ts",
    "packages/fit-trace-i18n/src/zh/exercises.ts",
    "data/exercise-catalog/catalog.v1.json",
    "docs/screenshot.png",
    "node_modules/pkg/index.js",
    "dist/assets/index.js",
  ]) {
    assert.equal(isExcludedPath(path), true, path);
  }
  for (const path of [
    "packages/fit-trace-core/src/exercises/resolve.ts",
    "app/src/components/ExerciseNameCombobox.tsx",
    "docs/ai-review.md",
    "data/exercise-catalog/README.md",
  ]) {
    assert.equal(isExcludedPath(path), false, path);
  }
});

test("selectReviewableFiles keeps source/docs and reports skipped paths", () => {
  const result = selectReviewableFiles([
    file("app/src/App.tsx"),
    file("pnpm-lock.yaml"),
    file("docs/mobile.md"),
    file("logo.webp"),
  ]);
  assert.deepEqual(result.included.map((entry) => entry.filename), [
    "app/src/App.tsx",
    "docs/mobile.md",
  ]);
  assert.deepEqual(result.skipped, ["pnpm-lock.yaml", "logo.webp"]);
});

test("buildReviewInput embeds patches and records truncation", () => {
  const longPatch = `@@ -1 +1 @@\n${"+ x".repeat(2_000)}`;
  const input = buildReviewInput([
    file("app/src/App.tsx", longPatch),
    file("docs/mobile.md", "@@ -1 +1 @@\n-old\n+new"),
    file("catalog.generated.ts"),
  ], 1_500);

  assert.equal(input.includedFiles.length, 2);
  assert.deepEqual(input.skippedFiles, ["catalog.generated.ts", "docs/mobile.md"]);
  assert.match(input.diffText, /app\/src\/App\.tsx/);
  assert.match(input.diffText, /truncated/);
  assert.equal(input.truncated, true);
});

test("buildMessages fences the diff as untrusted data and carries the repo rules", () => {
  const previousRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "owner/repo";
  try {
    const input = buildReviewInput([file("app/src/App.tsx", "+hello")]);
    const messages = buildMessages(PR, input);
    assert.equal(messages.length, 2);
    assert.match(messages[0]?.content ?? "", /deterministic/);
    assert.match(messages[0]?.content ?? "", /untrusted data/i);
    assert.match(messages[1]?.content ?? "", /Pull request: #42/);
    assert.match(messages[1]?.content ?? "", /<pr_diff>/);
    assert.match(messages[1]?.content ?? "", /owner\/repo/);
  } finally {
    if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepo;
  }
});

test("parseReviewResponse validates the JSON contract and filters unsafe findings", () => {
  const content = `\`\`\`json
  {
    "summary": "Looks mostly fine.",
    "verdict": "needs_attention",
    "findings": [
      {"severity": "P0", "path": "app/src/App.tsx", "line": 3, "title": "Secret", "body": "Do not commit this.", "confidence": "high"},
      {"severity": "P2", "path": "app/src/App.tsx", "line": null, "title": "Minor", "body": "Consider this.", "confidence": "medium"},
      {"severity": "P2", "path": "not/in/diff.ts", "line": 1, "title": "Wrong path", "body": "Filtered.", "confidence": "high"},
      {"severity": "P9", "path": "app/src/App.tsx", "line": 1, "title": "Bad severity", "body": "Filtered.", "confidence": "high"},
      {"severity": "P1", "path": "app/src/App.tsx", "line": "4", "title": "", "body": "Empty title filtered.", "confidence": "high"}
    ]
  }
  \`\`\``;
  const review = parseReviewResponse(content, new Set(["app/src/App.tsx"]));
  assert.equal(review.verdict, "needs_attention");
  assert.equal(review.findings.length, 2);
  assert.equal(review.findings[0]?.severity, "P0");
  assert.equal(review.findings[1]?.line, null);
});

test("parseReviewResponse rejects invalid JSON and invalid verdicts", () => {
  assert.throws(() => parseReviewResponse("not json"), /JSON/);
  assert.throws(
    () => parseReviewResponse('{"summary":"x","verdict":"approved","findings":[]}'),
    /verdict/,
  );
});

test("formatReviewComment includes a dedupe marker, verdict and severity order", () => {
  const input = buildReviewInput([file("app/src/App.tsx", "+hello")]);
  const review = parseReviewResponse(JSON.stringify({
    summary: "One high and one low finding.",
    verdict: "needs_attention",
    findings: [
      { severity: "P3", path: "app/src/App.tsx", line: 2, title: "Low", body: "Low body.", confidence: "low" },
      { severity: "P0", path: "app/src/App.tsx", line: 1, title: "High", body: "High body.", confidence: "high" },
    ],
  }));
  const comment = formatReviewComment({ pr: PR, model: "deepseek-flash", review, input });
  assert.ok(comment.startsWith(`<!-- ai-pr-review:sha=${PR.headSha} -->`));
  assert.match(comment, /Needs attention/);
  assert.ok(comment.indexOf("[P0]") < comment.indexOf("[P3]"));
  assert.match(comment, /not a required check/);
  assert.ok(!comment.includes("AI_REVIEW_API_KEY"));
});

test("formatReviewComment caps oversized output", () => {
  const input = buildReviewInput([file("app/src/App.tsx")]);
  const review: Parameters<typeof formatReviewComment>[0]["review"] = {
    summary: "x".repeat(70_000),
    verdict: "insufficient_context",
    findings: [],
  };
  const comment = formatReviewComment({ pr: PR, model: "deepseek-flash", review, input });
  assert.ok(comment.length <= 60_000 + 40);
  assert.match(comment, /review comment truncated/);
});
