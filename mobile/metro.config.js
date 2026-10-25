// Metro config for the pnpm workspace.
//
// `mobile/` is workspace package `@agent-fit-trace/mobile`. pnpm links shared
// dependencies from the repository-root `node_modules`, and the workspace
// packages (`@agent-fit-trace/*`) resolve to `../packages/*`.
//
// Metro's default workspace detection watches the whole repository root, which
// includes `node_modules/.pnpm` — it contains `.ignored_*` directories and
// symlink chains that crash the file map (TreeFS: "Failed to make parent
// directory entry"). So we watch only what is needed: `mobile/` and the shared
// packages, and resolve modules from both node_modules trees.
const path = require("node:path");
const fs = require("node:fs");

const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

const packagesDir = path.resolve(monorepoRoot, "packages");
const sharedPackages = fs.existsSync(packagesDir)
  ? fs
      .readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesDir, entry.name))
  : [];

config.watchFolders = [projectRoot, ...sharedPackages];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

module.exports = config;
