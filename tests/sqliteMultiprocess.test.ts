import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SqliteWorkoutStore } from "@agent-fit-trace/store";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const OWN_RECORDS = 25;
const SHARED_RECORDS = 3;

/**
 * Worker body run via `node -e` in a separate process: imports its own 25
 * non-overlapping records plus a few shared ids that both workers attempt with
 * identical content (the duplicate no-op path under real cross-process locking).
 */
const WORKER_SCRIPT = `
const { SqliteWorkoutStore } = await import("@agent-fit-trace/store");
const dbPath = process.env.FIT_TRACE_TEST_DB;
const worker = Number(process.env.FIT_TRACE_TEST_WORKER);
const OWN = ${OWN_RECORDS};
const SHARED = ${SHARED_RECORDS};
const pad = (value) => String(value).padStart(2, "0");

const own = [];
for (let index = 0; index < OWN; index += 1) {
  own.push({
    id: "worker-" + worker + "-" + pad(index),
    schema_version: 1,
    date: "2026-10-" + pad(1 + ((worker * OWN + index) % 28)),
    session_type: "strength",
    exercises: [{ name: "bench_press", sets: [{ weight: 60 + index, reps: 5 }] }],
    pain: [],
  });
}
const shared = [];
for (let index = 0; index < SHARED; index += 1) {
  shared.push({
    id: "shared-" + pad(index),
    schema_version: 1,
    date: "2026-09-" + pad(10 + index),
    session_type: "strength",
    exercises: [{ name: "squat", sets: [{ weight: 100, reps: 5 }] }],
    pain: [],
  });
}

const store = new SqliteWorkoutStore(dbPath);
const results = await Promise.all([...own, ...shared].map((record) => store.import(record)));
store.close();
const summary = {
  ownImported: results.slice(0, OWN).filter((result) => !result.duplicate).length,
  sharedImported: results.slice(OWN).filter((result) => !result.duplicate).length,
};
console.log("RESULT " + JSON.stringify(summary));
`;

interface WorkerSummary {
  ownImported: number;
  sharedImported: number;
}

function runWorker(dbPath: string, worker: number): Promise<WorkerSummary> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", WORKER_SCRIPT],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, FIT_TRACE_TEST_DB: dbPath, FIT_TRACE_TEST_WORKER: String(worker) },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${worker} exited with ${code}: ${stderr}`));
        return;
      }
      const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
      if (!line) {
        reject(new Error(`worker ${worker} produced no result line. stdout: ${stdout}`));
        return;
      }
      resolve(JSON.parse(line.slice("RESULT ".length)) as WorkerSummary);
    });
  });
}

const pad = (value: number): string => String(value).padStart(2, "0");

test("two processes writing the same db concurrently do not lose records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fit-trace-multiproc-"));
  try {
    const dbPath = join(dir, "workouts.db");
    const [first, second] = await Promise.all([runWorker(dbPath, 0), runWorker(dbPath, 1)]);

    assert.equal(first.ownImported, OWN_RECORDS);
    assert.equal(second.ownImported, OWN_RECORDS);
    // Identical content from both sides: exactly one worker may claim each row.
    assert.equal(first.sharedImported + second.sharedImported, SHARED_RECORDS);

    const store = new SqliteWorkoutStore(dbPath);
    try {
      const records = await store.all();
      // 25 own rows per worker plus the 3 shared ids, each deduplicated to one row.
      assert.equal(
        records.length,
        OWN_RECORDS * 2 + SHARED_RECORDS,
        "no record lost across the two writers",
      );
      const ids = records.map((record) => record.id);
      assert.equal(new Set(ids).size, ids.length, "no duplicate rows for the same id");

      for (let worker = 0; worker < 2; worker += 1) {
        for (let index = 0; index < OWN_RECORDS; index += 1) {
          assert.ok(ids.includes(`worker-${worker}-${pad(index)}`));
        }
      }
      for (let index = 0; index < SHARED_RECORDS; index += 1) {
        assert.equal(
          ids.filter((id) => id === `shared-${pad(index)}`).length,
          1,
          `shared-${pad(index)} stored exactly once`,
        );
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
