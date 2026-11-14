---
name: "issue-to-pr-sop"
description: "Use when running the issue-to-fix workflow for this repository (发现问题 → 修复 → 合并), or when asked what the process is. Covers: search existing issues first, draft the issue with agy and review it with codex, have codex write and review the plan, implement with subagents, open a PR linked to the issue, iterate with @codex review until it reports no findings, and leave merging to a human."
---

# Issue → Fix → Pull request SOP

This is the working agreement the repository owner set for coding agents on this
repository. Follow it from problem discovery through merge. A clearly scoped bug
fix or documentation correction may skip the issue step (see `CONTRIBUTING.md`
"Before you start"), but the rest still applies.

## Steps

1. **Triage.** Search existing issues and PRs for the same problem. If another
   PR already covers it, link it and stop duplicating the work.
2. **Issue first.** For a substantial feature, public API change, or
   architectural change, establish the use case and scope in an issue before
   implementing. Draft the issue body with the local `agy` CLI (symptom,
   reproduction steps, expected behavior, acceptance criteria) and have the
   local `codex` CLI review it for completeness and scope. The agent merges the
   feedback and posts the issue.
3. **Plan.** Have local `codex` write the implementation plan and review it
   before touching code. `codex exec` is the non-interactive entry point.
4. **Implement.** DSH subagents do the implementation. Keep the diff focused and
   add regression tests for behavior changes; deterministic core rules and the
   module boundaries in `AGENTS.md` still apply.
5. **Pull request.** Branch from the latest base (`fix/<topic>`,
   `docs/<topic>`, ...), link the issue with `Closes #N`, and fill
   `.github/pull_request_template.md`: problem and outcome, changes and
   tradeoffs, the exact checks run, and any material limitation. Commit in
   English with a Conventional Commits header and the repository's Lore-style
   body.
6. **Review loop.** The cloud Codex GitHub App starts a review when someone
   comments `@codex review` on the PR. The connector answers the *commenter's*
   account: a comment from an account without a connected Codex account only
   gets "To use Codex here, create a Codex account and connect to github", with
   no review. The agent account is not connected, so the agent asks the owner to
   post `@codex review` after a push (or the owner posts it themselves), then
   addresses the findings. Re-trigger after every push, because the cloud review
   is bound to a specific commit SHA. Iterate until codex reports no new
   findings.
   - The agent's standing rule caps automated-review rounds at three per PR per
     reviewer account. After the third round, stop triggering bot review,
     deliver the PR with the remaining findings stated honestly, and let a human
     decide. Human review and CI are not subject to this cap.
   - The repository's self-hosted AI review (`.github/workflows/ai-review.yml`,
     `docs/ai-review.md`) runs automatically on PR events and is advisory: it
     never approves, requests changes, or gates a merge.
7. **Merge.** Only the repository owner, or someone they explicitly authorize,
   merges. The agent must never merge, enable auto-merge, approve on a
   reviewer's behalf, or close issues. Report the PR as ready for human review
   and stop there.

## Notes

- This file lives in the repository's `.agents/skills` root, which the harness
  scans as a project-scoped skill source, so it survives across tickets and
  clones. Do not move it to a user-level skill directory.
- Do not add requirements beyond what the owner stated. If a step is ambiguous
  for a new case, ask the owner instead of inventing policy.
