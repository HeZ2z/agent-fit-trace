import { describe, expect, it } from "vitest";
import { LocalStorageAdapter, MemoryStorageAdapter, StorageUnavailableError } from "./adapter.ts";

/** Minimal working `Storage` backed by a Map. */
function mapStorage(map = new Map<string, string>()): Storage {
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

/** `Storage` whose `getItem` throws, as when a browser blocks storage. */
function blockedStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear: () => {},
    getItem: () => {
      throw new Error("blocked by browser privacy policy");
    },
    key: () => null,
    removeItem: () => {},
    setItem: () => {},
  } as Storage;
}

/** `Storage` whose enumeration throws, as when a browser blocks storage. */
function blockedEnumerationStorage(): Storage {
  return {
    get length(): number {
      throw new Error("blocked by browser privacy policy");
    },
    clear: () => {},
    getItem: () => null,
    key: () => null,
    removeItem: () => {},
    setItem: () => {},
  } as Storage;
}

/** `Storage` whose writes throw a quota error, as when the quota is full. */
function quotaStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear: () => {},
    getItem: () => null,
    key: () => null,
    removeItem: () => {},
    setItem: () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    },
  } as Storage;
}

/** `Storage` whose removes throw, as when storage is blocked mid-session. */
function throwingRemoveStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear: () => {},
    getItem: () => null,
    key: () => null,
    removeItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {},
  } as Storage;
}

/** `Storage` whose remove silently does nothing but keeps reporting the key. */
function noOpRemoveStorage(): Storage {
  const map = new Map<string, string>([["k", "v"]]);
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: () => {},
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

describe("LocalStorageAdapter", () => {
  it("returns null only for a genuinely absent key", () => {
    const adapter = new LocalStorageAdapter(mapStorage());
    expect(adapter.read("missing")).toBeNull();
  });

  it("round-trips write, read, and remove", () => {
    const adapter = new LocalStorageAdapter(mapStorage());
    adapter.write("k", "v");
    expect(adapter.read("k")).toBe("v");

    adapter.remove("k");
    expect(adapter.read("k")).toBeNull();
  });

  it("throws StorageUnavailableError when there is no storage backend", () => {
    const adapter = new LocalStorageAdapter(null);
    expect(() => adapter.read("k")).toThrow(StorageUnavailableError);
    expect(() => adapter.keys("p:")).toThrow(StorageUnavailableError);
    expect(() => adapter.remove("k")).toThrow(StorageUnavailableError);
  });

  it("throws StorageUnavailableError when getItem fails", () => {
    const adapter = new LocalStorageAdapter(blockedStorage());
    expect(() => adapter.read("k")).toThrow(StorageUnavailableError);
  });

  it("throws StorageUnavailableError when a write hits the quota", () => {
    const adapter = new LocalStorageAdapter(quotaStorage());
    expect(() => adapter.write("k", "v")).toThrow(StorageUnavailableError);
  });

  it("throws StorageUnavailableError when removeItem fails", () => {
    const adapter = new LocalStorageAdapter(throwingRemoveStorage());
    expect(() => adapter.remove("k")).toThrow(StorageUnavailableError);
  });

  it("detects a silent no-op remove", () => {
    const storage = noOpRemoveStorage();
    const adapter = new LocalStorageAdapter(storage);
    expect(adapter.read("k")).toBe("v");
    expect(() => adapter.remove("k")).toThrow(StorageUnavailableError);
  });

  it("throws StorageUnavailableError when enumeration fails", () => {
    const adapter = new LocalStorageAdapter(blockedEnumerationStorage());
    expect(() => adapter.keys("p:")).toThrow(StorageUnavailableError);
  });

  it("returns only keys matching the prefix", () => {
    const adapter = new LocalStorageAdapter(mapStorage());
    adapter.write("p:one", "1");
    adapter.write("p:two", "2");
    adapter.write("other:three", "3");

    expect(adapter.keys("p:").sort()).toEqual(["p:one", "p:two"]);
    expect(adapter.keys("other:")).toEqual(["other:three"]);
    expect(adapter.keys("nope:")).toEqual([]);
  });
});

describe("MemoryStorageAdapter", () => {
  it("returns null for an absent key and round-trips values", () => {
    const adapter = new MemoryStorageAdapter();
    expect(adapter.read("k")).toBeNull();

    adapter.write("k", "v");
    expect(adapter.read("k")).toBe("v");

    adapter.remove("k");
    expect(adapter.read("k")).toBeNull();
  });

  it("returns only keys matching the prefix", () => {
    const adapter = new MemoryStorageAdapter();
    adapter.write("p:one", "1");
    adapter.write("p:two", "2");
    adapter.write("other:three", "3");

    expect(adapter.keys("p:").sort()).toEqual(["p:one", "p:two"]);
    expect(adapter.keys("nope:")).toEqual([]);
  });
});
