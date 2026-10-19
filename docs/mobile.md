# Mobile app (React Native)

The Android-first React Native client lives in [`mobile/`](../mobile/) as
workspace package `@pi-fit-trace/mobile`. It reuses `@pi-fit-trace/core` for
deterministic domain logic and `@pi-fit-trace/api-contracts` for record and
transport shapes, so it does not fork validation, workout IDs, analysis or plan
rules. This is a status and plan record, not a second product contract: workout
semantics, transport, coaching and visual rules stay governed by
[`docs/mvp-design.md`](mvp-design.md), [`docs/api-contract.md`](api-contract.md),
[`docs/ui-design.md`](ui-design.md) and [`docs/deployment.md`](deployment.md).

## Status at PR1

PR1 is the foundation slice: Expo scaffold, shared design tokens, the six-tab
Pixel/Glass shell and the shared English/Chinese display layer. Persistence,
authentication, sync and mobile coaching are later PRs.
**Implemented** means present in the tree; **planned** means designed but not
written.

| Area | Implemented now | Planned |
| --- | --- | --- |
| App | Expo SDK 58, React Native 0.88, Expo Router, TypeScript strict | Data-backed screen content |
| Shell | Root stack, six-tab dock, shared UI primitives | Behavior beyond placeholders |
| Tokens | `@pi-fit-trace/ui-tokens`, Pixel/Glass palettes and layout tokens | Font loading and full Glass polish |
| Data/auth | SQLite dependency; auth placeholder route | Store/migrations; SecureStore sign-in, account preferences, workout sync |
| Coach/language | Placeholder Coach tab; working English/Simplified Chinese switcher with system-language default | Cloud pi screen |

## Architecture and boundaries

The client is local-first: the on-device database is the source of truth on that
device; the network is optional and adds accounts, sync and cloud coaching. A
guest can use the app without an account or connection.
Core owns domain logic, `api-contracts` record and transport shapes, and
`ui-tokens` visual values; `@pi-fit-trace/i18n` owns the render-time dictionary.
Presentation lives in `mobile/src/app` and `mobile/src/ui`; `mobile/src/i18n`
provides the AsyncStorage/system-language adapter, while `mobile/src/data`
(SQLite) and `mobile/src/auth` (identity) are planned. The app embeds no Node runtime, CLI
launcher or pi process and never receives a service-role key; privileged work
stays on the server and worker in [`docs/deployment.md`](deployment.md).

### Repository layout

| Path | State | Role |
| --- | --- | --- |
| `mobile/src/app/` | Implemented | Routes: root stack, six tabs, auth placeholder |
| `mobile/src/theme/` | Implemented | Shared tokens; AsyncStorage-backed skin state |
| `mobile/src/ui/` | Implemented | Button, Card, Chip, Field, Banner, EmptyState, Screen, text |
| `mobile/src/data/` | Planned | SQLite connection, workout store, import/export |
| `mobile/src/auth/` | Planned | Session state, SecureStore, account preferences |
| `mobile/src/i18n/` | Implemented | Language store and provider over the shared dictionary |
| `packages/fit-trace-ui-tokens/` | Implemented | Shared token contract for web and native |
| `packages/fit-trace-i18n/` | Implemented | Shared render-time dictionary and domain helpers |

The root layout wraps the router in `SafeAreaProvider`, `SkinProvider` and
`I18nProvider` and paints the shell. `index.tsx` redirects to a six-tab shell; all tabs are
placeholders except Me, which hosts skin, language and sign-in controls.

## Data model and sync plan

### Local store

`expo-sqlite` will hold workouts on the device. Reads and writes go through the
local store first, so logging, history and analysis stay usable offline. Core
validation runs before persistence, and records are canonical JSON with the same
field names and values as the API and export shapes:

```json
{ "id": "wkt_2026-09-13_strength_1a2b3c4d", "schema_version": 1, "date": "2026-09-13",
  "session_type": "strength", "duration_minutes": 60, "exercises": [{ "name": "bench_press", "sets": [{ "weight": 80, "reps": 5, "rpe": 8 }] }] }
```

The shape is defined in
[`packages/fit-trace-core/src/types.ts`](../packages/fit-trace-core/src/types.ts).
Exercise names, notes, dates and source strings stay canonical English; interface
language never changes a stored record.

