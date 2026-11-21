/**
 * Chrome launch/discovery for the acceptance harness.
 *
 * Starts the system Chrome with a private profile and `--remote-debugging-port=0`
 * (the OS picks a free port), then reads `DevToolsActivePort` from the profile
 * directory to connect. No browser automation dependency is used.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverChrome } from "./helpers.ts";
import { stopOwnedProcess } from "./daemon.ts";

export interface LaunchedChrome {
  child: ChildProcess;
  userDataDir: string;
  port: number;
  browserWebSocketUrl: string;
  logs: string[];
}

export interface ChromeLaunchOptions {
  chromePath: string;
  userDataDir: string;
  headed: boolean;
  width: number;
  height: number;
  timeoutMs: number;
}

/** Resolve the system Chrome with the documented precedence. */
export function findChrome(): string | null {
  return discoverChrome({
    env: process.env,
    platform: process.platform,
    exists: (candidate) => existsSync(candidate),
    which: (command) => {
      try {
        const located = execFileSync("which", [command], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return located === "" ? null : located;
      } catch {
        return null;
      }
    },
  });
}

function tail(text: string, lines = 20): string {
  const all = text.split(/\r?\n/).filter((line) => line !== "");
  return all.slice(-lines).join("\n");
}

/**
 * Launch Chrome and resolve once the DevTools endpoint is discoverable.
 *
 * `--remote-allow-origins=*` is required for a Node WebSocket client on recent
 * Chrome versions; the browser is loopback-only and short-lived.
 */
export async function launchChrome(options: ChromeLaunchOptions): Promise<LaunchedChrome> {
  await mkdir(options.userDataDir, { recursive: true });
  const args = [
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-gpu",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-dev-shm-usage",
    `--window-size=${options.width},${options.height}`,
    ...(options.headed ? [] : ["--headless=new"]),
    "about:blank",
  ];

  const child = spawn(options.chromePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout?.on("data", (chunk: unknown) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk: unknown) => logs.push(String(chunk)));

  const processState: { exited: boolean; spawnError: string | null } = {
    exited: false,
    spawnError: null,
  };
  child.once("exit", () => {
    processState.exited = true;
  });
  child.once("error", (error: Error) => {
    processState.spawnError = error.message;
    processState.exited = true;
  });

  const portFile = path.join(options.userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + options.timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (processState.exited) {
      const detail = processState.spawnError === null ? "" : ` (${processState.spawnError})`;
      throw new Error(
        `Chrome exited before publishing DevToolsActivePort${detail}.\n${tail(logs.join(""), 20)}`,
      );
    }
    try {
      const content = await readFile(portFile, "utf8");
      const lines = content.split(/\r?\n/).filter((line) => line !== "");
      const port = Number(lines[0]);
      const browserPath = lines[1];
      if (
        Number.isSafeInteger(port) &&
        port > 0 &&
        port <= 65535 &&
        browserPath !== undefined &&
        browserPath.startsWith("/devtools/")
      ) {
        return {
          child,
          userDataDir: options.userDataDir,
          port,
          browserWebSocketUrl: `ws://127.0.0.1:${port}${browserPath}`,
          logs,
        };
      }
      lastError = `unexpected DevToolsActivePort content: ${JSON.stringify(content)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }

  await stopOwnedProcess(child);
  throw new Error(
    `Chrome did not publish DevToolsActivePort within ${options.timeoutMs}ms (${lastError}).\n` +
      tail(logs.join(""), 20),
  );
}

/** Stop only the Chrome process this harness launched. */
export function stopLaunchedChrome(chrome: LaunchedChrome | null): Promise<void> {
  if (chrome === null) return Promise.resolve();
  return stopOwnedProcess(chrome.child);
}
