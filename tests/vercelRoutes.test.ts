import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Vercel routing guards for the API Functions.
 *
 * The deployed filesystem routing matches only one segment for bracket route
 * segments, and nested dynamic paths conflict with a catch-all sibling. The
 * multi-segment cloud run subpaths are therefore handled by `vercel.json`
 * rewrites into the nearest single-segment Function. The Hobby plan also caps
 * a deployment at 12 Functions.
 */
const API_DIR = fileURLToPath(new URL("../api", import.meta.url));
const VERCEL_CONFIG = fileURLToPath(new URL("../vercel.json", import.meta.url));

function collectFunctionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFunctionFiles(path));
    else if (entry.name.endsWith(".mjs")) found.push(path);
  }
  return found;
}

test("vercel api Functions stay within the Hobby plan limit", () => {
  const files = collectFunctionFiles(API_DIR);
  assert.ok(files.length <= 6, `found ${files.length} API Functions; preserve room under the Hobby limit`);
});

test("data API paths are rewritten to the shared Function", () => {
  const config = JSON.parse(readFileSync(VERCEL_CONFIG, "utf8")) as {
    rewrites: Array<{ source: string; destination: string }>;
  };
  for (const path of ["workouts", "analysis", "public-config", "plans/drafts", "imports", "imports/:id", "import-selections/:kind", "plan-adoption"]) {
    assert.ok(config.rewrites.some((entry) =>
      entry.source === `/api/v1/${path}` &&
      entry.destination === `/api/v1/router?__fit_trace_route=${path}`,
    ), `missing data route rewrite for ${path}`);
  }
  assert.ok(existsSync(join(API_DIR, "v1/router.mjs")));
});

test("multi-segment cloud run subpaths are rewritten to the nearest Function", () => {
  const config = JSON.parse(readFileSync(VERCEL_CONFIG, "utf8")) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
  };
  const rewrites = config.rewrites ?? [];
  const required = [
    {
      source: "/api/v1/coaching/cloud/runs/:id/events",
      marker: "__fit_trace_cloud_op=events",
    },
    {
      source: "/api/v1/coaching/cloud/runs/:id/cancel",
      marker: "__fit_trace_cloud_op=cancel",
    },
  ];
  for (const entry of required) {
    assert.ok(
      rewrites.some(
        (rewrite) =>
          rewrite.source === entry.source &&
          typeof rewrite.destination === "string" &&
          rewrite.destination.includes(entry.marker),
      ),
      `missing Vercel rewrite for ${entry.source}`,
    );
  }
  assert.ok(
    existsSync(join(API_DIR, "v1/coaching/cloud/runs/[...path].mjs")),
    "the rewritten requests need the nearest single-segment runs Function",
  );
});

test("no nested dynamic directory conflicts with the runs catch-all Function", () => {
  assert.equal(
    existsSync(join(API_DIR, "v1/coaching/cloud/runs/[id]")),
    false,
    "Vercel rejects nested dynamic paths next to runs/[...path].mjs; use the rewrite instead",
  );
});
