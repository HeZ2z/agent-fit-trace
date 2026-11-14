/**
 * Device-local cloud destination setting (#87).
 *
 * A user may point cloud coaching at a custom hosted Fit Trace deployment.
 * Three boundaries live here rather than in the renderer:
 *
 * - the destination is canonical (`https://host/api/v1`) and a stored file that
 *   is malformed fails closed instead of silently falling back to the official
 *   build default;
 * - consent is explicit, per principal, and bound to the canonical destination
 *   and the current account-service issuer; changing the destination clears
 *   every consent;
 * - a candidate must prove it uses the same account service before it can be
 *   saved, so a user cannot hand their bearer to an unrelated identity system.
 *
 * The official destination stays an operator/build decision. A user setting
 * overrides it; resetting removes the file and falls back to it.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  CloudDestinationCheck,
  CloudDestinationConsent,
  CloudDestinationStatus,
} from "@agent-fit-trace/api-contracts";
import type { CloudProxyDestinationDecision } from "./cloudProxy.ts";

export const CLOUD_DESTINATION_SCHEMA_VERSION = 1;

/** The public API base every hosted Fit Trace deployment mounts. */
const CLOUD_API_BASE_PATH = "/api/v1";

export type CloudDestinationSettingErrorCode =
  | "CLOUD_DESTINATION_INVALID"
  | "CLOUD_DESTINATION_UNCONFIGURED"
  | "CLOUD_DESTINATION_CONFIRMATION_REQUIRED"
  | "CLOUD_DESTINATION_ISSUER_UNVERIFIED"
  | "CLOUD_DESTINATION_ISSUER_INCOMPATIBLE"
  | "CLOUD_DESTINATION_UNREACHABLE"
  | "CLOUD_DISABLED";

export class CloudDestinationSettingError extends Error {
  readonly code: CloudDestinationSettingErrorCode;
  readonly status: number;

  constructor(code: CloudDestinationSettingErrorCode, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "CloudDestinationSettingError";
  }
}

export class CloudDestinationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudDestinationFileError";
  }
}

export interface CloudDestinationConsentRecord {
  destination: string;
  issuer: string;
  approvedAt: string;
}

export interface StoredCloudDestination {
  schema_version: typeof CLOUD_DESTINATION_SCHEMA_VERSION;
  destination: string;
  consents: Record<string, CloudDestinationConsentRecord>;
}

/** Probe a destination for the account-service issuer it publishes. */
export type ProbeCloudDestinationIssuer = (destination: URL) => Promise<string | null>;

export interface CloudDestinationStoreOptions {
  dataDir: string;
  /** Operator/build default. `null` means unset or invalid. */
  officialDestination: URL | null;
  /**
   * Non-null when the official environment variable was present but invalid.
   * A user setting still wins; otherwise the state fails closed.
   */
  officialError: string | null;
  /** This daemon's configured account-service issuer (normalized), or null. */
  issuer: string | null;
  probe: ProbeCloudDestinationIssuer;
  /**
   * TEST-ONLY: allow a plain-HTTP loopback destination so the integration
   * suite can use a local upstream. Production never sets this.
   */
  allowInsecureLoopback?: boolean;
}

