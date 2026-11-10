import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toolchainPath, wellKnownUserToolchainBins } from "../server/coaching/toolchainPaths.ts";

test("toolchain candidates preserve numeric node ordering and deduplicate", () => {
  const bins = wellKnownUserToolchainBins({
    platform: "darwin", home: "/Users/a b", env: { NVM_DIR: "/Users/a b/.nvm", PNPM_HOME: "/Users/a b/.local/bin" },
    listDirectories: (dir) => dir.endsWith(".nvm/versions/node") ? ["v9.9.0", "v24.2.0", "v22.10.0", "current", "v24.10.0"] : [],
  });
  assert.deepEqual(bins.filter((p) => p.includes("/.nvm/")), [
    "/Users/a b/.nvm/versions/node/v24.10.0/bin", "/Users/a b/.nvm/versions/node/v24.2.0/bin",
    "/Users/a b/.nvm/versions/node/v22.10.0/bin", "/Users/a b/.nvm/versions/node/v9.9.0/bin",
  ]);
  assert.equal(bins.filter((p) => p === "/Users/a b/.local/bin").length, 1);
});

test("toolchain PATH rejects current and relative entries while preserving spaces", () => {
  const path = toolchainPath({ platform: "linux", home: "/home/a", env: { PATH: ":relative:/a b:/a b:.:/usr/bin" }, listDirectories: () => [] });
  assert.deepEqual(path.split(":").slice(0, 2), ["/a b", "/usr/bin"]);
  assert.ok(!path.split(":").includes("relative"));
});

test("Windows candidates preserve drive-absolute paths and PATH delimiters", () => {
  const path = toolchainPath({ platform: "win32", home: "C:\\Users\\A", env: { Path: 'relative;"C:\\Program Files\\node";;C:\\bin' }, listDirectories: () => [] });
  assert.deepEqual(path.split(";").slice(0, 2), ["C:\\Program Files\\node", "C:\\bin"]);
  assert.ok(path.includes("C:\\Users\\A\\AppData\\Roaming\\npm"));
});
