import type {
  CoachingBackendId,
  CoachingDataSnapshot,
  CoachingEventEnvelope,
  SubmitCoachingRunInput,
} from "@pi-fit-trace/api-contracts";
import type { CoachRunClient } from "./coachBackend.ts";

export interface CoachClientRouterOptions {
  local: CoachRunClient;
  cloud: CoachRunClient;
  /** Backend used before any explicit selection (legacy local-pi). */
  initialBackend?: CoachingBackendId;
}

/**
 * A stable client identity that dispatches every operation to the backend
 * CURRENTLY pinned for the run.
 *
 * The lifecycle owner sets the active backend once, before a submit or a
 * resume. It never changes while a run is active/unknown/cancelling, so
 * reconnect, cancel, and cleanup always address the original backend. A
 * selection change only affects the NEXT run.
 */
export class CoachClientRouter implements CoachRunClient {
  private readonly local: CoachRunClient;
  private readonly cloud: CoachRunClient;
  private activeBackend: CoachingBackendId;

  constructor({ local, cloud, initialBackend = "local-pi" }: CoachClientRouterOptions) {
    this.local = local;
    this.cloud = cloud;
    this.activeBackend = initialBackend;
  }

  get activeBackendId(): CoachingBackendId {
    return this.activeBackend;
  }

  setActiveBackend(backendId: CoachingBackendId): void {
    this.activeBackend = backendId;
  }

  private get active(): CoachRunClient {
    return this.activeBackend === "cloud-default" ? this.cloud : this.local;
  }

  get isBootstrapped(): boolean {
    return this.active.isBootstrapped;
  }

  bootstrap(): Promise<unknown> {
    return this.active.bootstrap();
  }

  createSession(id?: string): Promise<{ id: string }> {
    return this.active.createSession(id);
  }

  createSnapshot(filter?: { from?: string; to?: string }): Promise<CoachingDataSnapshot> {
    return this.active.createSnapshot(filter);
  }

  submitRun(input: SubmitCoachingRunInput): Promise<{
    run: { id: string; sessionId: string; snapshot: CoachingDataSnapshot };
    lastSeq: number;
    replayed: boolean;
  }> {
    return this.active.submitRun(input);
  }

  readSession(id: string): Promise<{ id: string }> {
    return this.active.readSession(id);
  }

  readRun(id: string): Promise<{
    run: { id: string; sessionId: string; snapshot: CoachingDataSnapshot };
    lastSeq: number;
    firstSeq?: number;
    expiresAt?: number;
  }> {
    return this.active.readRun(id);
  }

  cancelRun(
    runId: string,
    reason?: string,
    cleanup?: { accessToken?: string | null; capability?: string | null },
  ): Promise<unknown> {
    return this.active.cancelRun(runId, reason, cleanup);
  }

  subscribeRunEvents(
    input: { runId: string; sessionId: string; fromSeq?: number },
    onEvent: (envelope: CoachingEventEnvelope) => void,
    options?: { signal?: AbortSignal },
  ): { close(): void; done: Promise<{ aborted: boolean; lastConsumed: number }> } {
    return this.active.subscribeRunEvents(input, onEvent, options);
  }

  capabilitySnapshot(): string | null {
    // Only the local transport has a capability; a cloud run is cleaned up
    // with the captured bearer instead.
    return this.local.capabilitySnapshot();
  }

  discardCredentials(): void {
    this.local.discardCredentials();
    this.cloud.discardCredentials();
  }

  logout(cleanup?: { accessToken?: string | null; capability?: string | null }): Promise<unknown> {
    if (this.activeBackend === "cloud-default") {
      return this.cloud.logout(cleanup);
    }
    return this.local.logout(cleanup);
  }
}