Workout IDs are content-derived through
[`deriveWorkoutId`](../packages/fit-trace-api-contracts/src/deriveWorkoutId.ts):
the hash covers canonical content and excludes store-assigned `id` and
`schema_version`, so identical content produces the same ID and is a no-op.

### Sync after sign-in

Cloud sync is optional, follows explicit sign-in and never uploads on its own.
The first slice is **workouts**; artifacts, adoption and coaching follow.

Creates are idempotent by ID. The server returns a new record for an unseen ID,
a duplicate as a no-op, and a conflict when the same ID exists with different
content (see [`docs/api-contract.md`](api-contract.md)). The conflict is reported
to the user, who may keep the cloud copy, keep the local copy out of sync, or
export the local record; no path overwrites either side. A failed or postponed
sync does not block local use and never rewrites records before conflict resolution.

## Authentication and preferences

A mobile guest is an unauthenticated local user. Unlike the web guest flow, the
app creates no Supabase anonymous account and there is no hidden identity to
upgrade later. Guest workouts stay local until the user signs in and opts in.

Sign-in behavior is planned under `mobile/src/auth/` and uses the existing
Supabase-backed account system and bearer-token API. The current
`app/auth/sign-in` route is a placeholder with no input or network. Session tokens
will be stored with `expo-secure-store`, never in AsyncStorage, which is not a
secret store. After the first sign-in the user chooses a skin (Pixel or Glass) and
an interface language; both are written to the account so they follow the user
across devices, and the Me screen can change them later. They are display settings
that never enter a workout record, snapshot, export or content digest. Account-level
preference storage does not exist yet; the mobile skin is device-local in
AsyncStorage, and the web keeps both choices in browser storage.

### Interface language

English is canonical data; Simplified Chinese is a render-time display layer,
following [`docs/ui-design.md`](ui-design.md). Chrome, labels, validation
messages and safety copy are translated while rendering. Workout content, saved
payloads, generated plan strings and exported JSON are not; a content digest
never depends on who is reading it.

The shared `@pi-fit-trace/i18n` package holds the pure dictionary and domain
display helpers; the web keeps its localStorage/DOM adapter in
[`app/src/i18n/`](../app/src/i18n/), and mobile keeps an AsyncStorage adapter in
`mobile/src/i18n/`. The boundary is one dictionary shared by web and mobile,
translated at render time and falling back to English for unknown keys. Mobile
starts in the device language (Chinese locale selects Chinese, otherwise English)
and remembers an explicit choice under the shared `pi-fit-trace:lang:v1` key; the
Me screen switches it. A dictionary integrity test checks every slice, including
the mobile-only shell copy.

### Coach

The mobile coach will use the hosted cloud pi path, the same one available on
the web, subject to the account, quota and operator configuration in
[`docs/deployment.md`](deployment.md). The local CLI coach remains a PC/desktop
feature: mobile does not spawn pi, run a local model or hold provider keys. The
Coach tab is a placeholder and makes no network calls.

## Navigation and design system

Screens live as Expo Router files under `mobile/src/app/`, with reusable
components under `mobile/src/ui/`. Six bottom tabs use a token-driven dock with a
blurred Glass variant, following [`docs/ui-design.md`](ui-design.md); Me holds
skin, language and sign-in controls.

`@pi-fit-trace/ui-tokens` is the token contract. `src/palette.ts` mirrors web
oklch custom properties as sRGB values because React Native color props are not
CSS custom properties; it is generated from the web CSS and must be updated with
it. `src/index.ts` owns hand-written structural tokens: spacing, radii, border
widths, shadows and the type ramp, in dp rather than CSS units.

One token set serves both skins. Pixel uses 3dp rules, square corners and hard
offset shadows; Glass uses hairlines, 8dp cards, blurred chrome and soft
elevation. Shared components cover Button, Card, Chip, Field, Banner, EmptyState
and text. `SkinProvider` defaults to Pixel and persists the choice in
AsyncStorage; account-level sync of that choice is still planned. No font assets
are bundled, so the Bricolage/DM Sans names fall back to platform fonts. The web
touch-first rules apply: 44dp targets, visible labels and no colour-only state.

## Local development

Requires Node >= 24 and the pnpm version pinned by the root `package.json`.
Install once from the repository root with `pnpm install`.

