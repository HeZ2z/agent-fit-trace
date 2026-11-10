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

**Sequence the SSE work: fix the hosted side first, then decide the proxy.**
The existing launcher proxy buffers the whole response into `text`
(`launcherServer.ts:659`) because it was written for JSON. A cloud proxy could
instead pipe — `Readable.fromWeb(upstream.body)` into the response, with
disconnect cancellation, backpressure and error handling — which removes a
second full-body buffer.

But that is a transport optimisation, and today it buys nothing visible. If the
hosted endpoint only ever does paged long-polling, passthrough merely turns
"receive everything at once" into "receive everything at once through a pipe".
It earns its complexity only once the hosted side genuinely flushes frames
progressively — and then the proxy owes backpressure, client-disconnect
cancellation and upstream timeout handling. **So change the hosted side first;
the proxy decision follows from whether it actually streams.**

It does **not** make events arrive promptly. The hosted endpoint still
accumulates frames into a `body` string and returns once the deadline is
reached (`httpHandler.ts:403-438`), so a client sees everything at once. Live
SSE requires a change on the hosted side; the proxy can only be efficient, not
timely. Do not describe the result as streaming to the user.

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

### 2a. Credentials: foreground, in-memory, never persisted

This decides whether daemon-side sync is even viable, and it is the part with
no existing mechanism.

The daemon already accepts Supabase credentials when a project is configured
(`daemonServer.ts:589`, composite verifier), and the shared client takes a fixed
bearer per run (`mobile/src/sync/syncClient.ts:78`). So for **user-triggered**
sync the renderer supplies a current access token; the daemon verifies it, binds
the run to that account and destination, and keeps it **in memory only** for the
duration.

On expiry: pause, let the renderer refresh, resume. Fence logout and account
changes so a stale token cannot write under a new principal.

**Unattended/background sync is out of scope** and would need its own secure
persistence and refresh design — the daemon has none today. Saying this
explicitly matters: without it, "sync runs in the daemon" quietly implies a
credential store that does not exist.

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

**The daemon's schema cannot support that today, and the mobile migrations
cannot be copied.** The daemon stores `workouts(id, date, canonical, record)`
(`packages/fit-trace-store/src/sqlite.ts:17-22`): no `origin` column, and none of
`sync_outbox`, `sync_consent`, `sync_lease`, `sync_remote_membership`. Mobile
has all of them (`mobile/src/data/schema.ts:51-118`), but its migrations also
reference a `created_at` column the desktop schema does not have
(`schema.ts:189`).

So the desktop gets **its own versioned migrations**, not a copy:

- the provenance column plus a backfill policy for pre-existing rows (what
  `origin` do records that predate sync get, and does that make them upload
  candidates?);
- the durable sync tables, with lease and consent enforced in the same
  statement that writes a remote record;
- migration for **every** writer of the desktop store, not just the app — the
  MCP server and the pi extension write through `@agent-fit-trace/store` too
  (`resolveActiveStore`), and a row they write must carry provenance correctly
  or it will be silently un-syncable;
- adapter conformance tests proving the desktop implementation satisfies the
  same interface semantics as mobile's, including the atomic fencing.

Share the engine and the interfaces; keep physical schema and migrations
platform-owned. That split is unchanged — this only makes it implementable.

### 4. Delivery order

Sync blocks *completing* #69, not every merge. Revised order (two reviews
converged on this):

1. **Settings page for CLI selection** — independent, and it consumes what #68
   already exposes (`executablePath`, `version`, `unavailableReason`).
2. **Sync**: shared package extraction, desktop migrations, the daemon SQLite
   adapter, coarse sync endpoints, and the mobile side rewired onto the shared
   code.
3. **Daemon proxy AND enabling cloud, together**, so the feature is exercised
   end to end the moment it becomes reachable.

An earlier proxy is permitted, but only with **server-side rejection of cloud
execution**, not merely hiding cloud from discovery.

**Why hiding is not enough.** Discovery is a declaration; it is not
authorization. `/api/v1/coaching/cloud/*` is externally reachable
(`server/vercel.ts:460`, `vercel.json:16-21`), and hosted snapshot creation reads
hosted history without checking whether the desktop has reconciled anything
(`httpHandler.ts:310`). An authenticated caller could therefore drive a cloud run
over an empty or stale history while discovery politely said "unavailable".
Whatever gate exists must reject the request, and there must be a test that
issues a direct request while cloud is nominally off.

**Enablement must check the account, the destination, and the requested
history** — not a bare "sync completed" flag. Two reasons: acknowledging a
conflict does not upload local content (`syncApplyModel.ts:156`), and a
completed sync does not establish that local and hosted histories are identical.

Shipping enabled cloud earlier, with an "only hosted records" note, would
reinstate the option the product owner rejected.

### 5. Signing in does not migrate guest data — and must not do so silently

The daemon isolates stores per principal (`server/sqlitePrincipalStores.ts:50`),
and an unauthenticated desktop session writes `guest.db`
(`packages/fit-trace-store/src/identity.ts:165`). On login the active store
switches to `<account_id>.db`.

Nothing migrates. A user who logged workouts for a month and then signed in would
find their history apparently gone, and cloud coaching would see an empty
account — which looks exactly like the data-boundary bug this ADR exists to
prevent.

Per-principal isolation is deliberate and correct, so the answer is an explicit
flow, not a silent copy:

- a user-initiated **"Import guest workouts into this account"** action, with a
  preview of what will be copied and what conflicts;
