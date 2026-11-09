# ADR 0008: Cloud coaching from the desktop app, and where sync runs

- **Status:** Proposed. Design decision only; no code changes accompany this ADR.
- **Date:** 2026-11-09
- **Scope:** issue #69. The desktop app's path to the hosted coach, the settings
  surface for choosing a local CLI, and the sync boundary that makes cloud
  coaching see the user's real history.
- **Related:** [`0001-agent-execution-backends.md`](0001-agent-execution-backends.md),
  [`0007-read-only-sandbox-is-not-isolation.md`](0007-read-only-sandbox-is-not-isolation.md),
  [`../mobile.md`](../mobile.md) ("Sync"), [`../local-daemon.md`](../local-daemon.md).

## Context

Three facts, each verified rather than assumed:

1. **The desktop app has no cloud path.** `daemonServer.ts` and
   `launcherServer.ts` mount no `/api/v1/coaching/cloud*` route (grep count 0);
   only `server/vercel.ts` and `api/v1/coaching/cloud/*.mjs` do. The app's cloud
   client refuses absolute URLs (`assertSameOriginBase`,
   `cloudCoachingClient.ts:89`).
2. **Cloud and local coach different data.** A hosted run materializes its
   snapshot from the HOSTED store (`materializeRecords` →
   `source.listWorkouts`, `server/cloud/httpHandler.ts:160`), while the desktop
   daemon keeps workouts in LOCAL SQLite. The client submits a date FILTER, not
   records (`cloudCoachingClient.ts:287`). A proxied cloud run therefore
   succeeds while coaching against empty or different history, with no error
   anywhere.
3. **The mobile app already solved a superset of the sync problem** —
   `mobile/src/sync/`: durable outbox, remote provenance, fingerprinted conflict
   choices, a fenced lease, background triggers (`docs/mobile.md` "Sync").

The product owner chose **explicit sync/upload** over hosted-history-only, so a
desktop user's records must reach the account before cloud coaching on them is
meaningful.

## Decision

### 1. Transport: proxy cloud coaching through the loopback daemon

One same-origin surface; no CORS on the hosted API; bearer handling in one
reviewed place. Forward the **public** API path — do not reproduce Vercel's
internal `__fit_trace_cloud_op` rewrite marker, the hosted deployment owns its
own rewrites.

Constraints the proxy must satisfy:

- forward only the caller's **account** bearer to a fixed, allowlisted HTTPS
  upstream; never substitute the daemon's guest token or any privileged
  credential;
- reject redirects (the launcher already does, `launcherServer.ts:630`);
- preserve `Accept`, cursor query, status and content type; abort upstream on
  client disconnect; respect backpressure;
- never forward the loopback `Host`/`Origin` upstream;
- keep the daemon's Host/Origin gate. It protects same-origin access — it allows
  an absent `Origin` and runs **before** the trusted handler, so it is **not**
  authentication (`coachingServer.ts:200`, `:679`).

**SSE is not solved by proxying alone.** The hosted endpoint accumulates frames
into a `body` string and returns once the deadline is reached
(`httpHandler.ts:403-425`), and the existing launcher proxy buffers the whole
response into `text` before replying (`launcherServer.ts:659`). Streaming
through the daemon would therefore relabel a buffered response as a stream. The
honest options are (a) poll the endpoint from the client as it works today, or
(b) make the hosted side stream first. This ADR records the limitation rather
than pretending the proxy fixes it.

### 2. Sync runs in the DAEMON, not the renderer

This is the load-bearing decision, and it follows from how the existing engine
enforces safety: mobile applies lease generation and consent **inside the SQL
statement** that writes a remote record
(`workoutRepository.ts:250`, the `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM
sync_lease …) AND EXISTS (SELECT 1 FROM sync_consent …)`), so the check and the
write are one atomic operation.

A renderer-side "check the lease, then POST the workout" cannot reproduce that:
the two steps are separated by an HTTP round trip, and a revoked lease or a
consent change in between silently writes a record the user did not authorise.
Running the runner inside the daemon keeps check-and-write atomic against the
daemon's SQLite, which is where the data actually lives.

The renderer therefore gets **coarse sync commands and status** over HTTP, not
repository access.

### 3. Share the portable engine, keep orchestration platform-owned

A "pure logic only" extraction (six modules, zero platform imports) is **not
real**: `syncCoordinator.ts` imports `openWorkoutDatabase`, `WorkoutRepository`,
and the Expo-backed session store, and its headless path constructs the
repository directly.

So the shared package owns:

- the sync plan and its validation/failure helpers;
- the conflict/apply models and result types;
- trigger/config resolution;
- `runWorkoutSync` and the repository / remote-client **interfaces**;
- account/scope/lease types (moved out of the mobile schema);
- `WorkoutSyncClient`, which already injects fetch and token providers and has
  no storage dependency — its Expo config reader moves to a mobile wrapper.

Platform-owned, not shared: the coordinator, the lifecycle/background
scheduling, credential access, migrations, and the concrete repositories.

`syncModel`'s dependency on mobile's `AuthStatus` becomes a neutral gate type.

**A production adapter must implement the durable capabilities.** Omitting
optional methods silently drops guarantees — most sharply `listUploadCandidates`,
without which nothing is ever uploaded. The desktop daemon gets a SQLite
adapter satisfying the same interface.

### 4. Delivery order

Sync blocks *completing* #69, not every merge:

1. **Settings page for CLI selection** — independent, and it consumes what #68
   already exposes (`executablePath`, `version`, `unavailableReason`).
2. **Daemon proxy for cloud routes**, with cloud availability still **disabled**
   in discovery.
3. **Sync**: shared package extraction, the daemon SQLite adapter, coarse sync
   endpoints, and the mobile side rewired onto the shared code.
4. **Enable cloud**, once the selected account and history actually reconcile.

Shipping enabled cloud at step 2 with an "only hosted records" note would
reinstate the option the product owner rejected. Also note: acknowledging a
conflict does not upload local content (`syncApplyModel.ts:156`), so "sync says
done" does not establish that local and hosted history are identical.

## Consequences

**Positive.** One sync engine, one conflict semantic, no per-platform fork. The
security properties stay where they were enforced — inside the write. Cloud
coaching becomes meaningful rather than silently empty.

**Negative / open work.** The extraction touches the mobile callers, which is
the part with real users today. The daemon gains a SQLite repository adapter
that did not exist. SSE remains non-streaming until the hosted side changes.
A custom destination's identity provider still needs its own answer — the
official default is the only one whose auth bootstrap is defined here.

## Open questions

1. Should sync be user-initiated per record, or consent to the whole account as
   on mobile? The desktop has no equivalent "enrol a workout" affordance yet.
2. What does the settings page show when the account is a guest — sync cannot
   run, so is cloud shown as "sign in first" or hidden?
3. If the hosted SSE is fixed to stream, does the daemon proxy need its own
   streaming implementation, or can the client poll directly?
