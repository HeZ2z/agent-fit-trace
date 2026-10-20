# ADR 0003: Exercise catalog as a suggestion layer, backed by Unlicense data

- **Status:** Accepted. The v1 implementation is on the `feat/exercise-catalog`
  feature branch and awaits review and merge: the versioned 194-entry catalog
  and alias resolver/search (shared core), render-time Chinese display names,
  Chinese localization of catalog exercise names inside rebuilt copy,
  alias-normalized analysis trends, and web/mobile exercise-name autocomplete
  plus display.
  The frozen 194-entry scope, its IDs, and the 66 canonical-name decisions are
  implemented as-is; no storage, record-schema, or API change is part of it.
  v1 carries no cue or common-mistake content and ships no logging helpers
  beyond name autocomplete (no recent-exercise or equipment/muscle candidate
  lists) and no planning helpers; those are future work (§7). Content review
  remains open: the 49 `content_status: "rewrite"` entries, the
  muscle/equipment review, and any cue authoring are not done, so the catalog
  is not yet authoritative. Upstream commits are pinned and provenance is
  recorded in the committed data and in
  [`NOTICE`](../../data/exercise-catalog/NOTICE).
- **Date:** 2026-10-20
- **Scope:** the v1 exercise catalog and its integration as a suggestion layer.
  Media, workout-record schema changes, non-strength expansion, and
  professional content authoring beyond seed quality are out of scope.
- **Related:** [`../mvp-design.md`](../mvp-design.md),
  [`../api-contract.md`](../api-contract.md), [`../../AGENTS.md`](../../AGENTS.md),
  and the non-normative 194-row working draft
  [`../exercise-catalog-mapping-v0.md`](../exercise-catalog-mapping-v0.md).
  External data sources are cited under Evidence.

## Context

### Current product facts

- A workout exercise is a name plus sets: `Exercise { name, sets }`
  (`packages/fit-trace-core/src/types.ts`). There is no catalog id, no equipment
  field, and no exercise metadata in a stored record.
- Analysis groups trends by the exact `exercise.name` string
  (`packages/fit-trace-core/src/metrics.ts`). The analysis filter lowercases
  names, but trend grouping and labels do not normalize aliases. `bench_press`,
  `Bench Press`, and a user-typed Chinese name therefore become separate trends.
- `PlanConstraints.equipment` exists, but `generateNextPlan` only emits a text
  recommendation; it does not filter or select exercises
  (`packages/fit-trace-core/src/plan.ts`).
- Stored records are immutable and idempotent by content-derived workout id.
  `schema_version` is 1, newer versions are rejected, and the Supabase tables are
  append-only (see `docs/api-contract.md` §6 and
  `supabase/migrations/20261010000000_workouts.sql`). Historical records cannot
  be backfilled.
- Canonical catalog/domain data is English, while a workout record keeps the
  exercise name exactly as authored (canonical English, alias, custom text, or
  Chinese). The render-time i18n layer originally did not translate workout
  content such as exercise names
  (`packages/fit-trace-i18n/README.md`); the v1 implementation amends that for
  catalog-backed display only (§5).
- The mobile sync client validates pulled records with the shared core and drops
  malformed entries rather than failing the whole list
  (`mobile/src/sync/syncClient.ts`).

### What the source survey found

