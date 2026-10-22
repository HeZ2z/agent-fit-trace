/**
 * React Native access to the shared Pixel/Glass token system.
 *
 * The token values live in @agent-fit-trace/ui-tokens so the web CSS and the
 * native styles cannot drift; this module only owns the app-side skin state.
 */
export {
  SKINS,
  SPACING,
  TYPOGRAPHY,
  LAYOUT,
  SKIN_NAMES,
  isSkinName,
  type SkinName,
  type SkinTokens,
  type SkinPalette,
} from "@agent-fit-trace/ui-tokens";
