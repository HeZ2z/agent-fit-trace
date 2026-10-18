/**
 * Pixel-art pictograms for the navigation and the brand mark.
 *
 * Every glyph is composed from integer-aligned rectangles on a 24-unit grid
 * with `shape-rendering="crispEdges"`: no strokes, no rounded caps, no blur.
 * Icons are decorative (`aria-hidden`) — the adjacent label always carries the
 * accessible name.
 */

export type PixelIconName = "history" | "log" | "analysis" | "plan" | "coach" | "me";

type Rect = readonly [x: number, y: number, width: number, height: number];

const GLYPHS: Record<PixelIconName, readonly Rect[]> = {
  // Three list rows: a square bullet and a rule.
  history: [
    [3, 4, 3, 3],
    [9, 4, 12, 3],
    [3, 10, 3, 3],
    [9, 10, 12, 3],
    [3, 16, 3, 3],
    [9, 16, 12, 3],
  ],
  // A chunky plus.
  log: [
    [10, 3, 4, 18],
    [3, 10, 18, 4],
  ],
  // Three columns of increasing height.
  analysis: [
    [3, 14, 4, 7],
    [10, 9, 4, 12],
    [17, 4, 4, 17],
  ],
  // A training bag with a handle.
  plan: [
    [6, 4, 12, 3],
    [4, 8, 16, 13],
  ],
  // A speech bubble with a tail.
  coach: [
    [3, 4, 18, 13],
    [7, 17, 5, 4],
  ],
  // A square-headed figure.
  me: [
    [8, 3, 8, 8],
    [4, 13, 16, 8],
  ],
};

const paths = (rects: readonly Rect[]) =>
  rects.map(([x, y, width, height]) => `M${x} ${y}h${width}v${height}h-${width}z`).join("");

export function PixelIcon({ name, size = 24 }: { name: PixelIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      fill="currentColor"
    >
      <path d={paths(GLYPHS[name])} />
    </svg>
  );
}

/** The brand mark: a pixel dumbbell, ink outline and hard offset shadow via CSS. */
export function BrandMark() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="26"
      height="26"
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      fill="currentColor"
    >
      <path
        d={paths([
          [1, 8, 3, 8],
          [4, 10, 16, 4],
          [20, 8, 3, 8],
        ])}
      />
    </svg>
  );
}
