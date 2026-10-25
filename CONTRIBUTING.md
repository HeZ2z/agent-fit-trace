# Pull Request Guidelines

These guidelines apply to maintainers, contributors, and coding agents. Follow [AGENTS.md](AGENTS.md) for module boundaries and the product contracts in [docs/](docs/) for expected behavior. Write commit messages, PR titles, and PR descriptions in English.

## Before you start

Search existing issues and PRs for the same problem. Link related work and explain how your approach differs if another PR addresses it.

You can start work on a clearly scoped bug fix or documentation correction directly. For a substantial new feature, public API change, or architectural change, establish the use case and scope in an issue or discussion before investing in implementation. An existing task or agreed plan can provide that context; no separate approval is needed for work already in scope.

## 1. Keep changes focused

- Solve one clear problem per PR. Submit unrelated features, refactors, and formatting changes separately.
- Reuse existing utilities and patterns. Keep diffs small and reversible. Add dependencies only when explicitly authorized by the task.
- Write a cleanup plan before refactoring. Add regression tests first if existing behavior lacks test coverage.
- Explain the concrete benefit of a refactor, such as removing duplicated logic, enabling a related fix, or improving measured performance. Follow the surrounding code style and avoid broad stylistic rewrites.
- Update the relevant documentation when changing APIs, domain behavior, configuration, or development workflows.
- Keep secrets, personal workout data, local storage, and unrelated generated files out of commits. Use anonymized test fixtures.

## 2. Branches and commits

Create a working branch from the latest version of the target branch. Suggested names are `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, and `refactor/<topic>`. Include an issue number when useful, such as `fix/123-import-conflict`.

Every commit message starts with a **Conventional Commits** header: `type(scope): summary in the imperative mood` (for example, `fix(mobile): keep a sync run alive across token refresh` or `feat(cli): add daemon health probe`). Omit the scope when no single package owns the change, as in `docs: document the desktop shell`. Use an `!` or a `BREAKING CHANGE:` footer for breaking changes.

Allowed types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `revert`. Pick a scope from the module layout: `core`, `store`, `workout-session`, `api-contracts`, `cli`, `desktop`, `mcp`, `app`, `mobile`, `server`, `pi` (for `.pi/extensions/fit-trace`), `skill`, or `repo` for cross-cutting repository files.

Beyond the header, every commit still follows the repository's **Lore protocol**: explain why the change is needed in the body, describe the context and approach, and add git-native trailers where useful. Avoid vague summaries such as “update code” or “fix issues.”

```text
fix(store): reject conflicting imports instead of overwriting workouts

Users may upload a record with the same id more than once. Treat identical
content as a no-op and reject conflicting content to preserve the original.

Constraint: Imports must be idempotent and preserve original records
Rejected: Overwrite existing records | would lose original workout data
Confidence: high
Scope-risk: narrow
Directive: Preserve duplicate and conflict regression tests when changing imports
Tested: Unit tests for identical re-imports and conflicting content
Not-tested: Manual verification in a real pi runtime
```

Trailers are optional. Record only useful information. Common fields include `Constraint`, `Rejected`, `Confidence`, `Scope-risk`, `Directive`, `Tested`, `Not-tested`, and `Related`. Leave a blank line between the body and trailers.

## 3. PR titles and descriptions

Use a title that states the concrete problem or resulting behavior, for example:

- `fix(store): prevent duplicate imports from overwriting existing workouts`
- `feat(app): add date range filtering to workout history`
- `docs: clarify local development steps for HTTP mode`

Avoid vague titles such as “improvements” or “miscellaneous fixes.” PR titles follow the same Conventional Commits header as commit messages.

Use the [PR template](.github/pull_request_template.md). Summary and test evidence are required; include risk details when relevant. Give reviewers enough context without requiring them to read prior discussions:

1. **Problem and outcome:** Explain the reason for the change, its trigger, and the before-and-after behavior. Link related issues; use `Closes #<number>` when merging should close an issue.
2. **Changes and tradeoffs:** Describe the main changes, affected modules, and necessary design rationale. One or two sentences are enough for a small change.
3. **Verification evidence:** List commands actually run and their results. For manual checks, describe the steps and observations. Include screenshots or recordings for UI changes.
4. **Risks and unverified areas (when applicable):** Note compatibility concerns, data migrations, configuration changes, deployment dependencies, and verification gaps. Describe rollback steps for migrations or deployment changes. Omit this section when none apply.

