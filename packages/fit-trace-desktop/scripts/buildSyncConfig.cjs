"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { disabledSyncConfig, resolveBuildSyncConfig } = require("../main/syncConfig.cjs");

/** Overwrite any previously enabled staging config before validating new inputs. */
function writeBuildSyncConfig(output, env) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(disabledSyncConfig(), null, 2)}\n`);
  const config = resolveBuildSyncConfig(env);
  fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

if (require.main === module) {
  writeBuildSyncConfig(path.join(__dirname, "..", "staging", "desktop-sync-config.json"), process.env);
}
module.exports = { writeBuildSyncConfig };
