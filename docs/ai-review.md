# AI pull-request review

The repository runs a self-hosted, BYOK AI review on pull requests. It uses an
OpenAI-compatible chat endpoint (DeepSeek by default), reads the PR metadata and
changed-file patches through the GitHub API, and posts **one PR comment** with
structured findings.

It is deliberately **comment-only**: it does not approve, request changes, or
gate a merge. The GitHub Actions check is informational, but the step is not
`continue-on-error`: a reviewer crash fails the advisory job visibly instead of
silently passing.

## Why self-hosted

- No per-review vendor quota; the cost is API usage on the configured provider
  plus GitHub Actions minutes.
- The review prompt can carry repository-specific rules (deterministic core,
  canonical-English selection versus authored names, i18n display boundaries,
  generator checks, docs contract, web/mobile parity).
- The provider is replaceable: DeepSeek, OpenAI, or any OpenAI-compatible
  endpoint can be selected with repository variables. See
  [Qodo Merge](http://qodo-merge-docs.qodo.ai/usage-guide/changing_a_model/) or
  [PR-Agent](https://github.com/The-PR-Agent/pr-agent) if a maintained reviewer
  with more features is preferred.

## How it runs

- **Triggers:** PR `opened`, `synchronize`, `reopened`, and `ready_for_review`;
  plus `workflow_dispatch` with a PR number.
- **Skipped:** draft PRs, and PRs from forks by default (fork workflows do not
  receive repository secrets). The manual-dispatch form has an
  `allow_forks` checkbox for an intentional fork review.
- **Trusted code:** the workflow checks out the PR **base commit**, not the PR
  head, so a PR cannot change the reviewer script before it is reviewed. The
  script never executes PR code; it only reads the GitHub API and calls the
  model.
- **Deduplication:** the comment starts with an invisible `<!-- ai-pr-review -->`
  marker. A rerun updates that PR's existing comment instead of adding another;
  the rendered review records the head SHA it reviewed.
- **Untrusted input:** PR title, body, and diff are wrapped as data and the
  system prompt tells the model not to follow instructions found inside them.

## Setup

The operator must configure the secret before enabling the workflow:

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_REVIEW_API_KEY` | secret | Provider API key (DeepSeek in this repository) |

Optional repository variables can override the defaults:

| Name | Default | Purpose |
| --- | --- | --- |
| `AI_REVIEW_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible base URL |
| `AI_REVIEW_MODEL` | `deepseek-flash` | Model id; `deepseek-v4-pro` is available on the same endpoint |
| `AI_REVIEW_REASONING_EFFORT` | `none` | DeepSeek reasoning level; set `omit` for providers that reject the field |
| `AI_REVIEW_JSON_MODE` | `1` | Set `0` for providers that reject `response_format` |

The defaults target the official DeepSeek endpoint. For another provider, set
the base URL and model to an OpenAI-compatible endpoint and keep the key in
`AI_REVIEW_API_KEY`. Model ids are provider-specific: check `/models` or the
provider documentation when changing endpoints.

The secret is intentionally out of band and never committed. Configure it in
the target repository if the workflow is copied; never commit a key.

## Cost and context limits

The script budgets the model context before calling the provider:

- up to 60 changed files and 60,000 diff characters (`AI_REVIEW_MAX_DIFF_CHARS`
  can lower or raise the latter);
- per-file patches are truncated to 12,000 characters;
- generated outputs, lockfiles, binaries, and the vendored catalog JSON tables
  are excluded because they are noisy review subjects;
- at most 20 findings; the posted comment is capped at 60,000 characters.

The review disables reasoning (`reasoning_effort: none`) by default so the JSON
answer fits the 16,000 completion-token budget (`AI_REVIEW_MAX_TOKENS`). Set
`AI_REVIEW_REASONING_EFFORT=medium` (or another DeepSeek-supported level) for
more deliberate reviews at a higher token cost. Set it to `omit` for providers
that reject the parameter (the workflow's repository variable accepts the same
value). The script retries transient 429/5xx responses twice. If
the model exhausts its output budget or returns malformed JSON, it retries with
a strictly smaller diff budget when one exists (for the default 60,000-char
budget: 30,000, then 20,000) so it can post a partial review; the comment notes
truncation. A manual run normally costs one model call per PR revision, and up
to three calls for a very large diff.

## Local dry run

Dry run posts nothing; it prints the Markdown comment to stdout. `GITHUB_TOKEN`
can come from `gh auth token`:

```bash
GITHUB_TOKEN="$(gh auth token)" \
GITHUB_REPOSITORY=HeZ2z/agent-fit-trace \
PR_NUMBER=123 \
AI_REVIEW_API_KEY=... \
AI_REVIEW_DRY_RUN=1 \
node --experimental-strip-types scripts/ai-review.ts
```

For a real local run, omit `AI_REVIEW_DRY_RUN` (the comment is posted/updated
using the supplied token).

## Limitations

- The model sees only changed-file patches, not full files or test output; it
  can miss context outside the diff.
- It cannot validate runtime behavior, accessibility, or device-only behavior.
- It is not a substitute for CI, human review, or the repository's ADR review
  gates.
- The review is advisory. Treat findings as review input and validate them
  against the code and tests.