| Command | Purpose |
| --- | --- |
| `pnpm mobile:start` | Start the Expo dev server through the workspace script |
| `cd mobile && npx expo start` | Same dev server when working inside `mobile/` |
| `pnpm mobile:typecheck` | Run `tsc --noEmit` with the mobile strict config |
| `pnpm mobile:export:android` | Export the Android JS bundle and assets, not an APK |

Open the dev server in an Android emulator or on a device running the
development build. Generated `android/` and `ios/` directories are ignored; the
project uses the Expo managed workflow and does not commit native folders.
`pnpm mobile:export:android` runs `expo export --platform android` into ignored
`dist/`, so it is a bundle/asset check rather than a native build.

The root `pnpm typecheck` covers the root project and web app, not the mobile
workspace, so run `pnpm mobile:typecheck` explicitly. CI runs `pnpm test` and
`pnpm typecheck`; native builds and EAS are not part of PR CI.

## Android build and release

[`mobile/eas.json`](../mobile/eas.json) defines `development` (internal APK,
development client), `preview` (internal APK for device testing) and `production`
(AAB, remote auto-increment, release candidate). `appVersionSource` is `remote`;
the Android package is `com.pifittrace.app` in [`mobile/app.json`](../mobile/app.json).

Build from `mobile/` with a linked EAS project:

```sh
npx eas build -p android --profile preview
npx eas build -p android --profile production
```

Native builds are manual and only for fixed versions, not every commit. Checks
stay light (typecheck, tests, `expo export`); build time is not spent on artifacts
with no native change. `app.json` links no EAS project ID, so linking is a
prerequisite.

Android is the only supported target in PR1. iOS is deferred until before the
public store release; there is no iOS build configuration or verification yet.

## Security and privacy

- **Session tokens** will go to SecureStore. They never go to AsyncStorage,
  workout records or exported JSON.
- **No privileged keys in the app.** The client may use the public Supabase URL
  and publishable key. Service-role and provider keys stay server- or worker-only,
  consistent with [`docs/deployment.md`](deployment.md).
- **SQLite is plaintext for now.** The planned database lives inside the Android
  app sandbox without application-level encryption: a deliberate PR1 tradeoff that
  avoids key management before authentication and keeps migrations simple. It
  relies on the OS sandbox and device lock, so a rooted device, an included backup
  or an export can expose data. Encryption is deferred and should be revisited
  before sync or additional health fields land.
- **Guest data stays local** until the user signs in and opts into sync. Cloud
  sync sends records the user chose to store, not an automatic device backup.
- **Health-adjacent product.** Training tracking and safety signals are not
  medical advice or diagnosis, and copy makes no treatment claims.

## Verification status and known gaps

The current tree passes `pnpm mobile:typecheck`; it is not part of root CI. No
runtime, device or EAS build verification is claimed.

- **No real data layer.** SQLite is declared but there is no schema, store,
  migration, import/export path or mobile persistence test.
- **No auth, sync or coach functionality.** The sign-in and Coach routes are
  placeholders with no input or network; SecureStore is unused, AsyncStorage holds
  only the device-local skin and language choice, and account preferences and
  conflict handling are design only.
- **No fonts and no iOS.** Native typography falls back to system fonts; there
  is no iPhone build or test target.
- **Device verification pending.** A headless Android emulator is available in
  the development environment, but memory constraints have prevented a full
  interactive smoke test. Screenshots are still to be added; this document
  intentionally contains none.
- **No mobile test runner or CI coverage.** PR1 has a typecheck script but no
  test script, and root `pnpm typecheck` does not include the mobile workspace.
- **Token drift is manual.** The sRGB palette has no automated check against the
  web oklch tokens; a CSS color change must update both sides.
- **EAS project not linked.** Profiles exist, but builds require project setup
  and an authenticated EAS account.

## Next steps

This is the intended sequencing, not a commitment to a release date:

1. Verify the shell on an Android device or a less constrained emulator, add
   screenshots, and add the mobile typecheck to CI.
2. Implement the SQLite workout store with validation before write and
   import/export parity, tested apart from the UI.
3. Add authentication, account preferences and optional workout sync with
   content-ID idempotency and the three conflict choices; do not extend sync
   before workouts are verified.
4. Add the cloud coach screen and bundled fonts, then build and verify iOS
   before the public store release.
