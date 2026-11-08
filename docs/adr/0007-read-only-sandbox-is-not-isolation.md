# ADR 0007: Accepting a read-only sandbox as the Codex coaching gate

- **Status:** **Accepted for Codex only.** Implemented in
  `codexAppServerCapability.ts` / `codexAppServerAdapter.ts`: `local-codex` is
  admitted under a `read-only` posture once the `item/tool/call` flow exists.
  **OpenCode is NOT relaxed** — its gate already demands positive evidence from
  a verifier that production does not supply, and that is a missing
  implementation, not an unsatisfiable requirement, so it stays unavailable.
- **Date:** 2026-11-05 (accepted 2026-11-08)
- **Scope:** `server/coaching/codexAppServerCapability.ts`,
  `server/coaching/opencodeCapability.ts`, and the `builtinIsolationVerified` /
  `isolationVerified` gates they feed.
- **Related:** [`0001-agent-execution-backends.md`](0001-agent-execution-backends.md),
  [`../local-daemon.md`](../local-daemon.md), issue #68.

## Context

The local coaching path runs the user's own agent CLI over a read-only domain
snapshot and gives it exactly two tools — `get_training_history` and
`analyze_progress`. Both adapters therefore refuse to run until the installed CLI
can prove it exposes **only** those tools:

- `codexAppServerCapability.ts` requires `thread/start.dynamicTools` plus the
  `DynamicToolCallParams`/`DynamicToolCallResponse` flow, **and** separately
  requires `builtinIsolationVerified`.
- `opencodeCapability.ts` requires positive evidence that the generated
  wildcard-deny config excludes OpenCode's built-in inventory and every other
  agent.

Measured on a development machine on 2026-11-05, with both CLIs installed:

| CLI | Path | Probe verdict |
| --- | --- | --- |
| codex 0.164.0 | `/opt/homebrew/bin/codex` | `installed codex app-server schema does not expose thread/start.dynamicTools` |
| opencode 2.0.30 | `/Users/hezzz/.bun/bin/opencode` | `plugin-isolation-unproven` |

`codex app-server generate-json-schema` against 0.164.0 was inspected directly:
`ThreadStartParams` has `approvalPolicy, approvalsReviewer, baseInstructions,
config, cwd, developerInstructions, ephemeral, model, modelProvider,
personality, sandbox, serviceName, serviceTier, sessionStartSource,
threadSource` — no `dynamicTools`. The generated schema does contain
`DynamicToolCall*` **result** types, but not the input that would let a client
inject the two domain tools.

The second gate matters more than the first: even where `dynamicTools` exists,
`codexAppServerAdapter.ts`'s own header states the position this ADR is asked to
reverse:

> A plain `read-only` sandbox still permits arbitrary file reads and
> exfiltration, so it is not isolation.

`tests/codexAppServer.test.ts` pins that judgment: a modern schema **with**
`dynamicTools` is still refused with `builtin-isolation-unproven`.

The reference project OpenDesign takes the weaker position: its Codex adapter
relies on `sandbox: "read-only"` (or `workspace-write`) and accepts the CLIs'
built-in tools, because its artifacts are design files where reading the
workspace is the point.

## Decision

**Codex only.** `local-codex` becomes available when the installed CLI exposes
the `item/tool/call` flow, which can be pinned to a **read-only sandbox with
network access disabled** even though its built-in file-reading tools remain
present. The adapter already passes `sandbox: "read-only"` and
`sandboxPolicy: { type: "readOnly", networkAccess: false }`, so this changes the
**claim**, not the launch configuration.

The proof requirement is replaced by an explicit posture, because collapsing the
two into one boolean loses the distinction a reviewer needs:

| posture | meaning |
| --- | --- |
| `"strict"` | positive proof the built-in inventory is excluded (no released Codex provides this) |
| `"read-only"` | admitted: run-only policy, reads still possible |
| absent | not admitted; the adapter fails closed |

`builtinIsolationVerified` is still reported (`false` under the relaxed gate) so
a caller can tell the two apart.

**`local-opencode` is deliberately NOT relaxed.** Its gate is not unsatisfiable:
it demands `isolationVerified`, which is supplied by a verifier that production
simply has not implemented. That is missing work, not a demand no CLI can meet,
so relaxing it would be a different (and avoidable) concession. It stays
unavailable until a verifier exists.

## Consequences

### What this concedes

A coached run becomes able to read files the model chooses, not only the
snapshot the product hands it. Concretely, for this product that includes:

- `~/.fit-trace/data/*.db` — the user's full workout history, including records
  the run's own snapshot was scoped to exclude;
- unrelated files under the user's home directory — SSH keys, other projects,
  notes, browser profiles — whatever the OS account can read;
- exfiltration through the response text. Nothing writes to disk, but a read
  value can be echoed into the transcript, and a prompt injection inside a
  workout note or an imported file is enough to induce it.

"Read-only" describes the **filesystem**, not the **data boundary**. The product
contract ("you have exactly two tools") would also need restating, since the
model would in fact have more.

### Mitigations that are available

- bind `cwd` to a per-run empty directory (already done for Codex: `cwd:
  launch.sessionDir`), which limits *discovery* but **does not** stop an
  absolute-path read;
- `networkAccess: false`, which removes exfiltration *through the tool*, though
  not through the model response;
- keeping the snapshot out of the child process, so the product never *hands*
  the model a path.

None of these closes the gap. They reduce the likelihood; they do not establish
isolation.

### What would be better

Establish the strict gate instead of relaxing it, by depending on a Codex version
that supports verified inventory exclusion, or by supplying OpenCode a real
isolation verifier. Failing that, the honest options are to keep both backends
unavailable and say why in the UI (#69), rather than to advertise a coach whose
containment claim is weaker than the product states.

### Reversibility

The relaxation must remain a single predicate. Nothing outside the two
capability probes should encode "read-only is enough", so that restoring the
strict gate is a one-file change and the regression suite (which currently
asserts the strict behaviour) can be flipped deliberately rather than excavated.

## Open questions for review

1. Is "read-only + no network" an acceptable ceiling for a **health-data**
   application, given the transcript is the exfiltration channel?
2. Should the two backends be offered at all in a first release, or stay
   unavailable until the strict gate can be met?
3. If relaxed, does the coached system prompt need to disclose that the model can
   read files, so users are not misled by "exactly two tools"?
4. Should a relaxed backend be labelled as such in discovery (a distinct
   availability tier), rather than looking identical to the strict one?
