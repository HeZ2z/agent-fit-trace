# @pi-fit-trace/ui-tokens

Shared design tokens for the blueprint (Pixel) and Glass visual systems.

- `src/palette.ts` is generated from `app/src/styles/tokens.css` and
  `app/src/styles/glass.css` (oklch converted to sRGB for React Native).
- `src/index.ts` owns the hand-written structural tokens: spacing, radii,
  border widths, shadows and the type ramp.
- The web app keeps its CSS custom properties; this package is the contract
  that keeps the React Native app aligned with the same decisions.
