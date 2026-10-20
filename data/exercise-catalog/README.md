# Exercise catalog source data (v1)

This directory is the curated source of truth for the v1 exercise catalog and
its Chinese names. Both files are input to `scripts/build-exercise-catalog.mjs`;
runtime code consumes the generated TypeScript in
`packages/fit-trace-core/src/exercises/` and `packages/fit-trace-i18n/src/zh/`,
never these JSON files directly.

## Files

- `catalog.v1.json` — 194 canonical entries. Each entry has a stable `id`, a
  canonical English `name`, English `aliases`, a movement `pattern`, primary and
  secondary muscles, `equipment.category` + `equipment.items[]`, difficulty,
  mechanics, force, content review status, and source references.
- `zh-names.v1.json` — Chinese display names and Chinese aliases, keyed by the
  canonical English name in catalog order. Validated by the generator and emitted
  into the render-time i18n package; never read at runtime.

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

`scripts/build-exercise-catalog.mjs` is the single deterministic build for both
generated outputs:

- `catalog.v1.json` is validated (schema and version, entry count, unique
  ids/canonical names/aliases, controlled vocabularies, equipment items, source
  references), hashed, and emitted as
  `packages/fit-trace-core/src/exercises/catalog.generated.ts`.
- `zh-names.v1.json` is validated against the catalog (schema and version, exact
  canonical keys in catalog order, non-empty display names, unique non-empty
  aliases), hashed, and emitted as
  `packages/fit-trace-i18n/src/zh/exercises.ts` (`EXERCISE_DISPLAY_NAMES_ZH` and
  `EXERCISE_ALIASES_ZH`).

Both generated files and their digests are committed so runtime code has no
filesystem or network dependency. Do not edit either generated file by hand.

```sh
node scripts/build-exercise-catalog.mjs          # validate and regenerate both outputs
node scripts/build-exercise-catalog.mjs --check  # verify both committed outputs are current
```

`--check` reports every stale output, naming the generated file and the source
JSON it disagrees with, and exits non-zero until the generator is re-run and the
result committed. `--check --catalog <path>` and `--check --zh <path>` are
validation-only test hooks for alternate source files; they cannot write
generated output.

The script is deterministic: each source JSON is the only input, and no clock,
randomness, or network access participates. It has no third-party dependencies.
