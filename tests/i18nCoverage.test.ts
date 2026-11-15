import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ZH_MESSAGES } from "../packages/fit-trace-i18n/src/index.ts";

/**
 * Coverage guard for the render-time Chinese display layer.
 *
 * The runtime dictionary is keyed by the exact English source string, and a
 * missing entry silently falls back to English. That is the right runtime
 * behavior, but it lets a new screen ship untranslated without any test
 * failing. This test reads the two client sources and requires:
 *
 * 1. every `t("…")` call with a literal source has a dictionary entry, and
 * 2. no JSX text renders raw English copy instead of going through `t()`.
 *
 * The dictionary package itself stays browser-safe; only this root test uses
 * the filesystem and the TypeScript parser.
 */

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOTS = ["app/src", "mobile/src"];

/**
 * Intentional Latin-script UI text that is not interface copy: the product
 * wordmark, the launcher command shown as code, and the compact mobile
 * wordmark.
 */
const ALLOWED_JSX_TEXT = new Set(["FIT TRACE", "FT", "agent-fit-trace start"]);

interface Found<T> {
  file: string;
  line: number;
  value: T;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    files.push(path);
  }
  return files;
}

function parse(file: string): import("typescript").SourceFile {
  const source = readFileSync(join(ROOT, file), "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(sourceFile: import("typescript").SourceFile, node: import("typescript").Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Literal first arguments of `t(…)` calls, including no-substitution templates. */
function literalTranslateKeys(file: string): Found<string>[] {
  const sourceFile = parse(file);
  const keys: Found<string>[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const argument = node.arguments[0];
      if (argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        keys.push({ file, line: lineOf(sourceFile, argument), value: argument.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

/** JSX text nodes that still contain English words. */
function untranslatedJsxText(file: string): Found<string>[] {
  if (!file.endsWith(".tsx")) return [];
  const sourceFile = parse(file);
  const nodes: Found<string>[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
      if (/[A-Za-z]{2}/.test(text) && !ALLOWED_JSX_TEXT.has(text)) {
        nodes.push({ file, line: lineOf(sourceFile, node), value: text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

test("every literal t() source has a Chinese dictionary entry", () => {
  const missing: Found<string>[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(root)) {
      for (const key of literalTranslateKeys(file)) {
        if (!(key.value in ZH_MESSAGES)) missing.push(key);
      }
    }
  }
  assert.deepEqual(
    missing.map(({ file, line, value }) => `${relative(ROOT, file)}:${line} ${JSON.stringify(value)}`),
    [],
    "Add these English sources to a slice under packages/fit-trace-i18n/src/zh/",
  );
});

test("JSX shows interface copy through t(), not raw English", () => {
  const raw: Found<string>[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(root)) {
      for (const node of untranslatedJsxText(file)) raw.push(node);
    }
  }
  assert.deepEqual(
    raw.map(({ file, line, value }) => `${relative(ROOT, file)}:${line} ${JSON.stringify(value)}`),
    [],
    "Wrap visible copy in t(); add intentional Latin text to ALLOWED_JSX_TEXT",
  );
});