- idempotent copy that **never overwrites a conflicting id** — the existing
  import semantics already distinguish an identical duplicate from a conflict
  (`packages/fit-trace-store/src/sqlite.ts:148`) and should be reused;
- guest originals are preserved, not moved;
- the operation lives in the daemon, because that is where both databases are.

**Consent is whole-account, and it is this same moment.** The owner chose
account-level consent over per-record enrolment, so there is exactly one
deliberate prompt: the import dialog also asks the user to consent to uploading
this account's records to the chosen destination. Splitting that into two
sequential prompts would ask the same question twice and invite the user to
answer them inconsistently.

What the coarser granularity costs: a user cannot sync a subset of their
workouts. That is acceptable *here* because the product's unit of analysis is
history, not records — a coach reasoning about one session has nothing to
compare against, which is what `analyze_progress` and the trend logic exist to
provide. There is consequently no per-record enrolment affordance on desktop,
and none is planned.

Upload consent remains explicit and destination-bound: consenting to the
official server is not consenting to a user-entered one, and changing the
destination invalidates the consent.

Identity lifecycle also needs an answer: startup rewrites `identity.json` to
guest (`daemonServer.ts:622`), and account store selection alone does not update
the MCP and pi followers that read that file.

## Consequences

**Positive.** One sync engine, one conflict semantic, no per-platform fork. The
security properties stay where they were enforced — inside the write. Cloud
coaching becomes meaningful rather than silently empty.

**Negative / open work.** The extraction touches the mobile callers, which is
the part with real users today. The daemon gains a SQLite repository adapter
that did not exist. SSE remains non-streaming until the hosted side changes.
A custom destination's identity provider still needs its own answer — the
official default is the only one whose auth bootstrap is defined here.

## Decisions taken after review (2026-11-09)

Four questions were open when this ADR was first reviewed. The product owner
resolved them on 2026-11-09; recorded here so a later reader can tell which parts
were reviewed by the two models and which were decided by the owner.

### 1. Sync granularity: whole-account consent

Not per-record enrolment. Rationale and consequences are in §5 — the guest
import dialog is the single consent moment, and the coarser granularity is
acceptable because the product analyses history rather than single sessions.

### 2. Guest state in the settings page: a placeholder, not a blank

The Local CLI section renders normally for a guest — probing local CLIs needs no
account, and hiding a working feature would be wrong. The **Cloud** section
renders as a placeholder stating that signing in enables cloud coaching.

A blank space was the alternative. A placeholder is chosen because absence is
ambiguous: a user cannot tell whether cloud coaching is unavailable, broken, or
merely hidden, and the cheapest assumption to reach is "broken". One sentence
removes that ambiguity.

### 3. SSE and the proxy: sequence, do not guess

Change the hosted side first; decide the proxy afterwards. Reasoning in §1: with
paged long-polling on the hosted side, a passthrough proxy changes nothing the
user can observe. Live streaming is a hosted-side property, and the proxy only
owes real work once that property exists.

### 4. Unattended sync: out of scope, its own issue

`#69` ships **foreground sync only**: the user triggers it, the renderer supplies
a current token, the daemon holds it in memory for the run and pauses on expiry
(§2a). No credential is persisted.

The options if it were attempted now, and why each is a decision rather than a
chore:

| Storage | Cost |
| --- | --- |
| OS keychain (macOS Keychain / Windows Credential Manager / libsecret) | three separate implementations; Linux frequently lacks libsecret |
| encrypted file + user-derived key | a passphrase on every start |
| `0600` plaintext file | token on disk — comparable to a browser cookie |
| none | foreground only (chosen) |

Whole-account consent already makes sync a deliberate, user-initiated action, so
foreground is sufficient for this issue. Unattended sync is a separate product
feature ("sync automatically"), and it must solve credential storage in the same
change that introduces it. Folding it in here would spread one security decision
across two features, which is how it gets made twice and inconsistently.

## Review history

Reviewed by two independent models before implementation, both of which changed
this document:

- The first review corrected the extraction boundary: a "pure logic only" split
  is not real because `syncCoordinator.ts` imports the SQLite repository and the
  Expo session store, and it argued the runner belongs in the daemon because
  mobile enforces lease and consent inside the SQL write.
- The second review found that discovery-level disabling is not authorization,
  that the daemon has no credential lifecycle, that its schema cannot support
  the sync tables, and that guest-to-account migration is an unstated product
  gap. All four were verified against the code and are now recorded above.
- The product owner then resolved the four open questions (2026-11-09):
  whole-account consent, a placeholder for the guest cloud section, hosted-side
  SSE before any proxy streaming work, and unattended sync deferred to its own
  issue. Those are decisions, not review findings.

### Desktop public auth bootstrap

A packaged desktop release carries a generated, versioned public configuration:
channel, public Supabase URL, and publishable key. Release inputs are explicit;
no environment snapshot or provider credential is packaged. A guest-only channel
has no auth pair. Runtime environment overrides replace the whole URL/key pair or
fail; the legacy anonymous-key alias never fills a partial pair. The shell saves
its loopback origin in per-user Electron data and fails when its port is occupied,
so renderer session storage has a stable origin. Account and guest databases
remain separate; sign-in performs no guest import or sync. MCP/pi active-store
selection is not changed by desktop sign-in. Live login, restoration after a
restart, and sign-out were checked in a macOS arm64 package; live token refresh
and two-account switching remain unverified.
