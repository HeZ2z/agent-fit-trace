import assert from "node:assert/strict";
import { test } from "node:test";

import { applyCloudSubpathRewrite } from "../server/vercel.ts";

test("restores rewritten cloud run subpaths and keeps unrelated query params", () => {
  for (const segment of ["events", "cancel"] as const) {
    const url = new URL(
      `http://fit-trace.invalid/api/v1/coaching/cloud/runs/run-1?__fit_trace_cloud_op=${segment}&fromSeq=7`,
    );
    assert.equal(applyCloudSubpathRewrite(url), true);
    assert.equal(url.pathname, `/api/v1/coaching/cloud/runs/run-1/${segment}`);
    assert.equal(url.searchParams.get("fromSeq"), "7");
    assert.equal(url.searchParams.get("__fit_trace_cloud_op"), null);
  }
});

test("is idempotent when Vercel keeps the original subpath in req.url", () => {
  for (const segment of ["events", "cancel"] as const) {
    const url = new URL(
      `http://fit-trace.invalid/api/v1/coaching/cloud/runs/run-1/${segment}?__fit_trace_cloud_op=${segment}&fromSeq=3`,
    );
    assert.equal(applyCloudSubpathRewrite(url), true);
    assert.equal(url.pathname, `/api/v1/coaching/cloud/runs/run-1/${segment}`);
    assert.equal(url.searchParams.get("fromSeq"), "3");
    assert.equal(url.searchParams.get("__fit_trace_cloud_op"), null);
  }
});

test("ignores unknown rewrite markers without injecting another path", () => {
  const url = new URL(
    "http://fit-trace.invalid/api/v1/coaching/cloud/runs/run-1?__fit_trace_cloud_op=../../admin",
  );
  assert.equal(applyCloudSubpathRewrite(url), false);
  assert.equal(url.pathname, "/api/v1/coaching/cloud/runs/run-1");
  assert.equal(url.searchParams.get("__fit_trace_cloud_op"), null);
});

test("leaves ordinary requests untouched", () => {
  const url = new URL("http://fit-trace.invalid/api/v1/coaching/cloud/runs/run-1/events?fromSeq=2");
  assert.equal(applyCloudSubpathRewrite(url), false);
  assert.equal(url.pathname, "/api/v1/coaching/cloud/runs/run-1/events");
  assert.equal(url.searchParams.get("fromSeq"), "2");
});
