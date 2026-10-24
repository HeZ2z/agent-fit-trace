import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FitTraceError, ValidationError } from "@agent-fit-trace/core";

/**
 * Per-identity store resolution: which `.db` file a process should open.
 * Pure path/identity logic with injected filesystem dependencies (same style
 * as `packages/fit-trace-mcp/src/config.ts`), so it is unit-testable without
 * touching a real data directory.
 */

export const IDENTITY_SCHEMA_VERSION = 1;

/** The default principal for a first run, before any identity is recorded. */
export const GUEST_PRINCIPAL = "guest";

export interface IdentityFile {
  schema_version: number;
  active_principal: string;
}

/**
 * Principal names become filenames (`<principal>.db`), so they are restricted
 * to a safe charset — anything else is rejected before it can escape the data
 * directory via path traversal.
 */
const PRINCIPAL_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertValidPrincipal(principal: string): void {
  if (!PRINCIPAL_PATTERN.test(principal)) {
    throw new ValidationError(
      `Invalid principal "${principal}": principals may only contain [A-Za-z0-9._-].`,
    );
  }
}

/** Treat `undefined` and blank strings the same way, matching the repo's override convention. */
function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

export function identityFilePath(dataDir: string): string {
  return join(dataDir, "identity.json");
}

/**
 * Data directory precedence: `FIT_TRACE_DATA_DIR` > `$HOME/.fit-trace/data`.
 * The home directory is injectable for tests.
 */
export function resolveDataDir(
  env: Record<string, string | undefined>,
  homeDir: string = homedir(),
): string {
  const override = nonBlank(env.FIT_TRACE_DATA_DIR);
  if (override !== undefined) return override;
  return join(homeDir, ".fit-trace", "data");
}

/** Per-identity database file: `<dataDir>/<principal>.db`. */
export function principalDbPath(dataDir: string, principal: string): string {
  assertValidPrincipal(principal);
  return join(dataDir, `${principal}.db`);
}

/**
 * Read an identity file; `null` when it does not exist (first run). A present
 * but malformed file throws rather than falling back to a default principal.
 */
export async function readIdentity(filePath: string): Promise<IdentityFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: Partial<IdentityFile> | null;
  try {
    parsed = JSON.parse(raw) as Partial<IdentityFile> | null;
  } catch {
    throw new ValidationError(`Identity file ${filePath} contains invalid JSON.`);
  }
  if (
    !parsed ||
    parsed.schema_version !== IDENTITY_SCHEMA_VERSION ||
    typeof parsed.active_principal !== "string"
  ) {
    throw new ValidationError(
      `Identity file ${filePath} must be { schema_version: ${IDENTITY_SCHEMA_VERSION}, active_principal: string }.`,
    );
  }
  return parsed as IdentityFile;
}

/** Atomically record the active principal (temp file + rename, like the JSON store). */
export async function writeIdentity(filePath: string, activePrincipal: string): Promise<void> {
  assertValidPrincipal(activePrincipal);
  const file: IdentityFile = {
    schema_version: IDENTITY_SCHEMA_VERSION,
    active_principal: activePrincipal,
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

/** Raised when identity.json names a principal whose database file is missing. */
export class StaleIdentityError extends FitTraceError {
  constructor(identityPath: string, missingDbPath: string) {
    super(
      "STALE_IDENTITY",
      `Identity file ${identityPath} names a principal whose database ${missingDbPath} does not exist. ` +
        "Override with --principal <name> or FIT_TRACE_PRINCIPAL to select another principal, " +
        "or --store <path> to bypass identity resolution entirely.",
      { identity_path: identityPath, missing_db_path: missingDbPath },
    );
    this.name = "StaleIdentityError";
  }
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveActiveStoreOptions {
  /** Explicit store path override (`--store`); highest priority, bypasses principal resolution. */
  storePath?: string;
  /** Explicit principal (flag or already-extracted); overrides identity.json. */
  principal?: string;
  env: Record<string, string | undefined>;
  dataDir: string;
  readIdentity?: (filePath: string) => Promise<IdentityFile | null>;
  fileExists?: (filePath: string) => Promise<boolean>;
}

/**
 * Store resolution precedence:
 *
 * 1. `storePath` — an explicit absolute path wins and skips principal handling.
 * 2. `principal` argument or `FIT_TRACE_PRINCIPAL` — the named db is used (and
 *    created on first run, so a brand-new principal can bootstrap).
 * 3. `identity.json`'s `active_principal` — the db file must already exist; a
 *    recorded principal with a missing db throws {@link StaleIdentityError}
 *    instead of silently falling back to guest.
 * 4. No `identity.json` (first run) — the guest db.
 */
export async function resolveActiveStore(options: ResolveActiveStoreOptions): Promise<string> {
  const {
    storePath,
    principal,
    env,
    dataDir,
    readIdentity: readIdentityImpl = readIdentity,
    fileExists: fileExistsImpl = defaultFileExists,
  } = options;

  const explicitStore = nonBlank(storePath);
  if (explicitStore !== undefined) return explicitStore;

  const explicitPrincipal = nonBlank(principal) ?? nonBlank(env.FIT_TRACE_PRINCIPAL);
  if (explicitPrincipal !== undefined) {
    return principalDbPath(dataDir, explicitPrincipal);
  }

  const identityPath = identityFilePath(dataDir);
  const identity = await readIdentityImpl(identityPath);
  if (identity === null) {
    return principalDbPath(dataDir, GUEST_PRINCIPAL);
  }

  const dbPath = principalDbPath(dataDir, identity.active_principal);
  if (!(await fileExistsImpl(dbPath))) {
    throw new StaleIdentityError(identityPath, dbPath);
  }
  return dbPath;
}
