# ADR 0004: One workout session draft for retro and live logging

- **Status:** Accepted. The shared package, timing/rest machine, core bridge, and
  draft payload are implemented in PR1. The web and mobile editors (PRs 2–4) are
  follow-ups.
- **Date:** 2026-10-23
- **Scope:** issue #24. The unified `SessionDraft`, optional live timing, transient
  rest, the shared `@agent-fit-trace/workout-session` package, and the draft
  persistence boundary.
- **Related:** [issue #24](https://github.com/HeZ2z/agent-fit-trace/issues/24),
  [`../mobile.md`](../mobile.md), [`../ui-design.md`](../ui-design.md).

## Context

The App has two workout editors with different local models:

- `app/src/screens/WorkoutEditorScreen.tsx` keeps its own `SetDraft`,
  `ExerciseDraft`, and `PainDraft` interfaces and allocates keys from a local
  `useRef(1)` counter.
- `mobile/src/data/logModel.ts` owns a separate `LogFormDraft` with one pain
  report and no duration, sleep, rest, or timing, and the React Native screen
  allocates its own keys.
- Both build a `WorkoutRecord`, validate it with the shared core, then let the
  repository derive the content id. The record contract in
  `packages/fit-trace-core/src/types.ts` is already shared; the editable draft in
  front of it is not.

Issue #24 originally proposed a separate Active Workout Mode: a dedicated route,
a separate draft entity, and a separate page. That plan predates the product
decision that recording after the fact and recording during a workout are the
same editor with an optional clock. Once live capabilities land — elapsed time,
pause/resume/finish, per-set checkboxes, a rest countdown, prefilled next sets,
and draft restore after a restart — duplicating them in two clients would almost
certainly drift in fields, semantics, persistence, and tests.

Two boundary facts matter:

1. **Timing is content-adjacent, rest is not.** A started session's elapsed time
   is part of the saved workout. A rest countdown is UI timing that cannot be
   meaningfully reconstructed after a restart, and persisting it would resurrect
   expired countdowns and replay stale cues.
2. **The draft must survive an invalid intermediate state.** A user types a
   weight, pauses, and gets killed by the OS; validation on restore would discard
   real work. Draft persistence therefore cannot reuse the strict record
   validator.

## Decision

### 1. One `SessionDraft` for retro and live sessions

`packages/fit-trace-workout-session/src/types.ts` defines the single editable
model:

```ts
interface SessionDraft {
  version: 1;
  date: string;                    // local YYYY-MM-DD
  sessionType: SessionType;
  durationMinutes: string;         // untimed sessions only
  sleepHours: string;
  notes: string;
  exercises: DraftExercise[];      // { key, name, restSeconds, sets }
  pain: DraftPain[];               // { key, area, level }
  timing: SessionTiming | null;    // null = never started (after-the-fact)
}
```

`timing === null` is the untimed/after-the-fact entry path; a non-null timing is
the live path. There is no separate active entity, route, or page, and no mode
flag beyond `timing`. The `done` marker on a set is only meaningful when the
session is timed; untimed saves ignore it and the unified editor hides the
checkboxes.
Saving is content-based: blank sets and exercises are dropped rather than
reported, while partially filled sets still pass through core validation. A
timed save additionally excludes auto-prefilled, unchecked next sets: they are
suggestions until the user edits or checks them.

### 2. Timing is optional persisted draft data

`SessionTiming` holds `startedAtMs`, `endedAtMs`, `pausedAtMs`, `pausedTotalMs`,
and `lastActiveAtMs`. The model never reads a clock: every transition receives
`nowMs` from the UI through `SessionAction`, and timing helpers are pure.

- `elapsedMs = (endedAt ?? pausedAt ?? now) - startedAt - pausedTotalMs`, floored
  at zero. Pause freezes the value; resume folds the pause into
  `pausedTotalMs`; finish freezes `endedAtMs`.
- Timed `duration_minutes` is derived on build as
  `max(1, round(elapsedMs / 60000))`. The manual duration field is used only for
  untimed drafts.
- Restoring a draft whose timing is still active auto-pauses it at
  `max(startedAtMs, lastActiveAtMs)`. Time while the app was closed or the page
  was refreshed is never counted as training; the UI asks whether to resume.
- The runtime rest and its cue start empty on every restore, so an expired
  countdown is never replayed.

### 3. Rest is transient `SessionRuntime`, never persisted

`SessionRuntime { rest: RestTimer | null, restEndedAtMs: number | null }` lives
only in memory. The persisted per-exercise `restSeconds` is configuration
(default 90 s), not a timer.

- Checking a set starts (or replaces) that exercise's rest; checking the last set
  also prefills the next one from the same weight/reps, marked `prefilled` and
  excluded from a timed save until the user edits or checks it.
- `±15 s` adjusts the timer, `skipRest` clears it, pause freezes the remaining
  milliseconds, and resume rebuilds `endsAtMs` from that remainder.
- `tick` settles an elapsed rest and writes `restEndedAtMs` once; the UI plays
  its cue on the `null` → number transition. Restarting a rest clears the cue.
- A restart or refresh loses the countdown and does not emit a rest-ended cue.
  This is intentional: rest is assistance, not workout history.
- Unchecking a set, removing its exercise/set, or finishing the session clears a
  referencing rest without a cue.

### 4. Shared pure package, with plate math in core

`packages/fit-trace-workout-session/` (`@agent-fit-trace/workout-session`) owns
types, draft constructors, the action union, the reducer, timing, the rest
machine, the core bridge, and the draft payload. It is private, exports
`./src/index.ts` directly (no build step), depends only on
`@agent-fit-trace/core`, and stays browser-safe: no React, expo, DOM, or Node
built-ins, `.ts` relative imports, and erasable syntax.

Entity keys are persisted with the draft, but the next-key counter is not.
`allocateKey(draft)` derives `max(all exercise/set/pain keys) + 1`, and add
actions carry no key, so a reload cannot desynchronize the next key and the
reducer always allocates a fresh one. This replaces the web `useRef` counter and
the mobile `createSetDraft` allocation in later PRs.

The session package bridges to the core rather than reimplementing validation:
`buildWorkoutRecord` maps draft strings to a `WorkoutRecord`,
`validateSessionDraft` calls core `validateWorkoutRecord`, and `toSaveInput`
strips the validation placeholder id so repositories derive the content id.

Barbell plate-loading math lives in `packages/fit-trace-core/src/plates.ts`, not
in the session package. It is shared domain math used by both editors and has no
dependency on sessions, timing, or persistence.

### 5. Per-client async persistence boundaries

Only the draft is serialized, as canonical JSON via core `stableStringify`.
`SessionRuntime` never enters the payload.

- **Mobile:** a `session_draft` table in the existing SQLite store (migration
  v2), one row constrained to the active draft, with debounced serialized writes
  and a flush before backgrounding or finishing. Parse failures raise
  `SessionDraftCorruptionError` and offer an explicit discard.
- **Web:** the existing `StorageAdapter` with a single key
  `agent-fit-trace:session-draft:v1`, rewritten on reducer changes. Storage
  failures surface an error with an explicit discard.
- One unfinished draft at a time. A successful save clears it. Drafts stay on
  the device: they are not synced or exported, and logout or account switching
  clears them.
- Payload decoding checks structure only — version, types, arrays, unique keys,
  timing consistency, unknown fields — and deliberately skips core record
  validation, so a mid-edit draft with an empty date or unparsable numbers is
  restored. The core validates when the user saves.
- Versioning fails closed with **no migration path**: an unsupported payload
  version is corruption, not an upgrade opportunity. Three version layers stay
  orthogonal: the payload `version` (draft structure), the storage key namespace
  `v1`, and SQLite `user_version = 2` (table structure).

## Drivers

- **One editor, not two modes.** Users should be able to fill in a session after
  the fact or start the clock at any point without switching entity or route.
- **Field parity.** Web and mobile must expose the same fields — date, session
  type, exercises, sets, per-exercise rest, duration, sleep, notes, multiple pain
  reports — so behavior and validation cannot diverge.
- **One live state machine.** Timing, checkboxes, prefills, and rest are the
  highest-risk behavior; implementing them twice invites drift and doubles the
  test surface.
- **Determinism and testability.** A pure reducer with injected `nowMs` can be
  covered by the root `node:test` suite without React Native or a browser.
- **Restart safety.** An unfinished draft must survive an app restart, but the
  rest countdown must not pretend to have continued while the app was gone.
- **Fail closed, discard explicitly.** Drafts are temporary data; silently
  repairing or migrating them hides data loss, while silently deleting them is
  worse.

## Alternatives considered

- **Separate active-workout entity and page (the original issue #24 plan).**
  Rejected: it needs a conversion path from an existing draft, doubles the
  persistence and validation surface, and creates two identities for what is the
  same session. The product need is one editor with an optional clock.
- **AsyncStorage on mobile for the draft.** Rejected: the mobile local store is
  already SQLite with versioned migrations; adding a second persistence mechanism
  means a second corruption/versioning story and no transactional relationship
  with the existing workout tables. The `session_draft` table fits the current
  infrastructure.
- **Persist rest in the draft payload.** Rejected: rest is ephemeral UI state.
  A restored countdown could already be minutes or hours expired, and replaying
  `rest-ended` after a restart would be wrong. Keeping it in `SessionRuntime`
  makes the stale state unrepresentable.
- **A background notification or foreground service for rest.** Rejected: it
  needs platform permissions and lifecycle machinery disproportionate to a
  rest timer. Timestamps plus a `tick` on foreground are sufficient; the UI
  compensates when the app returns.
- **Duplicate the models per client and share only core validation.** Rejected:
  the live state machine is exactly the part that must not be duplicated. Field
  parity and the reducer/action contract are cheaper to maintain in one package
  than to re-verify in two.
- **Keep the mobile model and give web its own equivalent; merge later.**
  Rejected for the same drift reason; a later merge would need the same migration
  and test work with a larger accumulated diff.

## Why chosen

A single `SessionDraft` makes retro and live logging the same data shape and the
same reducer, so the fields cannot drift and the live behavior is written and
tested once. Treating timing as an optional property rather than a mode keeps the
"start the clock" affordance available in one editor and avoids a second entity.

Separating persistent timing from transient rest matches the actual lifetimes:
timing belongs to the saved workout and must survive an app kill; rest is
window-bound advice and must not be resurrected. The auto-pause-on-restore rule
trades a small duration undercount while the app was closed for never recording
hours of fictitious training.

The package boundary keeps the risky logic deterministic and framework-free,
usable by the web reducer and the React Native reducer without conditional
imports. Persisting only the draft, with structure-only decoding, is the one
combination that both restores in-progress work and refuses to trust a corrupted
payload.

## Consequences

**Positive**

- Web and mobile converge on one model, one action contract, and one reducer;
  later PRs delete their local allocation and draft helpers instead of growing
  them.
- Timing, rest, key allocation, build/validation, and the payload are covered by
  the root `node:test` suite without a browser or a React Native runtime.
- An unfinished session survives a restart or refresh; invalid mid-edit input is
  restored and only rejected at save time, where the user can fix it.
- Rest can never come back stale, and no prompt/sound fires for a countdown that
  elapsed while the app was suspended.
- Empty pre-filled sets and exercises no longer block a save; validation reports
  only content the user actually entered.

**Negative / open work**

- Mobile SQLite migration v2 is one-way. Rolling back to an older build means
  forward-fixing or clearing app data; the migration does not touch the
  `workouts` table, and old data is never deleted.
- Draft payload versions have no migration path by design; a version mismatch or
  corruption is resolved only by the user discarding the draft.
- Restoring an active timing auto-pauses it at `lastActiveAtMs`, so duration
  undercounts the time the app was closed. A future heartbeat could narrow the
  gap, but it was not judged worth the complexity now.
- The rest countdown is lost on restart by design.
- The web editor and mobile Log screen still need their parity work, copy,
  accessibility, i18n slices, and tests (PRs 2–4).
- `app/` and `mobile/` must add the `workspace:*` dependency before they can use
  the package; the root tests currently import the package by relative path.
- Timezone and clock changes are handled with epoch milliseconds, an elapsed
  floor of zero, and a local calendar date captured at start — not with a global
  clock abstraction.

## Follow-ups

- **PR1 (this change):** the shared package (types, reducer, timing/runtime,
  build/validation, persistence payload), the core plate math, tests, and this
  ADR. No UI changes.
- **PR2 — `feat/24-web-session-model`:** move the web editor onto the shared
  model with behavior and existing tests preserved, and delete its local key
  allocation.
- **PR3 — `feat/24-web-live-session`:** add the web timing bar, per-set
  checkboxes, rest bar, plate dialog, draft persistence, sound/vibration, and the
  shared i18n slice.
- **PR4 — `feat/24-mobile-unified-session`:** rewrite the mobile Log editor on
  the shared model with live capabilities, add the SQLite `session_draft`
  migration and `expo-audio`, add mobile-specific copy/docs, and remove
  `mobile/src/data/logModel.ts`.

## Out of scope

- draft cloud sync, multiple simultaneous drafts, or cross-device drafts;
- background notifications, foreground services, or reminders while the app is
  closed;
- editing already-stored workout records (the store remains append-only);
- server, API, or pi-side changes.
