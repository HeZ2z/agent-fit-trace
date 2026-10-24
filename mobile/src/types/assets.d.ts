/**
 * Metro asset module declarations.
 *
 * Bundlers resolve non-code assets to an opaque numeric asset id, which is
 * exactly what `expo-audio`'s `useAudioPlayer` accepts. TypeScript has no
 * built-in declaration for the extension, so importing the bundled rest cue
 * needs this small ambient module.
 */
declare module "*.wav" {
  const assetId: number;
  export default assetId;
}
