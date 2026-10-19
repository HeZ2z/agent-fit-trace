/**
 * Generated from app/src/styles/tokens.css and app/src/styles/glass.css.
 *
 * The web keeps CSS custom properties (oklch); React Native needs concrete
 * sRGB values. Keep this mirror in sync with the two CSS files whenever a
 * colour token changes (oklch L/C/H converted to sRGB, alpha preserved).
 */

export interface SkinPalette {
  background: string;
  surface: string;
  shell: string;
  soft: string;
  pale: string;
  hair: string;
  grid: string;
  fg: string;
  muted: string;
  border: string;
  blueDeep: string;
  accent: string;
  accentDeep: string;
  warn: string;
  warnDeep: string;
  warnSoft: string;
  dangerSoft: string;
  infoSoft: string;
  glassTint: string;
  glassTintHi: string;
  glassEdge: string;
  glassSpec: string;
  glassShade: string;
  glassMuted: string;
}

export const PIXEL_PALETTE: SkinPalette = {
  background: "#ffffff",
  surface: "#ffffff",
  shell: "#f2f6fe",
  soft: "#e4ebff",
  pale: "#c9d6ff",
  hair: "#d8dce7",
  grid: "rgba(29, 78, 216, 0.06)",
  fg: "#0b1f5c",
  muted: "#4a5f9e",
  border: "#1d4ed8",
  blueDeep: "#143ebb",
  accent: "#d62839",
  accentDeep: "#ba1c2e",
  warn: "#ae6700",
  warnDeep: "#8a4c00",
  warnSoft: "#fef4e3",
  dangerSoft: "#fff4f3",
  infoSoft: "#f2f6fe",
  glassTint: "rgba(255, 255, 255, 0.78)",
  glassTintHi: "rgba(255, 255, 255, 0.88)",
  glassEdge: "rgba(158, 167, 190, 0.42)",
  glassSpec: "rgba(255, 255, 255, 0.9)",
  glassShade: "rgba(136, 146, 171, 0.2)",
  glassMuted: "#32447b",
};

export const GLASS_PALETTE: SkinPalette = {
  background: "#ffffff",
  surface: "#ffffff",
  shell: "#f7f8fd",
  soft: "#f0f3fd",
  pale: "#dfe3ec",
  hair: "#d8dce7",
  grid: "transparent",
  fg: "#0b1f5c",
  muted: "#4a5f9e",
  border: "#1d4ed8",
  blueDeep: "#143ebb",
  accent: "#d62839",
  accentDeep: "#ba1c2e",
  warn: "#ae6700",
  warnDeep: "#8a4c00",
  warnSoft: "#fef4e3",
  dangerSoft: "#fff4f3",
  infoSoft: "#f2f6fe",
  glassTint: "rgba(255, 255, 255, 0.78)",
  glassTintHi: "rgba(255, 255, 255, 0.88)",
  glassEdge: "rgba(158, 167, 190, 0.42)",
  glassSpec: "rgba(255, 255, 255, 0.9)",
  glassShade: "rgba(136, 146, 171, 0.2)",
  glassMuted: "#32447b",
};
