# @pi-fit-trace/i18n

Render-time English/Chinese display layer shared by the web app and the React
Native app.

## Boundary

- **Canonical data is English.** Workout records, snapshots, exports, generated
  plans and coaching payloads are stored, hashed and transported as English.
  Translation never rewrites a stored record.
- **This package is render-time only.** It maps an exact English source string
  to a Simplified Chinese translation, or rebuilds display copy from a stable
  domain code plus its evidence. Missing dictionary entries and unknown codes
  fall back to the original English text; no translation invents values.
- **Workout content itself is not translated.** Exercise names, notes, ids,
  dates and other user/artifact content pass through unchanged.
- **No environment access.** `translate` takes the language explicitly. This
  package has no localStorage, DOM, React or Node.js dependency, so both the
  web app and the React Native app can use it. The web app keeps its
  localStorage/`<html lang>`/`data-lang` store in `app/src/i18n/i18n.ts`; the
  storage key and accepted values are shared with `app/index.html`'s pre-paint
  bootstrap.
- **English source keys are the contract.** A dictionary key must be the exact
  English string rendered by the app. Changing display copy means updating the
  key in the same change.

## Exports

- `@pi-fit-trace/i18n` — `AppLanguage`, `DEFAULT_LANGUAGE`,
  `LANGUAGE_STORAGE_KEY`, `LANGUAGES`, `MessageParams`, `isLanguage`,
  `formatMessage`, `translate`, `ZH_MESSAGES`.
- `@pi-fit-trace/i18n/domain` — Chinese rebuild helpers for deterministic,
  code-bearing domain content (`displayFlagMessage`, `displayRecommendation`,
  `displayValidationMessage`, …).
- `@pi-fit-trace/i18n/zh/*` — individual dictionary tables, used by the
  dictionary integrity test.

## Scripts

- `pnpm --filter @pi-fit-trace/i18n typecheck`