- Only Unlicense/MIT exercise metadata is safe to embed in this repository. The
  usable sources are:
  - [`yuhonas/free-exercise-db`](https://github.com/yuhonas/free-exercise-db)
    (Unlicense): 876 exercises with English names, muscles, equipment, level,
    mechanics, force, and instructions. Its images have no reliable provenance
    and MUST NOT be used.
  - [`gengyueworks/gym-exercise-guide`](https://github.com/gengyueworks/gym-exercise-guide)
    (Unlicense, commit `ed41bb3a`): a Chinese localization of free-exercise-db
    with 873 exercise pages, 100% English-name join, Chinese names, muscle
    labels, difficulty, equipment, cues, and common mistakes.
- Other candidates are not embeddable under this repository's constraints:
  wger data is a per-entry mix of CC-BY-SA/CC0; Everkinetic and
  `bryllim/workout-guide` artwork is CC-BY-SA; hasaneyldrm/LogPress text is MIT
  but its media is © Gym visual and the retained-media fork has an unresolved
  provenance dispute; ExerciseDB, ExRx, and MuscleWiki are proprietary and
  prohibit caching or model training; the 训记 (Xunji) Chinese name list has no
  license; FitKG-CN (CC-BY-4.0) and Wikidata (CC0) are useful as terminology
  cross-checks only.
- The selected source's cues and common mistakes are template-based: 735 of 873
  pages share a cue block with another page, all 873 pages share one of 35
  mistake blocks, and the "plyometric" block is wrongly applied to entries such
  as Box Squat, Mountain Climbers, Overhead Slam, and Medicine Ball Chest Pass.
  Seed content is therefore input to authoring, not final content. v1 embeds no
  cue or common-mistake text at all; it commits only a per-entry
  `content_status` review flag (§2).

### Product decision

The catalog is a **suggestion layer**. v1 assists exercise-name logging and
improves analysis normalization. It is designed to support additional logging
helpers (recent exercises, equipment/muscle candidates) and deterministic plan
candidate/substitution suggestions later, but those helpers are not part of v1
(§7). The catalog does not gate data entry, rewrite stored records, or make the
LLM an authority on exercise facts.

## Decision

### 1. Suggestion-layer boundary

v1 uses the catalog in two shipped places:

1. **Logging:** exercise-name autocomplete in the web Log editor and the mobile
   Log field, backed by the shared catalog search. A user can ignore every
   suggestion and type a custom name.
2. **Analysis:** resolve a recorded name to one catalog entry when the match is
   unambiguous; group/filter/label by that entry. An unmatched or ambiguous name
   stays raw.

Render-time Chinese display names are also shipped (§5). The following are
planned but **not in v1**: recent-exercise lists, equipment/muscle candidate
lists, and deterministic plan candidate/substitution suggestions based on
movement pattern, equipment, muscles, and pain constraints (Phase 1, §7).

The catalog never does the following:

- no validation error for an unknown exercise name;
- no forced catalog selection;
- no rewriting or backfilling of historical records;
- no LLM-authored exercise facts. v1 carries no cues, common mistakes, or
  substitutions; any later cue content is authored and reviewed outside the
  Agent/LLM, while the deterministic core owns lookup and suggestion rules.

### 2. v1 scope and taxonomy

- **194 entries:** 178 strength entries across 12 movement patterns, plus 8
  cardio seeds and 8 mobility seeds, to cover every `session_type`.
- **Patterns:** `squat`, `hinge`, `lunge`, `horizontal_push`, `vertical_push`,
  `horizontal_pull`, `vertical_pull`, `core`, `biceps`, `triceps`,
  `shoulders`, `legs`, plus `cardio` and `mobility` seed groups.
- **Fields:** stable `id`, canonical English `name`, append-only English
  `aliases`, `pattern` (the committed field name; not `movement_pattern`),
  `primary_muscles`, `secondary_muscles`, `equipment.category` +
  `equipment.items[]`, `difficulty`, `mechanics` (compound/isolation or `null`),
  `force` (push/pull/static or `null`), `content_status`, `name_status`, an
  optional `variant_of`, and per-entry source references. Chinese display names
  and Chinese aliases live in a separate generated i18n table keyed by canonical
  English name; they are not catalog-entry fields.
- **IDs:** ASCII snake_case, globally unique, never reused. Entries are
  deprecated, not deleted; aliases are append-only.
- **Names:** 66 seed names are renamed to canonical names; the seed name remains
  a Chinese alias. The two dip versions stay separate with a `variant_of`
  relation (`chest_dip` / `triceps_dip`).
- **Muscles:** the committed vocabulary in `MUSCLE_IDS` has 19 coarse labels;
  v1 entries reference 16 of them (`hip flexors`, `neck`, and `obliques` are not
  used). It is a starting taxonomy inherited from free-exercise-db, not a
  training-science review; compound lifts need coach review before the catalog
  is presented as authoritative.
- **Content:** v1 carries no cue, common-mistake, or substitution text. Each
  entry records only a `content_status`: 145 `template` (seed content is a
  draft) and 49 `rewrite` (the upstream seed content is known-misleading and
  must be rewritten before use). Cue/mistake authoring is future work
  (§7, §8).
- **No media:** images and videos are out of scope; no source with acceptable
  media licensing is available for this repository.

### 3. Data source and licence boundary

- v1 metadata is derived from the two Unlicense sources above. Only text and
  structured metadata were used as input; images and videos are never copied.
- The committed data is curated JSON (`data/exercise-catalog/catalog.v1.json`
  and `zh-names.v1.json`), not a wholesale vendored copy of the upstream
  repositories.
- No wger, Everkinetic, workout-guide, LogPress media, ExerciseDB, ExRx, or
  MuscleWiki data is embedded.
- Provenance matches the committed data: the catalog root `sources` array
  records each upstream `repo`, pinned `commit` (full 40-character SHA), and
  `license`; every entry records per-entry upstream references in
  `source.free_exercise_db` and `source.guide_page`. There are no per-entry
  `source_url` or `retrieved_at` fields; the pinned commit and catalog version
  are the provenance coordinates.
- A third-party notice is committed at
  [`data/exercise-catalog/NOTICE`](../../data/exercise-catalog/NOTICE) even
  though Unlicense requires no attribution.
- The repository currently has no root `LICENSE`; third-party data is therefore
  treated as an explicit product/legal decision, not an implicit one.

### 4. Workout records stay name-only

`Exercise` does not gain an `exercise_id` in v1, and `CURRENT_SCHEMA_VERSION`
does not change. The reasons are:

- v1 clients reject a newer `schema_version`, and the mobile sync client drops
  records it cannot validate;
- workout ids are content-derived, so adding a field changes ids for newly
  authored records and creates avoidable churn;
- stored records and Supabase tables are append-only and cannot be backfilled;
- deterministic alias resolution plus an append-only alias index is sufficient
  for this suggestion layer. If a real need for record-level catalog identity
  appears later, a schema v2 decision can be made separately.

Resolution is a pure function of the catalog version bundled with the build. An
ambiguous or unknown name is left raw; no data is guessed.

### 5. i18n boundary

Catalog data and catalog-backed suggestions are canonical English; a workout
record keeps the exercise name exactly as authored. This ADR amends the
render-time rule for catalog-backed exercise names:

- catalog-backed names are translated at render time through the catalog entry
  (canonical English name → display name in the selected language);
- the editor input and suggestion labels are display surfaces too: their visible
  text follows the selected language (for example `杠铃卧推` in Chinese UI), while
  selecting a suggestion writes the canonical English name and typed free text is
  stored exactly as authored;
- custom/free-text names pass through unchanged;
- notes, user-authored names, ids, and dates are never translated;
- stored records, snapshots, exports, and plan payloads preserve what the user
  selected or typed: canonical English after a catalog-backed selection,
  otherwise an alias, custom name, or Chinese text as authored. Localized
  display text is never written back as a rewrite of stored data;
- plan and analysis strings that embed an exercise name use the same display
  helper.

`packages/fit-trace-i18n/README.md` and the tests record this boundary; the
shared display and suggestion helpers are the only render-time exercise-name
surface.

### 6. Placement, determinism, and versioning

- v1 lives in `packages/fit-trace-core/src/exercises/`: browser-safe types,
  generated catalog data, pure lookup/alias resolution, and deterministic
  search/list helpers. It imports no pi, Node, or typebox APIs.
- The source of truth is the committed curated JSON in `data/exercise-catalog/`,
  with the two upstream source commits pinned in its root `sources`. A
  repository script validates the JSON and emits the generated TypeScript
  (catalog plus the i18n Chinese tables); no upstream snapshot is vendored. The
  generated files and digests are committed, and the work never fetches data at
  runtime.
- A `CATALOG_VERSION` value plus a content digest is asserted by tests. The
  catalog and its aliases are static, deterministic, and append-only; no clock
  or randomness participates.
- Data size is expected to stay small enough for the shared core. If content,
  translations, or media later exceed that budget, extraction to a dedicated
  workspace package is allowed without changing callers.
- Web, mobile, the pi extension, and the server share this core. v1 adds no
  server/API endpoint; the catalog is bundled with the clients. A server-side
  catalog endpoint is a later decision if content updates must bypass app
  releases.

### 7. Behaviour changes and rollout

- **Phase 0 (shipped in v1, this branch):** catalog data + resolver/search,
  alias-normalized analysis identity (group/filter/label), render-time Chinese
  display for catalog-backed names (including rebuilt analysis and plan copy),
  and exercise-name autocomplete/display in the web Log editor and the mobile
  Log field. No record schema, API, or database change; stored records keep the
  exercise name as authored. Analysis therefore groups aliases into one
  canonical trend; this is a deliberate, user-visible change and the affected
  tests and docs were updated.
- **Phase 1 (future, not in v1):** recent-exercise and equipment/muscle
  candidate lists; deterministic plan candidate/substitution suggestions using
  equipment, movement pattern, muscles, and pain constraints; exercise detail
  and per-exercise history; cue/common-mistake authoring and coaching review.
  `PlanConstraints.equipment` becomes executable only when that lands.
- **Phase 2 (conditional):** record-level `exercise_id` with schema v2, only if
  a real requirement appears. This needs a separate rollout decision covering
  old clients, mobile sync, and content-derived ids.
- **Rollback:** remove the catalog code/data and the display/suggestion helpers;
  stored records, ids, and wire contracts are unaffected. There is no migration
  to reverse.

### 8. Review gates for an authoritative catalog

These are conditions before the catalog is presented as authoritative. The
Phase 0 implementation has shipped, so each gate is satisfied or explicitly
still open:

1. **Frozen scope — satisfied for v1.** The 194 IDs and canonical names are
   frozen; the 66 rename mappings are accepted. Renames remain append-only.
2. **Coach review — open.** Review the coarse muscle labels on compound lifts,
   the equipment `items[]` mappings, and — before any cue/mistake content is
   authored — the 49 `rewrite` entries. The catalog must not be presented as
   authoritative and no cue content may ship until this gate completes.
3. **Pinned provenance — satisfied for v1.** The two upstream commits (full
   SHAs) are pinned in the catalog root `sources`, and the third-party notice is
   committed at `data/exercise-catalog/NOTICE`.
4. **Tests — satisfied for v1.** Tests cover catalog schema/uniqueness, alias
   ambiguity, taxonomy referential integrity, digest stability, pinned source
   commits, resolution determinism, old-record compatibility, and Chinese
   display completeness.
5. **Docs — satisfied for Phase 0.** `docs/ui-design.md`, the i18n README, and
   analysis/display documentation record the canonical-name behaviour. Later
   phases must update them again when logging or planning helpers ship.

## Evidence

| Fact | Source |
| --- | --- |
| Usable source: 876 English exercises, Unlicense; images not licensed | <https://github.com/yuhonas/free-exercise-db> (pinned commit `f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5`); image licensing discussion in <https://github.com/yuhonas/free-exercise-db/issues/2> |
| Usable source: 873 Chinese-localized pages, 100% English-name join, Unlicense | <https://github.com/gengyueworks/gym-exercise-guide> (pinned commit `ed41bb3a262fee9dd8d7d0aa3437696dcef601ed`) |
| wger code is AGPL-3.0; exercise data is a per-entry Creative Commons mix | <https://github.com/wger-project/wger#license> |
| Everkinetic data and artwork are CC-BY-SA-4.0 | <https://github.com/everkinetic/data> |
| workout-guide artwork is CC-BY-SA-4.0 even though the repository is MIT | <https://github.com/bryllim/workout-guide/blob/main/ATTRIBUTION.md> |
| LogPress data is MIT but media is © Gym visual | <https://github.com/hasaneyldrm/exercises-dataset> |
| ExerciseDB terms prohibit caching, retention, resale, and AI training | <https://edb-docs.up.railway.app/docs/api-terms-of-use> |
| ExRx prohibits scraping, copying, and AI training | <https://exrx.net/Notes/Legal> |
| 训记 Chinese name list has no declared license | <https://github.com/Foveluy/Xunji-movements> |
| FitKG-CN (CC-BY-4.0) and Wikidata (CC0) are terminology references only | <https://zenodo.org/records/14355004>, <https://www.wikidata.org/> |

Implementation-facing audit facts from the committed data: 194 entries (178
strength entries across 12 patterns, 8 cardio seeds, 8 mobility seeds); 66
entries renamed (`name_status: "renamed"`); 49 entries flagged
`content_status: "rewrite"` and 145 `template`; 15 entries carry 22 English
aliases and 78 entries carry Chinese alias lists; the catalog embeds no
cue/mistake fields and no media.

## Alternatives considered

- **Embed wger or another CC-BY-SA dataset.** Rejected: share-alike and mixed
  per-entry licensing make a closed product data set unsafe.
- **Use a hosted exercise API (ExerciseDB, wger API, MuscleWiki).** Rejected:
  proprietary/no-cache terms, runtime dependency, and no offline determinism.
- **Force users to pick from the catalog.** Rejected: long-tail gym equipment
  and custom movements would be blocked; the current product is append-only and
  user-authored.
- **Store catalog ids in workout records immediately.** Rejected for v1: schema
  version, content-derived ids, old mobile clients, and append-only storage make
  the rollout disproportionate to the benefit.
- **Ship the full 1,300-entry library with machine-translated text.** Rejected:
  name/content quality and unresolved media provenance; review effort would be
  larger than the curated 194.
- **Do nothing.** Rejected: exact-string trend grouping is already a correctness
  problem, and later equipment-aware planning would have no data to act on.

## Consequences

**Positive**

- Alias normalization fixes a real analysis defect without changing records,
  schema, API, or storage.
- Exercise-name logging gains deterministic, explainable suggestions from a
  clearly licensed dataset; planning and the other logging helpers remain
  unchanged until Phase 1.
- The catalog remains offline-friendly, deterministic, and available through the
  shared core to web, mobile, the pi extension, and the server.

**Negative / open work**

- Curation is real work: the 49 `rewrite` entries, the coarse muscle labels, and
  the equipment `items[]` checks still need coach review before the catalog is
  authoritative. The 66 canonical names are frozen.
- No media in v1; any future exercise-detail surface will be text-only until
  licensing or commissioned assets are available.
- Catalog data increases the shared-core/mobile bundle size; the extraction
  threshold must be watched.
- Analysis output changes (canonical labels) are user-visible and required docs,
  fixture, and test updates, which are included in this branch.
- v1 ships no cue/mistake content, no recent-exercise or equipment/muscle
  candidate lists, and no plan helpers; those remain future work (§7).
- Because this is a suggestion layer, custom names remain outside normalization;
  coverage depends on suggestion quality and alias growth, not enforcement.

## Out of scope

- images, videos, or any third-party media;
- record schema v2 / `exercise_id`;
- a server-side catalog API or dynamic catalog updates;
- Olympic lifting, plyometrics, strongman, full mobility, and the remaining
  cardio catalogue beyond the v1 seeds;
- cue/common-mistake authoring and exercise content beyond the seed quality bar
  (v1 ships no cue content);
- training-plan enforcement; deterministic plan suggestions are future work
  (§7).
