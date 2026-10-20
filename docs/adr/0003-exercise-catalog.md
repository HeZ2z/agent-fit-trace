# ADR 0003: Exercise catalog as a suggestion layer, backed by Unlicense data

- **Status:** Accepted. The v1 implementation is on the `feat/exercise-catalog`
  feature branch and awaits review and merge: the versioned 194-entry catalog
  and alias resolver (shared core), render-time Chinese display names,
  Chinese localization of catalog exercise names inside rebuilt copy,
  alias-normalized analysis trends, and the web and mobile
  autocomplete/display layers (the mobile Log field consumes the same shared
  suggestion search as the web editor).
  The frozen 194-entry scope, its IDs, and the 66 canonical-name decisions are
  implemented as-is; no storage, record-schema, or API change is part of it.
  Content review remains open — the 49 priority cue/mistake rewrites, the
  muscle/equipment review, and authoritative cue authoring are not done, so the
  catalog is not yet authoritative. Upstream commits are pinned and provenance
  is recorded in the committed data; a standalone third-party `NOTICE` file is
  not yet added.
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
- Canonical data is English; the render-time i18n layer explicitly does not
  translate workout content such as exercise names (`packages/fit-trace-i18n/README.md`).
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
  Seed content is therefore input to authoring, not final content.

### Product decision

The catalog is a **suggestion layer**: it assists logging, improves analysis
normalization, and supports deterministic plan suggestions. It does not gate data
entry, rewrite stored records, or make the LLM an authority on exercise facts.

## Decision

### 1. Suggestion-layer boundary

The catalog is used in three places:

1. **Logging:** autocomplete, recent exercises, and equipment/muscle candidates.
   A user can ignore every suggestion and type a custom name.
2. **Analysis:** resolve a recorded name to one catalog entry when the match is
   unambiguous; group/filter/label by that entry. An unmatched name stays raw.
3. **Planning:** deterministic candidate and substitution suggestions based on
   movement pattern, equipment, muscles, and pain constraints. Suggestions are
   draft-only and never write records.

It never does the following:

- no validation error for an unknown exercise name;
- no forced catalog selection;
- no rewriting or backfilling of historical records;
- no LLM-authored exercise facts, cues, or substitutions; the Skill may explain
  tool output but the rules live in the deterministic core.

### 2. v1 scope and taxonomy

- **194 entries:** 178 strength entries across 12 movement patterns, plus 8
  cardio seeds and 8 mobility seeds, to cover every `session_type`.
- **Patterns:** `squat`, `hinge`, `lunge`, `horizontal_push`, `vertical_push`,
  `horizontal_pull`, `vertical_pull`, `core`, `biceps`, `triceps`,
  `shoulders`, `legs`, plus `cardio` and `mobility` seed groups.
- **Fields:** stable `id`, canonical English `name`, localized display data,
  `aliases`, `primary_muscles`, `secondary_muscles`, `movement_pattern`,
  `mechanics` (compound/isolation), `force` (push/pull/static), `difficulty`,
  `equipment.category` + `equipment.items[]`, provenance, and review status.
- **IDs:** ASCII snake_case, globally unique, never reused. Entries are
  deprecated, not deleted; aliases are append-only.
- **Names:** 66 seed names are renamed to canonical names; the seed name remains
  a Chinese alias. The two dip versions stay separate with a `variant_of`
  relation (`chest_dip` / `triceps_dip`).
- **Muscles:** v1 uses the 17 coarse labels inherited from free-exercise-db.
  They are a starting taxonomy, not a training-science review; compound lifts
  need coach review before the catalog is presented as authoritative.
- **Content:** Chinese cues and common mistakes are seed templates. 49 entries
  are flagged for priority rewrite. No entry's cues are final until reviewed.
- **No media:** images and videos are out of scope; no source with acceptable
  media licensing is available for this repository.

### 3. Data source and licence boundary

- v1 metadata is derived from the two Unlicense sources above. Only text and
  structured metadata are used; images and videos are never copied.
- No wger, Everkinetic, workout-guide, LogPress media, ExerciseDB, ExRx, or
  MuscleWiki data is embedded.
- Provenance is recorded per entry (`source`, `source_url`, `license`,
  `retrieved_at`, upstream commit). A `NOTICE`/third-party notice is added even
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

The stored/transported contract remains canonical English. This ADR amends the
render-time rule for catalog-backed exercise names:

- catalog-backed names are translated at render time through the catalog entry
  (canonical English name → display name in the selected language);
- custom/free-text names pass through unchanged;
- notes, user-authored names, ids, and dates are never translated;
- plan and analysis strings that embed an exercise name use the same display
  helper.

`packages/fit-trace-i18n/README.md` and the dictionary tests must be updated with
this exception when implementation starts.

### 6. Placement, determinism, and versioning

- v1 lives in `packages/fit-trace-core/src/exercises/`: browser-safe types,
  generated catalog data, pure lookup/alias resolution, and deterministic
  suggestion helpers. It imports no pi, Node, or typebox APIs.
- The catalog is generated from vendored source snapshots by a repository script;
  the generated TypeScript is committed. The work never fetches data at runtime.
