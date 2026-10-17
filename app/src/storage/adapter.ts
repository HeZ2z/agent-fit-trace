/**
 * Framework-agnostic key/value storage abstraction.
 *
 * The app data layer only knows about this interface, so it can run against
 * `localStorage` in the browser and an in-memory map in tests. All operations
 * are synchronous, matching the `localStorage` API.
 */
export interface StorageAdapter {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  /** All stored keys starting with `prefix`, in unspecified order. */
  keys(prefix: string): string[];
}

/** Thrown when a write is attempted but no backing storage is available. */
export class StorageUnavailableError extends Error {
  constructor(message = "No storage backend is available; cannot persist workouts.") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

function resolveGlobalStorage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    return candidate ?? null;
  } catch {
    // Accessing localStorage can throw (e.g. blocked cookies / opaque origins).
    return null;
  }
}

/**
 * `localStorage`-backed adapter.
 *
 * A missing or blocked `localStorage` is never mistaken for "no data": reads
 * throw a readable {@link StorageUnavailableError}, so a failed read cannot be
 * interpreted as an empty store and silently overwrite existing records. `null`
 * is reserved for a genuinely absent key. Writes and removes throw rather than
 * silently dropping data; a remove is only reported successful after the key
 * is verified gone, so a browser/plugin no-op cannot fake a deletion.
 */
export class LocalStorageAdapter implements StorageAdapter {
  storage: Storage | null;

  constructor(storage: Storage | null = resolveGlobalStorage()) {
    this.storage = storage;
  }

  read(key: string): string | null {
    if (this.storage === null) {
      throw new StorageUnavailableError("No storage backend is available; cannot read workouts.");
    }
    try {
      return this.storage.getItem(key);
    } catch {
      throw new StorageUnavailableError("Unable to read workout storage.");
    }
  }

  write(key: string, value: string): void {
    if (this.storage === null) {
      throw new StorageUnavailableError();
    }
    try {
      this.storage.setItem(key, value);
    } catch {
      throw new StorageUnavailableError("Unable to write workout storage.");
    }
  }

  remove(key: string): void {
    if (this.storage === null) {
      throw new StorageUnavailableError(
        "No storage backend is available; cannot remove workout data.",
      );
    }
    try {
      this.storage.removeItem(key);
      if (this.storage.getItem(key) !== null) {
        throw new StorageUnavailableError("Storage removal was ignored.");
      }
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error;
      throw new StorageUnavailableError("Unable to remove workout storage.");
    }
  }

  keys(prefix: string): string[] {
    if (this.storage === null) {
      throw new StorageUnavailableError(
        "No storage backend is available; cannot enumerate workouts.",
      );
    }
    try {
      const matches: string[] = [];
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (key !== null && key.startsWith(prefix)) matches.push(key);
      }
      return matches;
    } catch {
      throw new StorageUnavailableError("Unable to enumerate workout storage.");
    }
  }
}

/** In-memory adapter for tests and non-browser environments. */
export class MemoryStorageAdapter implements StorageAdapter {
  private data = new Map<string, string>();

  read(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.data.set(key, value);
  }

  remove(key: string): void {
    this.data.delete(key);
  }

  keys(prefix: string): string[] {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix));
  }
}