type StoreState =
  | { kind: "unset" }
  | { kind: "official"; destination: URL }
  | { kind: "user"; destination: URL; consents: Map<string, CloudDestinationConsentRecord> }
  | { kind: "invalid"; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

/**
 * Canonicalize a user-entered destination. The accepted form is an HTTPS URL
 * whose path is exactly `/api/v1`; one trailing slash is tolerated and removed.
 * Credentials, query strings and fragments are refused because they cannot be
 * part of a canonical API base.
 */
export function normalizeCloudDestinationInput(
  raw: string,
  options: { allowInsecureLoopback?: boolean } = {},
): URL {
  if (!isNonBlank(raw)) {
    throw new CloudDestinationSettingError(
      "CLOUD_DESTINATION_INVALID",
      "Enter the hosted server API base, for example https://coach.example.com/api/v1.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new CloudDestinationSettingError(
      "CLOUD_DESTINATION_INVALID",
      "The cloud server address is not a valid URL. Enter an API base such as https://coach.example.com/api/v1.",
    );
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new CloudDestinationSettingError(
      "CLOUD_DESTINATION_INVALID",
      "The cloud server address must not contain credentials, a query string or a fragment.",
    );
  }
  if (parsed.protocol !== "https:") {
    if (!(options.allowInsecureLoopback === true && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
      throw new CloudDestinationSettingError(
        "CLOUD_DESTINATION_INVALID",
        "The cloud server must use HTTPS. Plain HTTP is not accepted because a bearer token would cross the network unencrypted.",
      );
    }
  }
  if (parsed.hostname === "") {
    throw new CloudDestinationSettingError("CLOUD_DESTINATION_INVALID", "The cloud server address has no host.");
  }
  const path = parsed.pathname === `${CLOUD_API_BASE_PATH}/` ? CLOUD_API_BASE_PATH : parsed.pathname;
  if (path !== CLOUD_API_BASE_PATH) {
    throw new CloudDestinationSettingError(
      "CLOUD_DESTINATION_INVALID",
      "The cloud server address must end in /api/v1, for example https://coach.example.com/api/v1.",
    );
  }
  return new URL(`${parsed.origin}${CLOUD_API_BASE_PATH}`);
}

/** Canonical URL string used by the stored setting and run binding. */
export function canonicalCloudDestination(destination: URL): string {
  return `${destination.origin}${CLOUD_API_BASE_PATH}`;
}

/** The confirmation name for a destination: host plus a non-default port. */
export function cloudDestinationHost(destination: URL): string {
  return destination.host;
}

/**
 * Stable opaque id of the effective destination + account service.
 *
 * It is not a secret and not an authorization token: the proxy still checks the
 * principal's destination consent on every request. The id lets a client prove
 * that a run-scoped request belongs to the destination it started against, so
 * a destination change cannot silently redirect an established run.
 */
export function cloudDestinationBinding(
  source: "official" | "user",
  destination: URL,
  issuer: string | null,
): string {
  return createHash("sha256")
    .update(`${source}\n${canonicalCloudDestination(destination)}\n${issuer ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/** Normalize an account-service URL for issuer comparison. */
export function normalizeCloudIssuer(raw: string | null | undefined): string | null {
  if (!isNonBlank(raw)) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

export function cloudDestinationFilePath(dataDir: string): string {
  return join(dataDir, "cloud-destination.json");
}

function parseStoredConsent(
  principalId: string,
  value: unknown,
  destination: string,
): CloudDestinationConsentRecord {
  if (!isObject(value)) {
    throw new CloudDestinationFileError(`Consent for ${principalId} must be an object.`);
  }
  if (!isNonBlank(value.destination) || value.destination !== destination) {
    throw new CloudDestinationFileError(
      `Consent for ${principalId} is not bound to the stored destination.`,
    );
  }
  if (!isNonBlank(value.issuer)) {
    throw new CloudDestinationFileError(`Consent for ${principalId} has no issuer.`);
  }
  if (!isNonBlank(value.approvedAt)) {
    throw new CloudDestinationFileError(`Consent for ${principalId} has no approval time.`);
  }
  return { destination: value.destination, issuer: value.issuer.trim(), approvedAt: value.approvedAt };
}

/** Parse a stored file strictly; a malformed file must not be treated as unset. */
export function parseStoredCloudDestination(
  raw: string,
  options: { allowInsecureLoopback?: boolean } = {},
): StoredCloudDestination {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CloudDestinationFileError("cloud-destination.json is not valid JSON.");
  }
  if (!isObject(parsed)) {
    throw new CloudDestinationFileError("cloud-destination.json must contain an object.");
  }
  if (parsed.schema_version !== CLOUD_DESTINATION_SCHEMA_VERSION) {
    throw new CloudDestinationFileError(
      `cloud-destination.json must use schema_version ${CLOUD_DESTINATION_SCHEMA_VERSION}.`,
    );
  }
  if (!isNonBlank(parsed.destination)) {
    throw new CloudDestinationFileError("cloud-destination.json has no destination.");
  }
  let destination: URL;
  try {
    destination = normalizeCloudDestinationInput(parsed.destination, options);
  } catch {
    throw new CloudDestinationFileError("cloud-destination.json has an invalid destination.");
  }
  if (canonicalCloudDestination(destination) !== parsed.destination) {
    throw new CloudDestinationFileError("cloud-destination.json stores a non-canonical destination.");
  }
  if (!isObject(parsed.consents)) {
    throw new CloudDestinationFileError("cloud-destination.json has no consent record.");
  }
  const consents: Record<string, CloudDestinationConsentRecord> = {};
  for (const [principalId, consent] of Object.entries(parsed.consents)) {
    if (!isNonBlank(principalId)) {
      throw new CloudDestinationFileError("cloud-destination.json has a blank principal id.");
    }
    consents[principalId] = parseStoredConsent(principalId, consent, parsed.destination);
  }
  return {
    schema_version: CLOUD_DESTINATION_SCHEMA_VERSION,
    destination: parsed.destination,
    consents,
  };
}

function serializeStoredCloudDestination(
  destination: URL,
  consents: Map<string, CloudDestinationConsentRecord>,
): StoredCloudDestination {
  const record: Record<string, CloudDestinationConsentRecord> = {};
  for (const [principalId, consent] of consents) record[principalId] = consent;
  return {
    schema_version: CLOUD_DESTINATION_SCHEMA_VERSION,
    destination: canonicalCloudDestination(destination),
    consents: record,
  };
}

export async function readStoredCloudDestination(
  filePath: string,
  options: { allowInsecureLoopback?: boolean } = {},
): Promise<StoredCloudDestination | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseStoredCloudDestination(raw, options);
}

function serializedJson(value: StoredCloudDestination): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Atomic write, like the shared JSON store: temp file + rename. */
export async function writeStoredCloudDestination(
  filePath: string,
  value: StoredCloudDestination,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, serializedJson(value), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Effective destination state for one daemon process.
 *
 * Reads happen once at startup; every mutation updates the in-memory state and
 * the file together, so a request never observes a half-written setting. The
 * store is intentionally not watched for external edits: a hand-edited file is
 * picked up on restart and then fails closed if it is invalid.
 */
export class CloudDestinationStore {
  readonly filePath: string;
  readonly officialDestination: URL | null;
  readonly officialError: string | null;
  readonly issuer: string | null;

  private state: StoreState;
  private readonly probe: ProbeCloudDestinationIssuer;
  private readonly allowInsecureLoopback: boolean;
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(options: CloudDestinationStoreOptions, state: StoreState) {
    this.filePath = cloudDestinationFilePath(options.dataDir);
    this.officialDestination = options.officialDestination;
    this.officialError = options.officialError;
    this.issuer = options.issuer;
    this.probe = options.probe;
    this.allowInsecureLoopback = options.allowInsecureLoopback === true;
    this.state = state;
  }

  static async load(options: CloudDestinationStoreOptions): Promise<CloudDestinationStore> {
    const filePath = cloudDestinationFilePath(options.dataDir);
    let stored: StoredCloudDestination | null = null;
    try {
      stored = await readStoredCloudDestination(filePath, {
        ...(options.allowInsecureLoopback === true ? { allowInsecureLoopback: true } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The cloud destination file is invalid.";
      return new CloudDestinationStore(options, { kind: "invalid", message });
    }
    if (stored !== null) {
      let destination: URL;
      try {
        destination = normalizeCloudDestinationInput(stored.destination, {
          ...(options.allowInsecureLoopback === true ? { allowInsecureLoopback: true } : {}),
        });
      } catch {
        return new CloudDestinationStore(options, {
          kind: "invalid",
          message: "The stored cloud destination is not a valid API base.",
        });
      }
      const consents = new Map<string, CloudDestinationConsentRecord>(
        Object.entries(stored.consents),
      );
      return new CloudDestinationStore(options, { kind: "user", destination, consents });
    }
    if (options.officialError !== null) {
      return new CloudDestinationStore(options, { kind: "invalid", message: options.officialError });
    }
    if (options.officialDestination !== null) {
      return new CloudDestinationStore(options, { kind: "official", destination: options.officialDestination });
    }
    return new CloudDestinationStore(options, { kind: "unset" });
  }

  private consentFor(
    principalId: string,
    destination: URL,
  ): CloudDestinationConsentRecord | null {
    if (this.state.kind !== "user") return null;
    const consent = this.state.consents.get(principalId);
    if (consent === undefined) return null;
    if (consent.destination !== canonicalCloudDestination(destination)) return null;
    if (this.issuer === null || normalizeCloudIssuer(consent.issuer) !== this.issuer) return null;
    return consent;
  }

  private consentState(principalId: string): CloudDestinationConsent {
    if (this.state.kind === "official") return "not-applicable";
    if (this.state.kind !== "user") return "not-applicable";
    return this.consentFor(principalId, this.state.destination) === null ? "required" : "confirmed";
  }

  statusFor(principalId: string): CloudDestinationStatus {
    const officialDestination =
      this.officialDestination === null ? null : canonicalCloudDestination(this.officialDestination);
    if (this.state.kind === "invalid") {
      return {
        source: "invalid",
        destination: null,
        host: null,
        officialDestination,
        issuer: this.issuer,
        binding: null,
        consent: "not-applicable",
        error: { code: "CLOUD_DESTINATION_INVALID", message: this.state.message },
      };
    }
    if (this.state.kind === "unset") {
      return {
        source: "unset",
        destination: null,
        host: null,
        officialDestination,
        issuer: this.issuer,
        binding: null,
        consent: "not-applicable",
      };
    }
    return {
      source: this.state.kind,
      destination: canonicalCloudDestination(this.state.destination),
      host: cloudDestinationHost(this.state.destination),
      officialDestination,
      issuer: this.issuer,
      binding: cloudDestinationBinding(this.state.kind, this.state.destination, this.issuer),
      consent: this.consentState(principalId),
    };
  }

  /**
   * The proxy's destination decision. `unconfirmed` is a refusal, not a
   * warning: the bearer must never leave the daemon for a host this principal
   * has not explicitly approved.
   */
  decisionFor(principalId: string): CloudProxyDestinationDecision {
    if (this.state.kind === "invalid") {
      return {
        status: "invalid",
        code: "CLOUD_DESTINATION_INVALID",
        message: this.state.message,
      };
    }
    if (this.state.kind === "unset") {
      return {
        status: "unconfigured",
        code: "CLOUD_DESTINATION_UNCONFIGURED",
        message: "No cloud server is configured on this daemon. Add one in Coach settings.",
      };
    }
    if (this.state.kind === "official") {
      return {
        status: "ready",
        url: this.state.destination,
        binding: cloudDestinationBinding("official", this.state.destination, this.issuer),
      };
    }
    if (this.consentFor(principalId, this.state.destination) === null) {
      return {
        status: "unconfirmed",
        code: "CLOUD_DESTINATION_CONSENT_REQUIRED",
        message: `This account has not confirmed the custom cloud server at ${cloudDestinationHost(
          this.state.destination,
        )}. Confirm it in Coach settings first.`,
      };
    }
    return {
      status: "ready",
      url: this.state.destination,
      binding: cloudDestinationBinding("user", this.state.destination, this.issuer),
    };
  }

  private assertIssuer(): string {
    if (this.issuer === null) {
      throw new CloudDestinationSettingError(
        "CLOUD_DISABLED",
        "Cloud coaching needs a configured account service on this daemon.",
        503,
      );
    }
    return this.issuer;
  }

  /**
   * Validate a candidate and report whether it could be saved. No state is
   * changed and no bearer or workout data is sent: only the public-config
   * endpoint is read, to prove the destination uses the same account service.
   */
  async check(raw: string): Promise<CloudDestinationCheck> {
    let destination: URL;
    try {
      destination = normalizeCloudDestinationInput(raw, {
        allowInsecureLoopback: this.allowInsecureLoopback,
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "CLOUD_DESTINATION_INVALID",
          message: error instanceof Error ? error.message : "Invalid cloud server address.",
        },
      };
    }
    const issuer = this.issuer;
    if (issuer === null) {
      return {
        ok: false,
        error: {
          code: "CLOUD_DISABLED",
          message: "Cloud coaching needs a configured account service on this daemon.",
        },
      };
    }
    const canonical = canonicalCloudDestination(destination);
    const official =
      this.officialDestination !== null &&
      canonicalCloudDestination(this.officialDestination) === canonical;
    // The approved official destination is already an operator trust decision;
    // a user still has to check it, but it does not need to prove itself.
    if (!official) {
      let destinationIssuer: string | null;
      try {
        destinationIssuer = normalizeCloudIssuer(await this.probe(destination));
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "CLOUD_DESTINATION_UNREACHABLE",
            message:
              error instanceof Error
                ? `The cloud server could not be reached: ${error.message}`
                : "The cloud server could not be reached.",
          },
        };
      }
      if (destinationIssuer === null) {
        return {
          ok: false,
          error: {
            code: "CLOUD_DESTINATION_ISSUER_UNVERIFIED",
            message:
              "The server did not publish a compatible account service at /api/v1/public-config. Ask the operator to configure the hosted Fit Trace deployment.",
          },
        };
      }
      if (destinationIssuer !== issuer) {
        return {
          ok: false,
          error: {
            code: "CLOUD_DESTINATION_ISSUER_INCOMPATIBLE",
            message:
              `This server uses a different account service (${destinationIssuer}). ` +
              "Custom cloud servers must use the same account service as this app; sign in through that service or use the official server.",
          },
        };
      }
    }
    return {
      ok: true,
      destination: canonical,
      host: cloudDestinationHost(destination),
      official,
      issuerCompatible: true,
    };
  }

  /**
   * Save a confirmed custom destination for `principalId`.
   *
   * The exact host must be named in the confirmation. A canonical change
   * clears every prior consent; the confirming principal gets a fresh one in
   * the same atomic write. Setting the official destination's own URL is a
   * reset: the official path does not need per-user consent.
   */
  async confirm(
    raw: string,
    confirmationHost: string,
    principalId: string,
  ): Promise<CloudDestinationStatus> {
    const issuer = this.assertIssuer();
    let destination: URL;
    try {
      destination = normalizeCloudDestinationInput(raw, {
        allowInsecureLoopback: this.allowInsecureLoopback,
      });
    } catch (error) {
      throw error instanceof CloudDestinationSettingError
        ? error
        : new CloudDestinationSettingError(
            "CLOUD_DESTINATION_INVALID",
            "Invalid cloud server address.",
          );
    }
    const host = cloudDestinationHost(destination);
    if (confirmationHost.trim() !== host) {
      throw new CloudDestinationSettingError(
        "CLOUD_DESTINATION_CONFIRMATION_REQUIRED",
        `Confirm the exact host ${host} before using this server.`,
      );
    }
    const canonical = canonicalCloudDestination(destination);
    if (
      this.officialDestination !== null &&
      canonicalCloudDestination(this.officialDestination) === canonical
    ) {
      return this.reset();
    }
    const check = await this.check(raw);
    if (!check.ok) {
      const error = check.error ?? {
        code: "CLOUD_DESTINATION_INVALID",
        message: "The cloud server could not be validated.",
      };
      throw new CloudDestinationSettingError(
        error.code as CloudDestinationSettingErrorCode,
        error.message,
        error.code === "CLOUD_DESTINATION_UNREACHABLE" ? 502 : 400,
      );
    }
    return this.enqueueWrite(async () => {
      const consents =
        this.state.kind === "user" && canonicalCloudDestination(this.state.destination) === canonical
          ? new Map(this.state.consents)
          : new Map<string, CloudDestinationConsentRecord>();
      consents.set(principalId, {
        destination: canonical,
        issuer,
        approvedAt: new Date().toISOString(),
      });
      await writeStoredCloudDestination(
        this.filePath,
        serializeStoredCloudDestination(destination, consents),
      );
      this.state = { kind: "user", destination, consents };
      return this.statusFor(principalId);
    });
  }

  /** Drop the user setting and every consent, falling back to the build default. */
  async reset(): Promise<CloudDestinationStatus> {
    return this.enqueueWrite(async () => {
      await rm(this.filePath, { force: true });
      if (this.officialDestination !== null) {
        this.state = { kind: "official", destination: this.officialDestination };
      } else if (this.officialError !== null) {
        this.state = { kind: "invalid", message: this.officialError };
      } else {
        this.state = { kind: "unset" };
      }
      // The reset is not principal-specific; the caller re-reads status for
      // its own consent state (official destinations need none).
      return this.statusFor("");
    });
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }
}
