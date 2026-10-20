# @pi-fit-trace/i18n

Render-time English/Chinese display layer shared by the web app and the React
Native app.

## Boundary

- **Canonical catalog/domain data is English.** Catalog names, the Chinese
  display table keyed by them, dictionary keys, and generated analysis/plan
  template copy use English as the canonical source. A workout record, snapshot,
  export or plan payload keeps its exercise name as authored — the canonical
  English name after a catalog suggestion selection, otherwise the alias,
  custom name, or Chinese text the user typed. Translation never rewrites a
  stored record.
- **This package is render-time only.** It maps an exact English source string
  to a Simplified Chinese translation, or rebuilds display copy from a stable
  domain code plus its evidence. Missing dictionary entries and unknown codes
  fall back to the original English text; no translation invents values.
- **Workout content itself is not translated, with one catalog exception.**
  When the exercise catalog resolves a recorded name to a catalog entry, the
  catalog-backed exercise name is translated at render time by its canonical
  English name (`displayExerciseName` for a known canonical name,
  `displayStoredExerciseName` for a stored/typed name that may be an alias).
  This includes the workout editor's exercise-name input: in Chinese it shows
  the Chinese display name (e.g. `杠铃卧推`), while selecting a suggestion
  passes the canonical English name (`Barbell Bench Press - Medium Grip`) to
  storage and free text is passed through exactly as typed. The input is a
  display surface only; user-authored/custom exercise names, notes, ids, dates
  and other user/artifact content pass through unchanged, and English UI shows
  the stored spelling exactly.
- **Autocomplete search is shared.** `searchExerciseSuggestions` is the one
  editor suggestion implementation for both apps: it merges the core catalog's
  English name/alias search with the generated Chinese display/alias tables,
  de-duplicates by canonical name, and keeps a deterministic order. Option
  labels are UI-language copy only — Chinese shows the Chinese display name
  (e.g. `杠铃卧推`), English shows the canonical English name — while selecting
  a result always writes the canonical English name to `canonicalName`/storage.
- **Catalog exercise names are data, not interface copy.** Chinese names and
  aliases live in `zh/exercises.ts`, are keyed by canonical English name and
  are generated from `data/exercise-catalog/zh-names.v1.json`; they are never
  merged into `ZH_MESSAGES`.
- **No environment access.** `translate` takes the language explicitly. This
  package has no localStorage, DOM, React or Node.js dependency, so both the
  web app and the React Native app can use it; the catalog search only imports
  browser-safe `@pi-fit-trace/core` helpers. The web app keeps its
  localStorage/`<html lang>`/`data-lang` store in `app/src/i18n/i18n.ts`; the
  storage key and accepted values are shared with `app/index.html`'s pre-paint
  bootstrap.
- **English source keys are the contract.** A dictionary key must be the exact
  English string rendered by the app. Changing display copy means updating the
  key in the same change.

## Exports

- `@pi-fit-trace/i18n` — `AppLanguage`, `DEFAULT_LANGUAGE`,
  `LANGUAGE_STORAGE_KEY`, `LANGUAGES`, `MessageParams`, `isLanguage`,
  `formatMessage`, `translate`, `ZH_MESSAGES`, and the catalog-backed exercise
  display/autocomplete layer: `displayExerciseName`,
  `displayStoredExerciseName`, `searchExerciseSuggestions`,
  `MAX_EXERCISE_SUGGESTIONS`, `ExerciseSuggestion`,
  `EXERCISE_DISPLAY_NAMES_ZH`, `EXERCISE_ALIASES_ZH`.
- `@pi-fit-trace/i18n/domain` — Chinese rebuild helpers for deterministic,
  code-bearing domain content (`displayFlagMessage`, `displayRecommendation`,
  `displayValidationMessage`, …).
- `@pi-fit-trace/i18n/zh/*` — individual dictionary tables (and the generated
  exercise-name table), used by the dictionary integrity test.

## Scripts

- `pnpm --filter @pi-fit-trace/i18n typecheck`
