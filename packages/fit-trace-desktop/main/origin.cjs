"use strict";
const fs = require("node:fs");
const path = require("node:path");
function parseOrigin(value) {
  if (typeof value !== "string") throw new Error("Invalid saved desktop origin.");
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]*)$/.exec(value);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid saved desktop origin.");
  return port;
}
function loadOrigin(dir) {
  try { return parseOrigin(JSON.parse(fs.readFileSync(path.join(dir, "desktop-origin.json"), "utf8")).origin); }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}
function saveOrigin(dir, origin) {
  parseOrigin(origin);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "desktop-origin.json");
  const temp = `${target}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, `${JSON.stringify({ origin })}\n`, { mode: 0o600 }); fs.renameSync(temp, target); }
  finally { fs.rmSync(temp, { force: true }); }
}
module.exports = { parseOrigin, loadOrigin, saveOrigin };
