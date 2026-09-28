import { describe, it } from "vitest";
import { MemoryStorageAdapter } from "../storage/adapter.ts";
import { LocalFitTraceClient } from "./localFitTraceClient.ts";
import { runFitTraceClientContractSuite } from "@pi-fit-trace/api-contracts/testing";

/**
 * The local client must satisfy the shared FitTraceClient contract suite.
 * A fresh in-memory adapter per test keeps each case isolated.
 */

describe("LocalFitTraceClient contract", () => {
  runFitTraceClientContractSuite(
    "LocalFitTraceClient",
    (name, fn) => it(name, fn),
    () => new LocalFitTraceClient(new MemoryStorageAdapter()),
  );
});
