# UI design system

This document records the visual system used by `app/` and the rules for
extending it. It is a presentation contract only: behaviour, data access and
product copy stay governed by [`docs/mvp-design.md`](mvp-design.md) and
[`docs/app-dev-modes.md`](app-dev-modes.md).

## Provenance

The system is adapted from the **FORGE Fit Trace** responsive prototype, used
as a *style reference only*. No prototype page content, demo data, local-storage
keys, language layer or theme switcher was copied. The prototype and this app
happen to share the same six destinations (History, Log, Analysis, Plan, Coach,
Me); the restyle keeps this app's own information architecture, validation
states, auth gates and safety semantics.

Both typefaces are self-hosted (SIL OFL 1.1, licenses in
`app/src/assets/fonts/`):

- **Bricolage Grotesque** — display face, weights 700–800.
- **DM Sans** — body face, weights 100–1000, used with `tabular-nums` for
  figures. No separate mono family is introduced.

## Principles

1. **Structure is drawn, not shaded.** 3px ink/blue rules, hard offset shadows,
   square corners (`border-radius: 0`), no blur, no gradients, no grey cards.
2. **Blue is structure; red is punctuation.** Blue carries navigation, borders
   and section markers. Red is reserved for the one primary action, destructive
   actions and urgent safety states. Amber marks warnings that must never read
   as the red action colour.
3. **Content cards are opaque paper.** The blueprint grid lives on the
   workspace behind the content, never through it: text always sits on a pure
   white surface.
4. **Pixel pictograms only.** Navigation icons are rect-only SVG on a 24-unit
   grid with `shape-rendering="crispEdges"`, no strokes and no rounded caps.
   Icons are `aria-hidden`; the adjacent label always carries the name.
5. **Touch first.** Interactive controls are at least 44px in their interactive
   dimension, with a visible 3px focus ring at all sizes.

## Tokens

Defined once in `app/src/styles/tokens.css`.

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `oklch(100% 0 0)` | Card and input paper |
| `--shell` | `oklch(97.2% 0.012 268)` | Workspace ground |
| `--soft` | `oklch(94.1% 0.0281 270.4)` | Tinted well, hover fill |
| `--pale` | `oklch(88% 0.0585 271.3)` | Hairline, disabled edge |
| `--fg` | `oklch(27% 0.1121 265.3)` | Ink: text, structural rules |
| `--muted` | `oklch(49.9% 0.104 268.5)` | Secondary copy, labels |
| `--border` | `oklch(48.8% 0.2172 264.4)` | Blue structure |
| `--blue-deep` | `oklch(43% 0.2 264.4)` | Blue hover / small blue type |
| `--accent` | `oklch(57% 0.2068 22.6)` | Red punctuation |
| `--accent-deep` | `oklch(51% 0.19 22.6)` | Primary button fill (AA on white) |
| `--warn` / `--warn-soft` | `oklch(58% 0.13 65)` / `oklch(97% 0.025 80)` | Warning states |
| `--grid` | `oklch(48.8% 0.2172 264.4 / 0.06)` | 30px blueprint grid |

Structure and layout tokens: `--border-w` 3px, `--shadow-blue` 4px 4px 0,
`--shadow-blue-sm` 3px 3px 0, `--shadow-ink` 3px 3px 0, `--shadow-red` /
`--shadow-red-sm`, `--nav-w` 248px, `--content-max` 1180px,
`--content-narrow` 860px, `--page-pad` `clamp(22px, 4vw, 56px)`.

## Type scale

| Role | Family | Size / line-height |
| --- | --- | --- |
| Page title (`h1`) | Bricolage 800 | `clamp(34px, 4.6vw, 48px)` / 1 |
| Section title (`h2`) | Bricolage 800 | 21px / 1.1 with a red square marker |
| Card title (`h3`) | Bricolage 700 | 15px / 1.25 |
| Lede | DM Sans | 13.5px / 1.5, `--muted`, max 74ch |
| Body | DM Sans | 15px / 1.45 |
| Form label | DM Sans 700 | 10px, uppercase, 0.09em tracking |
| Meta / chip | DM Sans 600–700 | 9.5–11.5px, tabular figures |
| Primary button | DM Sans 700 | 14px, min-height 50px |

