import { readdirSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";

export interface ToolchainPathOptions {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  listDirectories?: (directory: string) => string[];
}

/** Search locations only; existence or executability is established separately. */
export function wellKnownUserToolchainBins(options: ToolchainPathOptions): string[] {
  const { home, env, platform } = options;
  const list = options.listDirectories ?? ((directory: string) => {
    try { return readdirSync(directory, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); }
    catch { return []; }
  });
  const pathApi = platform === "win32" ? win32 : { isAbsolute, join };
  const j = pathApi.join;
  const paths: string[] = [];
  const add = (path: string | undefined): void => { if (path && pathApi.isAbsolute(path) && !paths.includes(path)) paths.push(path); };
  const versioned = (root: string, suffix = "bin"): void => {
    const versions = list(root).filter((entry) => /^v?\d+(?:\.\d+)*$/.test(entry));
    versions.sort((a, b) => {
      const aa = a.replace(/^v/, "").split(".").map(Number);
      const bb = b.replace(/^v/, "").split(".").map(Number);
      for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        const difference = (bb[i] ?? 0) - (aa[i] ?? 0);
        if (difference !== 0) return difference;
      }
      return a.localeCompare(b);
    });
    for (const version of versions) add(j(root, version, suffix));
  };
  const npmPrefix = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix;
  add(npmPrefix && j(npmPrefix, "bin"));
  if (platform === "win32") { add(npmPrefix); add(j(home, "AppData/Roaming/npm")); add(j(home, "scoop/shims")); add(env.APPDATA && j(env.APPDATA, "npm")); }
  add(env.PNPM_HOME);
  add(env.BUN_INSTALL && j(env.BUN_INSTALL, "bin"));
  add(env.CARGO_HOME && j(env.CARGO_HOME, "bin"));
  add(env.DENO_INSTALL && j(env.DENO_INSTALL, "bin"));
  add(env.GOPATH && j(env.GOPATH.split(delimiter)[0]!, "bin"));
  add(env.PYENV_ROOT && j(env.PYENV_ROOT, "shims"));
  for (const path of [".local/bin", ".opencode/bin", ".npm-global/bin", ".npm-packages/bin", ".bun/bin", ".cargo/bin", ".deno/bin", "go/bin", ".pyenv/shims", ".asdf/shims", ".volta/bin", ".local/share/mise/shims", ".local/share/mise/bin", ".mise/shims", ".nix-profile/bin", ".fnm", "Library/pnpm"]) add(j(home, path));
  add(env.ASDF_DATA_DIR && j(env.ASDF_DATA_DIR, "shims"));
  add(env.VOLTA_HOME && j(env.VOLTA_HOME, "bin"));
  add(env.MISE_DATA_DIR && j(env.MISE_DATA_DIR, "shims"));
  versioned(j(env.NVM_DIR ?? j(home, ".nvm"), "versions/node"));
  versioned(j(env.FNM_DIR ?? j(home, ".local/share/fnm"), "node-versions"), platform === "win32" ? "installation" : "installation/bin");
  versioned(j(home, ".fnm/node-versions"), "installation/bin");
  versioned(j(env.ASDF_DATA_DIR ?? j(home, ".asdf"), "installs/nodejs"));
  versioned(j(env.MISE_DATA_DIR ?? j(home, ".local/share/mise"), "installs/node"));
  if (platform !== "win32") { add("/opt/homebrew/bin"); add("/usr/local/bin"); }
  return paths;
}

/** Inherited absolute PATH entries have priority over additional toolchains. */
export function toolchainPath(options: ToolchainPathOptions): string {
  const separator = options.platform === "win32" ? ";" : ":";
  const entries = (options.env.PATH ?? options.env.Path ?? "").split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => (options.platform === "win32" ? win32.isAbsolute(entry) : isAbsolute(entry)));
  return [...new Set([...entries, ...wellKnownUserToolchainBins(options)])].join(separator);
}