- A `catalogVersion` plus a content digest is asserted by tests. The catalog and
  its aliases are static, deterministic, and append-only; no clock or randomness
  participates.
- Data size is expected to stay small enough for the shared core. If content,
  translations, or media later exceed that budget, extraction to a dedicated
  workspace package is allowed without changing callers.
- Web, mobile, the pi extension, and the server share this core. v1 adds no
  server/API endpoint; the catalog is bundled with the clients. A server-side
  catalog endpoint is a later decision if content updates must bypass app
  releases.

### 7. Behaviour changes and rollout

- **Phase 0 (first):** catalog + resolver + analysis normalization + editor
  autocomplete + Chinese display. No record schema, API, or database change.
  Analysis therefore groups aliases into one canonical trend; this is a
  deliberate, user-visible change and existing tests/docs must be updated.
- **Phase 1:** deterministic plan candidate/substitution suggestions using
  equipment, movement pattern, muscles, and pain constraints; exercise detail
  and per-exercise history. `PlanConstraints.equipment` becomes executable.
- **Phase 2 (conditional):** record-level `exercise_id` with schema v2, only if
  a real requirement appears. This needs a separate rollout decision covering
  old clients, mobile sync, and content-derived ids.
- **Rollback:** remove the catalog code/data and the display helper; stored
  records, ids, and wire contracts are unaffected. There is no migration to
  reverse.

### 8. Review gates before implementation

The following are prerequisites for implementation, not afterthoughts:

1. Freeze the 194 IDs and canonical names; the 66 rename mappings are accepted.
2. Coach review of the 17 muscle labels on compound lifts, the 49 priority cue
   rewrites, and equipment `items[]` spot checks.
3. Pin the two upstream source commits and record provenance/notice.
4. Add tests for catalog schema/uniqueness, alias ambiguity, taxonomy
   referential integrity, digest stability, resolution determinism, old-record
   compatibility, and Chinese display completeness.
5. Update `docs/ui-design.md`, the i18n README, and analysis documentation where
   the canonical-name behaviour changes.

## Evidence

| Fact | Source |
| --- | --- |
| Usable source: 876 English exercises, Unlicense; images not licensed | <https://github.com/yuhonas/free-exercise-db> (commit `f00c92c7`); image licensing discussion in <https://github.com/yuhonas/free-exercise-db/issues/2> |
| Usable source: 873 Chinese-localized pages, 100% English-name join, Unlicense | <https://github.com/gengyueworks/gym-exercise-guide> (commit `ed41bb3a`) |
| wger code is AGPL-3.0; exercise data is a per-entry Creative Commons mix | <https://github.com/wger-project/wger#license> |
| Everkinetic data and artwork are CC-BY-SA-4.0 | <https://github.com/everkinetic/data> |
| workout-guide artwork is CC-BY-SA-4.0 even though the repository is MIT | <https://github.com/bryllim/workout-guide/blob/main/ATTRIBUTION.md> |
| LogPress data is MIT but media is © Gym visual | <https://github.com/hasaneyldrm/exercises-dataset> |
| ExerciseDB terms prohibit caching, retention, resale, and AI training | <https://edb-docs.up.railway.app/docs/api-terms-of-use> |
| ExRx prohibits scraping, copying, and AI training | <https://exrx.net/Notes/Legal> |
| 训记 Chinese name list has no declared license | <https://github.com/Foveluy/Xunji-movements> |
| FitKG-CN (CC-BY-4.0) and Wikidata (CC0) are terminology references only | <https://zenodo.org/records/14355004>, <https://www.wikidata.org/> |

Implementation-facing audit facts from the working draft: 194 entries selected
from the 619-entry strength/powerlifting pool; 66 names renamed; 49 entries
flagged for cue rewrite; 79 entries have aliases; the source pages have complete
sections but shared cue/mistake templates; no media is copied.

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
  problem, and equipment-aware planning has no data to act on.

## Consequences

**Positive**

- Alias normalization fixes a real analysis defect without changing records,
  schema, API, or storage.
- Logging and planning gain deterministic, explainable exercise data with a clear
  licensing path.
- The catalog remains offline-friendly, deterministic, and shared by web,
  mobile, pi, and the server.

**Negative / open work**

- Curation is real work: 66 name decisions, 49 cue rewrites, muscle reviews, and
  equipment items still need human review before the catalog is authoritative.
- No media in v1; exercise detail pages will be text-only until licensing or
  commissioned assets are available.
- Catalog data increases the shared-core/mobile bundle size; the extraction
  threshold must be watched.
- Analysis output changes (canonical names) are user-visible and require docs,
  fixture, and test updates.
- Because this is a suggestion layer, custom names remain outside normalization;
  coverage depends on suggestion quality and alias growth, not enforcement.

## Out of scope

- images, videos, or any third-party media;
- record schema v2 / `exercise_id`;
- a server-side catalog API or dynamic catalog updates;
- Olympic lifting, plyometrics, strongman, full mobility, and the remaining
  cardio catalogue beyond the v1 seeds;
- exercise content beyond the seed quality bar;
- training-plan enforcement (the catalog suggests; the plan remains a draft).