## Shell and breakpoints

One navigation element at every width; it never duplicates in the DOM.

| Width | Navigation | Content |
| --- | --- | --- |
| ≥ 1280 | 248px left panel, icon + label | content cap 1180px |
| 1024–1279 | 232px left panel | same |
| 900–1023 | 92px left rail, icon above 10.5px label; footer hidden | single column |
| 601–899 | bottom dock, icon above label, 54px targets | 880px column |
| ≤ 600 | bottom dock | 18px gutters, single column |

The app bar is sticky below 900px and shows the compact brand plus the runtime
mode badge and account controls. Above 900px the account controls float in the
top-right of the workspace column; the side panel carries brand, destinations
and data-scope disclosure.

The workspace ground is a 30px blueprint grid in `--grid`. Every card drawn on
it stays pure white.

## Component recipes

Implementation: `app/src/styles/controls.css`, `shell.css`, `screens-data.css`,
`screens-account.css`.

- **Primary action** — `button[type="submit"]`: red fill (`--accent-deep`),
  3px border, 4px ink offset shadow; hover brightens to `--accent`; active
  translates 2px. One per form.
- **Secondary/ghost** — plain `button` and `.btn-ghost` links: white fill,
  2px blue rule, blue label; hover tinted `--soft` with ink rule.
- **Surfaces** — `.data-card`, `.artifact-source`, `.plan-adoption`,
  `.plan-recommendation`, `.me-section`, `.summary-exercise`, `.empty-state`,
  `.coach-text`: white paper, 3px blue rule, 3px blue offset shadow, 14–16px
  padding.
- **Inputs** — 3px blue rule, 46px min-height, 14px semibold value; focus turns
  the rule ink and adds an inset ink ring. Labels are uppercase micro-caps.
- **Chips** — machine metadata (period, source, evidence) is a 2px-blue chip
  with a tinted background; evidence chips inside plan recommendations are
  9.5px pale-bordered tags.
- **Safety** — `[data-safety]` gets a 3px colored left rule and a text badge
  (`Extreme effort`, `Pain reported`), so severity never depends on colour
  alone. Flag cards tint and shadow by `data-flag-severity`
  (`critical` red, `warning` amber, `info` blue tint).
- **Feedback** — `.validation-summary` is a red-ruled alert with a red offset
  shadow; `.validation-warnings` is the amber equivalent. `.care-prompt` is the
  strongest red surface.

![History at 1440px](ui/desktop-history.jpg)

![Analysis at 1440px](ui/desktop-analysis.jpg)

![Log Workout at 1440px](ui/desktop-log.jpg)

![History at 390px](ui/mobile-history.jpg)

## Accessibility and test constraints

The restyle deliberately kept the semantics the test suite pins:

- Exactly one `h1` per screen; workout exercise names stay `h3`.
- `<nav aria-label="Primary">` with the same accessible link names
  (`History`, `Log Workout`, `Analysis`, `Plan`, `Me`, conditional `Coach`).
- Account controls stay directly reachable (no collapsed-only menus), and the
  guest sign-out flow stays two-step.
- Native form controls keep their existing labels; no new unlabeled inputs.
- Text that tests match is never split into per-word child elements
  (`getByText` only reads direct text nodes); decoration is added as
  `aria-hidden` SVG, wrappers or CSS, never by rewriting the copy.
- The single `role="status"` / `role="alert"` assumptions in loading and error
  states are preserved: the shell adds no global live region.

## Known gaps / intentionally not ported

- **No Pixel/Glass theme switcher.** The reference's second skin is not
  implemented; this app ships one skin. A switcher would be a product feature
  with its own persisted preference and tests.
- **No interface-language layer.** The app remains English-only.
- **Light mode only.** There is no dark theme token set.
- **No charts.** The app's deterministic analysis renders metrics, trends and
  flags; a bar chart is out of scope for a visual restyle.
