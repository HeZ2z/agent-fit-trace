# Exercise catalog source data (v1)

This directory is the curated source of truth for the v1 exercise catalog. It is
input to `scripts/build-exercise-catalog.mjs`; runtime code consumes the generated
TypeScript in `packages/fit-trace-core/src/exercises/`, never these JSON files
directly.

## Files

- `catalog.v1.json` — 194 canonical entries. Each entry has a stable `id`, a
  canonical English `name`, English `aliases`, a movement `pattern`, primary and
  secondary muscles, `equipment.category` + `equipment.items[]`, difficulty,
  mechanics, force, content review status, and source references.
- `zh-names.v1.json` — Chinese display names and Chinese aliases, keyed by the
  canonical English name. Consumed only by the render-time i18n package.

## Scope

194 entries: 178 strength entries across 12 movement patterns, plus 8 cardio and
8 mobility seeds so every `session_type` has representative choices. The full
194-row review draft, rename list, rewrite backlog, and aliases live in
`docs/exercise-catalog-mapping-v0.md`.

## Provenance and licence

All metadata is derived from two Unlicense sources:

| Source | Commit | Licence | Used for |
| --- | --- | --- | --- |
| [`gengyueworks/gym-exercise-guide`](https://github.com/gengyueworks/gym-exercise-guide) | `ed41bb3a262fee9dd8d7d0aa3437696dcef601ed` | Unlicense | Chinese names/aliases, Chinese taxonomy labels, seed cues/mistakes |
| [`yuhonas/free-exercise-db`](https://github.com/yuhonas/free-exercise-db) | `f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5` | Unlicense | English names, muscles, equipment, level, mechanics, force |

No images, videos, or other media are included. No share-alike or proprietary
data is embedded. Unlicense does not require attribution, but the source commit,
repository URL, and licence are recorded in `catalog.v1.json` and each entry
keeps its `source` reference.

`muscles` and `equipment.items[]` are inherited/heuristic starting points, not
training-science review. `content_status: "rewrite"` marks entries whose seed
cues/mistakes are known to be misleading and must be rewritten before the
catalog can be presented as authoritative. `content_status: "template"` still
means the seed content is a draft.

## Regeneration

`scripts/build-exercise-catalog.mjs` validates `catalog.v1.json` (schema and
version, entry count, unique ids/canonical names/aliases, controlled
vocabularies, equipment items, source references), computes the catalog digest,
and emits `packages/fit-trace-core/src/exercises/catalog.generated.ts`. The
generated file and digest are committed so runtime code has no filesystem or
network dependency. Do not edit the generated file by hand.

```sh
node scripts/build-exercise-catalog.mjs          # validate and regenerate
node scripts/build-exercise-catalog.mjs --check  # verify the committed output is current
```

The script is deterministic: the source JSON is the only input, and no clock,
randomness, or network access participates. It has no third-party dependencies.
