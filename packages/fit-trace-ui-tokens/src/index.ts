/**
 * Shared Pixel/Glass design tokens for the web and the React Native app.
 *
 * The web consumes design tokens through CSS custom properties in
 * app/src/styles; this package mirrors the same decisions as typed data so
 * the React Native app cannot drift from the visual system. `palette.ts` is
 * generated from the CSS source; layout values are kept by hand because
 * React Native uses numeric density-independent pixels instead of CSS units.
 */

import { GLASS_PALETTE, PIXEL_PALETTE, type SkinPalette } from "./palette.ts";

export type { SkinPalette };
export { GLASS_PALETTE, PIXEL_PALETTE };

export type SkinName = "pixel" | "glass";

export interface SkinTokens {
  palette: SkinPalette;
  /** Border width in dp; the Pixel skin draws 3dp rules, Glass hairlines. */
  borderWidth: number;
  borderWidthThin: number;
  radiusCard: number;
  radiusControl: number;
  /** Hard offset shadow for Pixel; Glass replaces it with a soft elevation. */
  shadow: {
    offsetX: number;
    offsetY: number;
    blurRadius: number;
    color: string;
  };
}

export const SKINS: Record<SkinName, SkinTokens> = {
  pixel: {
    palette: PIXEL_PALETTE,
    borderWidth: 3,
    borderWidthThin: 2,
    radiusCard: 0,
    radiusControl: 0,
    shadow: { offsetX: 4, offsetY: 4, blurRadius: 0, color: PIXEL_PALETTE.border },
  },
  glass: {
    palette: GLASS_PALETTE,
    borderWidth: 1,
    borderWidthThin: 1,
    radiusCard: 8,
    radiusControl: 6,
    shadow: {
      offsetX: 0,
      offsetY: 12,
      blurRadius: 26,
      color: "rgba(28, 29, 43, 0.14)",
    },
  },
};

/** 4-based spacing scale in dp, mirroring the web `--space-*` tokens. */
export const SPACING = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
} as const;

export const LAYOUT = {
  contentMax: 1180,
  contentNarrow: 860,
  pagePad: 22,
  dockHeight: 64,
} as const;

export const TYPOGRAPHY = {
  display: "BricolageGrotesque",
  body: "DMSans",
  h1: { fontSize: 34, lineHeight: 40, fontWeight: "800" },
  h2: { fontSize: 22, lineHeight: 28, fontWeight: "800" },
  bodyText: { fontSize: 15, lineHeight: 22 },
  micro: { fontSize: 11, lineHeight: 14, letterSpacing: 1.2 },
} as const;

export const SKIN_NAMES: readonly SkinName[] = ["pixel", "glass"] as const;

export function isSkinName(value: unknown): value is SkinName {
  return value === "pixel" || value === "glass";
}
