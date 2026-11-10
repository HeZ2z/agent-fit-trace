import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { probeCodexAppServer } from "../server/coaching/codexAppServerCapability.ts";
import { probeOpenCodeRun } from "../server/coaching/opencodeCapability.ts";

for (const kind of ["codex", "opencode"] as const) {
  test(`${kind} probe abort terminates its child`, { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fit-trace-probe-abort-"));
    const binary = join(dir, "agent");
    const pidFile = join(dir, "pid");
    await writeFile(binary, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec /bin/sleep 30\n`);
    await chmod(binary, 0o755);
    const controller = new AbortController();
    const probe = kind === "codex"
      ? probeCodexAppServer({ binary, signal: controller.signal, timeoutMs: 30_000 })
      : probeOpenCodeRun({ binary, signal: controller.signal, timeoutMs: 30_000 });
    try {
      let pid = 0;
      for (let attempt = 0; attempt < 100 && pid === 0; attempt++) {
        try { pid = Number(await readFile(pidFile, "utf8")); } catch { await delay(10); }
      }
      assert.ok(pid > 0, "probe child started");
      controller.abort();
      await probe;
      let exited = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(pid, 0); } catch { exited = true; break; }
        await delay(10);
      }
      assert.equal(exited, true, "abort must terminate the child process");
    } finally {
      controller.abort();
      await probe;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
