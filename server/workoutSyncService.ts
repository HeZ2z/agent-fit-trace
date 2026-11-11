import { createHash } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { stableStringify } from "@agent-fit-trace/core";
import { GUEST_PRINCIPAL, SqliteWorkoutStore, principalDbPath } from "@agent-fit-trace/store";
import type { TokenVerifier } from "./auth/verifier.ts";
import { parseSignedSyncIdentity, verifySupabaseSyncSession } from "./auth/supabaseSyncSession.ts";
import { WorkoutSyncSessionState } from "./workoutSyncSessionState.ts";
import type { SyncIdentity } from "./workoutSyncSessionState.ts";
import { WorkoutSyncRepository } from "./workoutSyncRepository.ts";
import { WorkoutSyncClient } from "../packages/fit-trace-sync/src/syncClient.ts";
import { resolveSyncConfig } from "../packages/fit-trace-sync/src/syncConfig.ts";
import { runWorkoutSync } from "../packages/fit-trace-sync/src/syncRunner.ts";

/** Foreground-only sync. Caller must enforce the trusted loopback Host/Origin gate. */
export class WorkoutSyncService {
  private readonly dataDir: string;
  private readonly supabaseUrl: string;
  private readonly verifier: TokenVerifier;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly syncAuth: { publicKeys: JsonWebKey[]; publishableKey: string; fetchImpl?: typeof fetch };
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly state: WorkoutSyncSessionState;

  constructor(options: { dataDir: string; supabaseUrl: string; verifier: TokenVerifier; endpoint: string; syncAuth: { publicKeys: JsonWebKey[]; publishableKey: string; fetchImpl?: typeof fetch }; fetchImpl?: typeof fetch }) {
    const config = resolveSyncConfig(options.endpoint);
    if (config.status !== "configured" || !config.baseUrl.startsWith("https://")) throw new Error("Sync destination must be a configured HTTPS API.");
    this.dataDir = options.dataDir;
    this.supabaseUrl = options.supabaseUrl;
    this.verifier = options.verifier;
    this.syncAuth = options.syncAuth;
    this.endpoint = config.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.state = new WorkoutSyncSessionState(options.dataDir);
  }

  close(): void {
    for (const controllers of this.active.values()) for (const controller of controllers) controller.abort();
    this.state.close();
  }

