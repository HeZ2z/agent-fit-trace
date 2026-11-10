# Release artifacts (GitHub Actions + EAS)

This document owns how release artifacts are built. It replaces the previous
policy recorded in [`docs/mobile.md`](mobile.md) ("EAS builds are manual and only
for fixed versions, not every commit", "EAS only builds on demand, not from CI"):
Android and desktop artifacts are now produced by
[`.github/workflows/release.yml`](../.github/workflows/release.yml), and the
version numbers they carry are guarded in CI.

Deployment of the web app is a separate concern and does not go through this
workflow — see [`docs/deployment.md`](deployment.md) and the short note at the
end of this file.

## Trigger model

| Trigger | What runs | Publishes a GitHub Release |
| --- | --- | --- |
| `push` on a tag `v*` | version guard → Android preview APK → desktop matrix (macOS, Windows, Linux) → collect | Yes, automatically |
| `workflow_dispatch`, `platform: all/desktop/android` | the selected jobs only | Only if the ref is a tag **and** `publish` is checked |
| Pull request | nothing here | Never |
| Branch push | nothing here | Never |

Two invariants make this safe:

- **Pull requests never build artifacts.** Every artifact job carries an `if:`
  guard that only passes for tag pushes and manual dispatches; the workflow
  itself has no `pull_request` trigger. PR-side checks stay in
  [`ci.yml`](../.github/workflows/ci.yml) (cheap: test, typecheck, catalog
  freshness, version lockstep).
- **`production` is never implicit.** A tag push always builds the `preview`
  APK. The AAB only comes from a manual dispatch that names
  `android_profile: production`, because the `production` EAS profile has
  `autoIncrement: true` with `appVersionSource: remote` — it moves the remote
  build number, which is not something a tag push should do on its author's
  behalf.

`concurrency: release-<ref>` with `cancel-in-progress: false` serialises runs per
ref: a re-run racing the original tag push queues behind it instead of
half-uploading a second set of assets. A stuck run must be cancelled by hand
rather than relying on the group to replace it.

### Version guard

`scripts/sync-versions.mjs` treats the root `package.json` `version` as the
single source of truth and every other manifest as a copy. The release workflow
runs it before anything expensive, and additionally asserts that the tag matches
that version — a `v0.2.0` tag on a `0.1.0` tree fails in seconds, not after a
45-minute packaging run.

```sh
# Verify (read-only; this is what CI and the release workflow run)
node scripts/sync-versions.mjs --check

# Stamp every copy from the root version (the fix when --check fails)
node scripts/sync-versions.mjs
```

Files covered: `app/package.json`, every `packages/*/package.json` that exists
(discovered from the filesystem, sorted), `mobile/package.json`, and
`mobile/app.json` → `expo.version`. Besides those, the editor discovers nothing:
adding a new versioned manifest means teaching the script about it.

The write mode is byte-surgical — it replaces the one version line and re-parses
the result to prove nothing else moved — so key order, indentation and any
hand comments survive. `--check` names every drifted file with its current and
expected value and exits 1.

A release therefore starts with a normal version bump on the branch:

```sh
# edit "version" in the root package.json, then
node scripts/sync-versions.mjs          # stamp the copies
node scripts/sync-versions.mjs --check  # must pass
git commit -am "release: v0.2.0"
git tag v0.2.0 && git push origin v0.2.0
```

`pnpm version --no-git-tag-version` also works for the root bump if you prefer;
the two-file mobile case still needs the sync script.

The guard job needs no dependencies at all: the script imports only `node:*`
modules, so it does not run `pnpm install` and has no pnpm cache to warm.

## Secrets

Repository secrets, set under *Settings → Secrets and variables → Actions*.
Nothing here is committed, and nothing is read from `.env`.

| Secret | Needed by | This round | What it does |
| --- | --- | --- | --- |
| `EXPO_TOKEN` | `android` job | **Yes, for Android** | Expo access token (expo.dev → *Access tokens*) used by `expo/expo-github-action` to run `eas build`. Without it the Android job is skipped on tag pushes and fails on an explicit Android dispatch (see below). |
| `GITHUB_TOKEN` | `release` job | Automatic | Provided by Actions, `contents: write` scoped to the publish job only. |
| `CSC_LINK` | macOS signing | Phase C | Developer ID `.p12`, base64 or URL. Not used yet — builds are unsigned. |
| `CSC_KEY_PASSWORD` | macOS signing | Phase C | Password for `CSC_LINK`. |
| `APPLE_ID` | macOS notarisation | Phase C | Apple account for `notarytool`. |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS notarisation | Phase C | App-specific password for that account. |
| `APPLE_TEAM_ID` | macOS notarisation | Phase C | Team identifier for notarisation. |

Windows code signing (`WIN_CSC_LINK` / `CSC_LINK` plus `CSC_KEY_PASSWORD`) is
part of the same phase-C checklist; adding it is what turns SmartScreen warnings
into a clean install prompt.

### Missing `EXPO_TOKEN` behavior

The choice, made explicit because a tag is a one-shot event:

- **Explicit Android request (manual dispatch with `platform: android|all`)** —
  the job **fails** with a message naming the missing secret. Asking for Android
  and getting a green run with no APK would be worse than a red run.
- **Tag push** — the job emits a warning annotation and skips, and the workflow
  still publishes the desktop artifacts. A tag should not be un-releasable
  because one optional secret has not been provisioned yet; re-running the
  workflow after adding the secret attaches the APK (the release step updates
  the existing release and keeps prior assets).

## Artifact matrix

| Platform | Job | Runner | Profile / command | Output | Signed |
| --- | --- | --- | --- | --- | --- |
| Android | `android` | `ubuntu-latest` | `eas build -p android --profile preview --wait` | `fit-trace-android-preview-<ref>.apk` (internal distribution) | Expo-managed keystore |
| Android | `android` | `ubuntu-latest` | `--profile production` (manual dispatch only) | `fit-trace-android-production-<ref>.aab` | Expo-managed keystore |
| macOS | `desktop` | `macos-latest` | `pnpm build` → `desktop:build` → `desktop:package` | `fit-trace-<version>-<arch>.dmg`, `fit-trace-<version>-<arch>-mac.zip` | **Unsigned** |
| Windows | `desktop` | `windows-latest` | same | `fit-trace Setup <version>.exe` (NSIS), `fit-trace <version>.exe` (portable) | **Unsigned** |
| Linux | `desktop` | `ubuntu-latest` | same | `fit-trace-<version>.AppImage` | **Unsigned** |

Android is the only mobile platform built. iOS is a deliberate deferral and has
no row here — see [Deferred: iOS](#deferred-ios).

Artifact names and the state of each pipeline:

| Item | Value |
| --- | --- |
| Workflow artifact retention | 14 days |
| GitHub Release assets | whatever the three jobs produced, attached with `softprops/action-gh-release@v2` |
| Auto-update metadata (`latest*.yml`, `*.blockmap`) | **not attached** by the workflow even if electron-builder emits it; there is no auto-updater yet |
| Store submission | `mobile/eas.json` has a `submit.production` → Android `internal` track, but nothing submits automatically |
| `<ref>` in artifact names | `github.ref_name` with `/` and spaces replaced by `_`, so a branch dispatch cannot create nested paths |

The desktop jobs run, in this order:

1. `pnpm install --frozen-lockfile`
2. `pnpm --filter @agent-fit-trace/desktop exec node node_modules/electron/install.js`
   — pnpm 10 skips unapproved postinstall scripts, so the Electron binary is
   fetched explicitly (the same gap `packages/fit-trace-desktop/scripts/dev.cjs`
   closes locally). `install.js` is idempotent.
3. `pnpm build` — the built App shell in `app/dist`.
4. `pnpm desktop:build` — chains the package's `build:daemon` (esbuild →
   `staging/daemon.mjs`), `prepare:runtime` (assertions only, see below) and
   `build:runtime` (stages the daemon and the App shell copy).
5. `pnpm desktop:package` — electron-builder into
   `packages/fit-trace-desktop/release/`.

Step 3 must precede step 4: staging copies `app/dist` and `prepare:runtime`
*asserts* it exists rather than triggering a Vite build, so that packaging never
silently becomes a full web build.

There is **no downloaded Node runtime**. The daemon bundle runs on the desktop
app's own Electron binary with `ELECTRON_RUN_AS_NODE=1` (`process.execPath`),
which was verified to load `node:sqlite` (`DatabaseSync`, WAL) and boot the
daemon. That removes a ~50 MB per-OS download from this workflow and is why
`prepare:runtime` is an assertion step, not a fetch.

`CSC_IDENTITY_AUTO_DISCOVERY=false` is redundant with the packaging config
(`mac.identity: null`, no notarize hooks) but states the intent and guards
against accidental signing on a runner that carries an identity.

### Why the Android job waits

`eas build` is invoked with `--wait --json` and the finished artifact is
downloaded and uploaded as a workflow artifact, so the GitHub Release can carry
the APK. The alternative — `--non-interactive --no-wait`, returning as soon as
the build is queued — would finish the job in seconds but leave the release
without the file, and would need a second trigger (webhook or polling job) to
collect it later. The costs of waiting are real and accepted: the job's wall time
includes the EAS queue (hence `timeout-minutes: 90`), and a CI rerun re-builds
rather than re-downloading. If Android builds ever exceed ~90 minutes, raise the
timeout; do not silently switch to `--no-wait` without adding the collection step.

## Dry runs

You can exercise everything that does not need Expo credentials without pushing
a tag:

| Goal | How |
| --- | --- |
| Check versions before tagging | `node scripts/sync-versions.mjs --check` locally, or push the branch (CI runs it on every push/PR) |
| Validate workflow YAML | `node -e "require('./node_modules/.pnpm/yaml@2.9.0/node_modules/yaml').parse(require('node:fs').readFileSync('.github/workflows/release.yml','utf8'))"`, or `actionlint` if installed |
| Build artifacts without publishing | *Actions → Release → Run workflow*, branch = your branch, `platform: all`, `publish` unchecked. Artifacts land on the run page. |
| Build only desktop | same, `platform: desktop` |
| Exercise the publish path | the only safe way is a throwaway pre-release tag on a commit you do not care about; the release step always targets `github.ref_name` |
| Desktop chain locally | `pnpm install && pnpm --filter @agent-fit-trace/desktop exec node node_modules/electron/install.js && pnpm build && pnpm desktop:build && pnpm desktop:package` (same order as the job) |

A manual dispatch cannot publish a Release unless the ref is a tag: a GitHub
Release belongs to a tag, so a dispatch on a branch produces artifacts only, and
the `release` job logs that it published nothing.

## Promoting a preview to production

1. Confirm the preview APK from the tag is the one you tested (compare the
   artifact on the GitHub Release / the run that produced it).
2. Bump the version if the tagged commit did not already do it:
   `node scripts/sync-versions.mjs` after editing the root `package.json`, then
   commit.
3. Run *Actions → Release → Run workflow* on that commit's branch with
   `platform: android`, `android_profile: production`. The `production` EAS
   profile builds an AAB and increments the remote version code
   (`autoIncrement`, `appVersionSource: remote`).
4. Download the AAB from the run and upload it to the Play Console *internal*
   track by hand. `eas submit` is **not** wired into this workflow: the
   `submit.production` profile points at the internal track, and store uploads
   stay an explicit human step until the first real release.
5. Tag only when the production build is what you intend to ship. Order matters:
   the tag push builds `preview`, so promoting from a tag is a re-dispatch, not
   a second tag.

## Known gaps

| Gap | Consequence | Owner / phase |
| --- | --- | --- |
| Desktop builds are unsigned | macOS Gatekeeper: right-click → *Open*, or `xattr -dr com.apple.quarantine <app>`; Windows SmartScreen: *More info → Run anyway*. End users see a scary prompt. | Phase C (signing secrets above) |
| No auto-update | Users re-download each build. The upload globs skip `latest*.yml`/`*.blockmap`, so no update feed exists. | Later; needs a feed and signed builds first |
| iOS absent | No iOS build configuration exists at all (`docs/mobile.md`: "Android is the only supported target"). Deliberate deferral, see below. | After the first Android store release |
| No Android store submission | The AAB is uploaded by hand. `submit.production` exists but nothing calls `eas submit`. | Manual until first release |
| EAS builds are not reproducible byte-for-byte | Expo's cloud builder owns the toolchain; the repo pins the profile, not the image. | Accepted |
| Desktop packaging chain is new | The root scripts `desktop:build` / `desktop:package` are the integration contract (they chain the package-level `build:daemon`, `prepare:runtime`, `build:runtime`, `package`). If they are renamed, the workflow fails at that step and nothing else notices. | Desktop packaging owner |
| Electron binary is downloaded per job | ~100 MB per matrix entry, not cached. Acceptable for three runners on a tag; add a cache keyed on the electron version if tags get frequent. | Later |
| `electron-builder` must be in the lockfile | Step 1 is `--frozen-lockfile`. If the desktop package's `devDependencies` change without a lockfile update, CI fails at install with "electron-builder: not found" — that is a stale-lockfile signal, not a workflow bug. | Desktop packaging owner |
| No hosted-runner verification yet | The desktop jobs have never run on this repository's Actions; the individual commands were validated locally (macOS only, see the verification notes in the PR), not on macOS/Windows/Linux runners. Treat the first tag as the real test. | First tag |
| Version guard covers manifests only | It does not compare against `pnpm-lock.yaml`, git tags already published, or the EAS remote version code. | Accepted |

### Deferred: iOS

iOS is out of scope for this round by decision, not by omission. There is
nothing to run: `mobile/app.json` has no `ios` block, `mobile/eas.json` has no
iOS profile or credentials, and no iOS build has ever been made or verified on a
device. Making it real needs, in order:

1. macOS runner minutes (EAS covers this, at the cloud-build price) — no iOS
   build happens on `ubuntu-latest`;
2. an Apple Developer Program account (paid) and an App ID for a bundle
   identifier that does not exist yet;
3. distribution certificate + provisioning profile (or EAS-managed credentials)
   plus an `ios` section in `mobile/app.json` and an iOS profile in
   `mobile/eas.json`;
4. a device/testflight verification pass — currently there is no iOS device
   coverage at all.

Until then there is no iOS job, no iOS profile and no iOS secret in this
repository.

## How this relates to Vercel deploys

The web app does **not** ship through this workflow. Vercel's Git integration
builds and deploys `app/` on push, per [`docs/deployment.md`](deployment.md); the
release workflow only produces the mobile and desktop artifacts. Two consequences
worth knowing:

- A tag push triggers **both** a Vercel production deployment and this workflow.
  They are independent — the GitHub Release contains no web bundle, and a Vercel
  rollback does not change any attached artifact.
- The version guard is the only thing tying them together: the same root
  `package.json` version drives the release tag and the desktop/mobile
  artifacts, while Vercel does not stamp a version at all.

### Desktop public authentication configuration

Desktop packaging requires `FIT_TRACE_DESKTOP_CHANNEL` to be `release` or
`guest-only`. Release builds also require the explicit public variables
`FIT_TRACE_DESKTOP_SUPABASE_URL` and
`FIT_TRACE_DESKTOP_SUPABASE_PUBLISHABLE_KEY`. The release workflow reads these
from GitHub Actions repository variables. It fails if either value is absent or
invalid. Only the public URL and `sb_publishable_` key belong there: never use a
service-role key, token, provider credential, or `.env` file. For a deliberately
local-only build set `FIT_TRACE_DESKTOP_CHANNEL=guest-only` and leave both public
values unset. The generated `desktop-public-config.json` contains exactly
`schemaVersion`, `channel`, `supabaseUrl`, and `supabasePublishableKey`; guest-only
uses empty strings for the two auth fields. Each build replaces any prior file.

At packaged startup `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` may override
this file only as a complete pair. A partial pair fails startup and the legacy
`SUPABASE_ANON_KEY` cannot fill or change it. Direct `agent-fit-trace daemon`
retains its existing environment configuration.

Verification in this change included an unsigned macOS arm64 guest-only
package, launched twice with temporary HOME, data, and Electron userData
directories; both launches served guest-local public configuration at the same
origin. A release-configured unsigned macOS arm64 package was also checked
against the intended Supabase project: an existing account signed in, remained
signed in after quitting and reopening at the same origin, and returned to the
local guest after sign-out. Live token refresh and switching between two accounts
were not exercised; Windows and Linux packaged launches also remain untested.