For bug fixes, include a minimal reproduction or link to an issue containing one. For new features, explain the user need and include tests for the new behavior. Call out any part that needs particular reviewer attention, such as an API tradeoff, data migration, or performance-sensitive path.

Keep the description aligned with the final diff. Update the title and description when scope changes, and remove template instructions and irrelevant sections. Omit discussion history and abandoned attempts unless they explain a relevant tradeoff.

## 4. Verify before submitting

Use Node >= 24 and the pnpm version specified by `packageManager` in the root `package.json`.

For code changes, run these commands from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Current [CI](.github/workflows/ci.yml) runs `pnpm test` and `pnpm typecheck`; verify the build locally. The repository has no separate lint or static analysis script. `typecheck` provides TypeScript static checks. Run any additional checks introduced in the future as well.

For documentation-only changes, review the content, check relative links, and run `git diff --check`. Explain why code checks were not run. If the environment prevents a required check, record the blocker and unverified scope, keep the PR in Draft, and do not report the check as passing.

Add verification appropriate to the changed area:

| Changed area | Verification focus |
| --- | --- |
| Shared core / domain tools | Determinism, input validation, import idempotency and conflicts, date boundaries, draft-only plan generation |
| Data clients / API | Shared contract tests and error semantics; authorization and user data isolation when authentication is affected |
| pi Extension / storage | Failures propagate by throwing, stored records are revalidated on load, corrupt-store errors; pi/typebox imports stay in `index.ts` |
| App / UI | Affected interactions, loading and error states; local / HTTP paths when data modes are affected |
| Deployment / configuration | Required environment variables, build artifacts, deployment steps, and rollback procedures |

For bug fixes, add a regression test that fails without the fix and passes with it. If an automated test is not practical, explain why and provide reproducible manual verification. Tests should verify meaningful, observable behavior rather than mirror the implementation or merely increase coverage. Do not describe planned Agent execution paths as implemented.

## 5. Review and merge

- Open a Draft PR while implementation, verification, or design questions remain. Mark it ready for review when those are resolved.
- Respond to each review comment with the change location or the reason for retaining the approach. Rerun affected checks after edits.
- Before merging, confirm that CI passes on the final revision, required verification is complete, conflicts are resolved, and blocking review comments are addressed. Follow the repository's actual branch protection rules.
- When using squash merge, ensure the final commit message starts with the Conventional Commits header and preserves important decisions and verification gaps.
- Submitting a PR does not authorize deployment or publication. Follow the authorization scope of the task for those actions.

## References

The structure and review guidance draw on these upstream resources, adapted to this repository's commands, [Conventional Commits](https://www.conventionalcommits.org/) headers, and Lore protocol:

- [React PR template](https://github.com/facebook/react/blob/main/.github/PULL_REQUEST_TEMPLATE.md): motivation and concrete test evidence.
- [Vite contributing guide](https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md#pull-request-guidelines) and [PR template](https://github.com/vitejs/vite/blob/main/.github/PULL_REQUEST_TEMPLATE.md): focused changes, regression tests, related work, and reviewer attention.
- [Vue contributing guide](https://github.com/vuejs/core/blob/main/.github/contributing.md#pull-request-guidelines): reproducible bugs, justified features, and useful refactors.
- [VS Code PR template](https://github.com/microsoft/vscode/blob/main/.github/pull_request_template.md): a short template linking to detailed guidance.
