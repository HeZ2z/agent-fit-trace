/**
 * Exercise catalog: versioned static data plus pure lookup/suggestion helpers.
 *
 * The catalog is a suggestion layer (see `docs/adr/0003-exercise-catalog.md`).
 * It never gates data entry, never rewrites stored records, and never fetches
 * data at runtime; the generated data ships inside the browser-safe core.
 */
export * from "./types.ts";
export * from "./catalog.generated.ts";
export * from "./resolve.ts";