  private async open(token: string, capability?: string) {
    const session = await verifySupabaseSyncSession(token, this.verifier, this.supabaseUrl, this.syncAuth);
    const scope = { accountId: session.principal.id, issuer: session.issuer, sessionId: session.sessionId, endpoint: this.endpoint };
    if (capability !== undefined) this.state.require(capability, scope);
    const store = new SqliteWorkoutStore(principalDbPath(this.dataDir, scope.accountId));
    const guard = capability === undefined ? undefined : () => this.state.requireCurrent(capability, scope);
    return { store, scope, repo: new WorkoutSyncRepository(store, guard) };
  }
  private key(scope: { issuer: string; accountId: string; sessionId: string }): string {
    return JSON.stringify([scope.issuer, scope.accountId, scope.sessionId]);
  }
  private cancel(identity: SyncIdentity): void {
    for (const controller of this.active.get(this.key(identity)) ?? []) controller.abort();
  }
  /** Authentication that began before a committed transition cannot bootstrap afterward. */
  sessionVersion(): number { return this.state.version(); }
  async bootstrap(token: string, version = this.state.version()): Promise<string> {
    const { store, scope } = await this.open(token);
    try { return this.state.bootstrap(scope, version); } finally { store.close(); }
  }
  async transition(token: string, capability: string): Promise<string> {
    const { store, scope } = await this.open(token);
    try { return this.state.transition(capability, scope, identity => this.cancel(identity)); }
    finally { store.close(); }
  }
  logoutCapability(capability: string): void {
    this.state.logout(capability, identity => this.cancel(identity));
  }
  /** Authenticate the exact bearer; never accept a caller-supplied session ID. */
  async revokeVerifiedSession(token: string): Promise<void> {
    const identity = { ...parseSignedSyncIdentity(token, this.supabaseUrl, this.syncAuth.publicKeys), endpoint: this.endpoint };
    if (this.state.confirmRevoked(identity, active => this.cancel(active))) return;
    const { store, scope } = await this.open(token);
    try { this.state.revokeVerifiedSession(scope, identity => this.cancel(identity)); }
    finally { store.close(); }
  }
  async consent(token: string, capability: string, expectedEndpoint: string): Promise<void> {
    if (expectedEndpoint !== this.endpoint) throw new Error("Sync destination changed; review consent again.");
    const { store, scope, repo } = await this.open(token, capability);
    try { repo.enableSync(scope); } finally { store.close(); }
  }
  async revokeConsent(token: string, capability: string): Promise<void> {
    const { store, scope, repo } = await this.open(token, capability);
    try {
      repo.disableSync(scope);
      for (const [key, controllers] of this.active) {
        const [issuer, account] = JSON.parse(key) as [string, string, string];
        if (issuer === scope.issuer && account === scope.accountId) {
          for (const controller of controllers) controller.abort();
        }
      }
    } finally { store.close(); }
  }
  async status(token: string, capability: string) {
    const { store, scope, repo } = await this.open(token, capability);
    try {
      if (!repo.isSessionAllowed(scope)) throw new Error("Sync session is revoked.");
      const enabled = await repo.isSyncEnabled(scope);
      const status = await repo.getSyncStatus(scope);
      if (!repo.isSessionAllowed(scope)) throw new Error("Sync session is revoked.");
      return { endpoint: this.endpoint, enabled, ...status };
    } finally { store.close(); }
  }
  async logout(token: string, capability: string): Promise<void> {
    const { store } = await this.open(token, capability);
    store.close();
    this.logoutCapability(capability);
  }
  private async inspectGuest(repo: WorkoutSyncRepository) {
    const guest = new SqliteWorkoutStore(principalDbPath(this.dataDir, GUEST_PRINCIPAL));
    try {
      const [guestRecords, accountRecords] = await Promise.all([guest.all(), repo.listWorkouts()]);
      const account = new Map(accountRecords.map(record => [record.id, stableStringify(record)]));
      let copies = 0, duplicates = 0, conflicts = 0;
      for (const record of guestRecords) {
        const existing = account.get(record.id);
        if (existing === undefined) copies++;
        else if (existing === stableStringify(record)) duplicates++;
        else conflicts++;
      }
      const fingerprint = createHash("sha256").update(stableStringify({ endpoint: this.endpoint, guestRecords, accountRecords })).digest("hex");
      return { guestRecords, preview: { copies, duplicates, conflicts, fingerprint, endpoint: this.endpoint } };
    } finally { guest.close(); }
  }
  async previewGuest(token: string, capability: string) {
    const { store, scope, repo } = await this.open(token, capability);
    try {
      const result = await this.inspectGuest(repo);
      if (!repo.isSessionAllowed(scope)) throw new Error("Sync session is revoked.");
      return result.preview;
    } finally { store.close(); }
  }
  async importGuest(token: string, capability: string, fingerprint: string) {
    const { store, scope, repo } = await this.open(token, capability);
    try {
      const { guestRecords, preview } = await this.inspectGuest(repo);
      if (!repo.isSessionAllowed(scope) || fingerprint !== preview.fingerprint) throw new Error("Preview changed; review it again.");
      // This operation is explicit whole-account consent; copying never starts a network sync.
      repo.enableSync(scope);
      let copied = 0, conflicts = 0;
      for (const record of guestRecords) {
        if (!repo.isSessionAllowed(scope)) throw new Error("Sync session is revoked.");
        try { if (!(await store.import(record)).duplicate) copied++; }
        catch (error) {
          if (error instanceof Error && (error as { code?: string }).code === "CONFLICT") { conflicts++; continue; }
          throw error;
        }
      }
      return { copied, conflicts };
    } finally { store.close(); }
  }
  async run(token: string, capability: string) {
    const { store, scope, repo } = await this.open(token, capability);
    const controller = new AbortController();
    const key = this.key(scope);
    const controllers = this.active.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.active.set(key, controllers);
    try {
      if (!repo.isSessionAllowed(scope)) throw new Error("Sync session is revoked.");
      const client = new WorkoutSyncClient({
        config: { status: "configured", baseUrl: this.endpoint }, accessToken: token,
        fetchImpl: (input, init) => {
          if (controller.signal.aborted) throw new Error("Sync run was cancelled.");
          repo.assertNetworkLeaseCurrent(scope);
          return this.fetchImpl(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
        },
      });
      const account = { userId: scope.accountId, accessToken: token };
      return await runWorkoutSync({ repository: repo, client, account, scope,
        getCurrentAccount: () => repo.isSessionAllowed(scope) && !controller.signal.aborted ? account : { userId: null, accessToken: null } });
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) this.active.delete(key);
      store.close();
    }
  }
}
