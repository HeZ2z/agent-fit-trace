import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  ConflictError,
  CorruptStoreError,
  ValidationError,
  sortRecords,
  stableStringify,
  validateWorkoutRecord,
} from "@agent-fit-trace/core";
import type { HistoryFilter, WorkoutRecord } from "@agent-fit-trace/core";
import { filterRecordsPage } from "./filter.ts";
import type { QueryResult } from "./filter.ts";

export interface StoreFile {
  schema_version: number;
  records: WorkoutRecord[];
}

export interface StorageAdapter {
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
}

/** Atomic local JSON storage: write to a temp file, then rename into place. */
export class JsonFileStorage implements StorageAdapter {
  filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async read(): Promise<string | null> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(data: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, data, "utf8");
    await rename(tempPath, this.filePath);
  }
}

/** In-memory adapter used by tests and dry runs. */
export class MemoryStorage implements StorageAdapter {
  data: string | null = null;

  async read(): Promise<string | null> {
    return this.data;
  }

  async write(data: string): Promise<void> {
    this.data = data;
  }
}

export type { QueryResult } from "./filter.ts";
export { filterRecordsPage } from "./filter.ts";

/**
 * Append-only, idempotent workout store.
 *
 * Idempotency contract: importing a record whose `id` already exists is a no-op
 * when the stored content is identical (the App may safely retry), and a
 * {@link ConflictError} when the content differs (silently overwriting would
 * mutate an original workout record).
 */
export class WorkoutStore {
  storage: StorageAdapter;
  queue: Promise<unknown> = Promise.resolve();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  /** Serialize read-modify-write cycles so concurrent imports cannot clobber each other. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async load(): Promise<StoreFile> {
    const raw = await this.storage.read();
    if (raw === null || raw.trim() === "") {
      return { schema_version: CURRENT_SCHEMA_VERSION, records: [] };
    }
    let parsed: Partial<StoreFile>;
    try {
      parsed = JSON.parse(raw) as Partial<StoreFile>;
    } catch {
      throw new CorruptStoreError(-1, "store contains invalid JSON");
    }
    if (!parsed || !Array.isArray(parsed.records)) {
      throw new CorruptStoreError(-1, "`records` must be an array");
    }

    // Re-validate on load: a hand-edited or outdated file must fail loudly with
    // a readable error rather than surfacing as misleading analysis results.
    const records = parsed.records.map((entry, index) => {
      try {
        return validateWorkoutRecord(entry).record;
      } catch (error) {
        const reason =
          error instanceof ValidationError
            ? error.issues.map((issue) => issue.message).join("; ")
            : error instanceof Error
              ? error.message
              : String(error);
        throw new CorruptStoreError(index, reason);
      }
    });

    return {
      schema_version: parsed.schema_version ?? CURRENT_SCHEMA_VERSION,
      records,
    };
  }

  async all(): Promise<WorkoutRecord[]> {
    return (await this.load()).records;
  }

  async import(record: WorkoutRecord): Promise<{ duplicate: boolean; total: number }> {
    return this.runExclusive(async () => {
      const file = await this.load();
      const existing = file.records.find((entry) => entry.id === record.id);

      if (existing) {
        if (stableStringify(existing) === stableStringify(record)) {
          return { duplicate: true, total: file.records.length };
        }
        throw new ConflictError(record.id);
      }

      file.records = sortRecords([...file.records, record]);
      file.schema_version = CURRENT_SCHEMA_VERSION;
      await this.storage.write(`${JSON.stringify(file, null, 2)}\n`);
      return { duplicate: false, total: file.records.length };
    });
  }

  async query(filter: HistoryFilter = {}): Promise<QueryResult> {
    return filterRecordsPage(sortRecords(await this.all()), filter);
  }
}

export { SqliteWorkoutStore } from "./sqlite.ts";
export {
  GUEST_PRINCIPAL,
  IDENTITY_SCHEMA_VERSION,
  StaleIdentityError,
  identityFilePath,
  principalDbPath,
  readIdentity,
  resolveActiveStore,
  resolveDataDir,
  writeIdentity,
} from "./identity.ts";
export type { IdentityFile, ResolveActiveStoreOptions } from "./identity.ts";
