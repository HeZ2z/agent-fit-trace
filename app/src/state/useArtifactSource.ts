import { useCallback, useEffect, useRef, useState } from "react";
import type { FitTraceClient } from "@pi-fit-trace/api-contracts";
import type {
  ImportedArtifact,
  ImportedArtifactKind,
  ImportedArtifactMeta,
} from "@pi-fit-trace/api-contracts";

export type ArtifactSourceStatus = "loading" | "ready" | "error";

type Detail<K extends ImportedArtifactKind> =
  | { status: "empty" }
  | { status: "loading"; artifactId: string }
  | { status: "ready"; artifactId: string; artifact: ImportedArtifact<K> }
  | { status: "error"; artifactId: string };

export interface ArtifactSource<K extends ImportedArtifactKind = ImportedArtifactKind> {
  kind: K;
  items: ImportedArtifactMeta<K>[];
  nextCursor: string | null;
  listStatus: ArtifactSourceStatus;
  listError: string | null;
  selectionStatus: ArtifactSourceStatus;
  selectionLoading: boolean;
  selectionBusy: boolean;
  selection: string | null;
  selected: ImportedArtifact<K> | null;
  selectionError: string | null;
  selectingId: string | null;
  loadingMore: boolean;
  refreshVersion: number;
  refresh: () => void;
  loadMore: () => Promise<void>;
  select: (artifactId: string | null) => Promise<void>;
  retrySelected: () => Promise<void>;
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Server-backed snapshot history plus the persisted "currently viewing" choice.
 *
 * Every async completion is checked against the live client, the scope
 * generation, and an operation epoch. The epoch makes late write/read
 * completions unable to overwrite a newer explicit selection: A then B always
 * settles on B. Payload state is also bound to the client/kind that produced
 * it, so a provider/client swap returns safe empty state on the first render
 * instead of briefly painting the previous account's snapshot.
 */
export function useArtifactSource<K extends ImportedArtifactKind>(
  kind: K,
  client: FitTraceClient,
): ArtifactSource<K> {
  const [items, setItems] = useState<ImportedArtifactMeta<K>[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listStatus, setListStatus] = useState<ArtifactSourceStatus>("loading");
  const [listError, setListError] = useState<string | null>(null);
  const [selectionStatus, setSelectionStatus] = useState<ArtifactSourceStatus>("loading");
  const [selection, setSelection] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail<K>>({ status: "empty" });
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const clientRef = useRef(client);
  clientRef.current = client;
  const scopeRef = useRef<{ client: FitTraceClient; kind: ImportedArtifactKind }>({
    client,
    kind,
  });
  const aliveRef = useRef(true);
  const generationRef = useRef(0);
  const selectionEpochRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      generationRef.current += 1;
      selectionEpochRef.current += 1;
    };
  }, []);

  const isCurrent = useCallback(
    (generation: number, captured: FitTraceClient) =>
      aliveRef.current &&
      generationRef.current === generation &&
      clientRef.current === captured,
    [],
  );

  const loadSelected = useCallback(
    async (
      captured: FitTraceClient,
      generation: number,
      epoch: number,
      artifactId: string | null,
    ) => {
      const current = () =>
        isCurrent(generation, captured) && selectionEpochRef.current === epoch;

      if (artifactId === null) {
        if (!current()) return;
        setDetail({ status: "empty" });
        setSelectionError(null);
        return;
      }

      if (!current()) return;
      setDetail({ status: "loading", artifactId });
      try {
        const artifact = (await captured.getImportedArtifact(artifactId)) as ImportedArtifact<K>;
        if (!current()) return;
        // Runtime validation matters even for in-memory/fake clients: never
        // trust the returned payload to belong to the requested kind/id.
        if (artifact.id !== artifactId || artifact.kind !== kind) {
          setDetail({ status: "error", artifactId });
          setSelectionError(
            `Could not load the selected ${kind} snapshot (${artifactId}): the client returned a different ${artifact.kind} artifact (${artifact.id}). The saved selection was not changed.`,
          );
          return;
        }
        setDetail({ status: "ready", artifactId, artifact });
        setSelectionError(null);
      } catch (caught) {
        if (!current()) return;
        // Never show another artifact or the computed result as if it were the
        // persisted selection.
        setDetail({ status: "error", artifactId });
        setSelectionError(
          `Could not load the selected ${kind} snapshot (${artifactId}): ${message(caught)}. The saved selection was not changed.`,
        );
      }
    },
    [isCurrent, kind],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    const epoch = ++selectionEpochRef.current;
    const captured = client;
    scopeRef.current = { client, kind };
    setItems([]);
    setNextCursor(null);
    setListStatus("loading");
    setListError(null);
    setSelectionStatus("loading");
    setSelection(null);
    setDetail({ status: "empty" });
    setSelectionError(null);
    setSelectionBusy(false);
    setSelectingId(null);
    setLoadingMore(false);

    void captured
      .listImportedArtifacts({ kind })
      .then((page) => {
        if (!isCurrent(generation, captured)) return;
        setItems(page.items as ImportedArtifactMeta<K>[]);
        setNextCursor(page.next_cursor);
        setListStatus("ready");
      })
      .catch((caught: unknown) => {
        if (!isCurrent(generation, captured)) return;
        setListStatus("error");
        setListError(message(caught));
      });

    void captured
      .getArtifactSelection(kind)
      .then(async (saved) => {
        // A user selection (or a refresh) that started while this read was in
        // flight wins; the stale read must not overwrite it.
        if (!isCurrent(generation, captured) || selectionEpochRef.current !== epoch) return;
        setSelectionStatus("ready");
        setSelection(saved.artifact_id);
        await loadSelected(captured, generation, epoch, saved.artifact_id);
      })
      .catch((caught: unknown) => {
        if (!isCurrent(generation, captured) || selectionEpochRef.current !== epoch) return;
        setSelectionStatus("error");
        setSelection(null);
        setDetail({ status: "empty" });
        setSelectionError(
          `Could not read the saved ${kind} selection: ${message(caught)}. The current computed result is shown separately and is not the saved selection.`,
        );
      });
  }, [client, kind, refreshToken, isCurrent, loadSelected]);

  const select = useCallback(
    async (artifactId: string | null) => {
      const generation = generationRef.current;
      const captured = clientRef.current;
      const epoch = ++selectionEpochRef.current;
      const current = () =>
        isCurrent(generation, captured) && selectionEpochRef.current === epoch;

      // Busy is a separate flag because selecting the current computed source
      // has a null id; it must still block every other selection write.
      setSelectionBusy(true);
      setSelectingId(artifactId);
      setSelectionError(null);
      setDetail({ status: "empty" });
      try {
        // Reflect the server's answer, not the requested value.
        const saved = await captured.setArtifactSelection(kind, artifactId);
        if (!current()) return;
        setSelectionStatus("ready");
        setSelection(saved.artifact_id);
        await loadSelected(captured, generation, epoch, saved.artifact_id);
      } catch (caught) {
        if (!current()) return;
        // Keep a previously confirmed selection; only an unknown selection
        // becomes an error that Retry resolves by re-reading the server.
        setSelectionStatus((previous) => (previous === "ready" ? previous : "error"));
        setSelectionError(
          `Could not change the ${kind} source: ${message(caught)}. The previously saved selection may still be unchanged.`,
        );
      } finally {
        if (selectionEpochRef.current === epoch) {
          setSelectionBusy(false);
          setSelectingId(null);
        }
      }
    },
    [isCurrent, kind, loadSelected],
  );

  const refresh = useCallback(() => {
    // Invalidates any in-flight selection read/write immediately, then
    // restarts the scoped load through the effect.
    selectionEpochRef.current += 1;
    setRefreshVersion((version) => version + 1);
    setRefreshToken((token) => token + 1);
  }, []);

  const retrySelected = useCallback(async () => {
    // An unknown/failed selection needs an authoritative re-read, not a
    // retry of the now-null optimistic value.
    if (selectionStatus === "error" || selection === null) {
      refresh();
      return;
    }
    await loadSelected(
      clientRef.current,
      generationRef.current,
      selectionEpochRef.current,
      selection,
    );
  }, [loadSelected, refresh, selection, selectionStatus]);

  const loadMore = useCallback(async () => {
    if (nextCursor === null || listStatus !== "ready" || loadingMore) return;
    const generation = generationRef.current;
    const captured = clientRef.current;
    setLoadingMore(true);
    setListError(null);
    try {
      const page = await captured.listImportedArtifacts({
        kind,
        cursor: nextCursor,
      });
      if (!isCurrent(generation, captured)) return;
      setItems((previous: ImportedArtifactMeta<K>[]) => {
        const seen = new Set(previous.map((item) => item.id));
        return [...previous, ...(page.items as ImportedArtifactMeta<K>[]).filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.next_cursor);
    } catch (caught) {
      if (!isCurrent(generation, captured)) return;
      // Keep the already-loaded history; this is only the next-page failure.
      setListError(message(caught));
    } finally {
      if (isCurrent(generation, captured)) setLoadingMore(false);
    }
  }, [isCurrent, kind, listStatus, loadingMore, nextCursor]);

  const inScope = scopeRef.current.client === client && scopeRef.current.kind === kind;
  const safeSelectionStatus: ArtifactSourceStatus = inScope ? selectionStatus : "loading";
  const safeSelection = inScope ? selection : null;
  const selected =
    inScope &&
    safeSelectionStatus === "ready" &&
    detail.status === "ready" &&
    detail.artifactId === safeSelection
      ? detail.artifact
      : null;

  return {
    kind,
    items: inScope ? items : [],
    nextCursor: inScope ? nextCursor : null,
    listStatus: inScope ? listStatus : "loading",
    listError: inScope ? listError : null,
    selectionStatus: safeSelectionStatus,
    selectionLoading: safeSelectionStatus === "loading",
    selectionBusy: inScope && selectionBusy,
    selection: safeSelection,
    selected,
    selectionError: inScope ? selectionError : null,
    selectingId: inScope ? selectingId : null,
    loadingMore: inScope && loadingMore,
    refreshVersion,
    refresh,
    loadMore,
    select,
    retrySelected,
  };
}
