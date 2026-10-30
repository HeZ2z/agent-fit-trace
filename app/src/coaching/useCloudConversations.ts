import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloudConversationsClient } from "./cloudConversations.ts";
import type { CloudConversation, CloudConversationMessage } from "./cloudConversations.ts";

interface State {
  accountId: string | null;
  conversations: CloudConversation[];
  selectedId: string | null;
  messages: CloudConversationMessage[];
  loading: boolean;
  initialized: boolean;
  error: string | null;
}
const empty = (accountId: string | null): State => ({ accountId, conversations: [], selectedId: null, messages: [], loading: false, initialized: false, error: null });

/** History is owned by the authenticated cloud account, not browser storage. */
export function useCloudConversations(accountId: string | null, enabled: boolean, getAccessToken: () => string | null) {
  const client = useMemo(() => new CloudConversationsClient(getAccessToken), [getAccessToken]);
  const [state, setState] = useState<State>(() => empty(accountId));
  const generation = useRef(0);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const request = useRef(false);
  const pendingCreateId = useRef<string | null>(null);
  const effective = state.accountId === accountId ? state : empty(accountId);

  useEffect(() => {
    const gen = ++generation.current;
    request.current = false;
    pendingCreateId.current = null;
    setState(empty(accountId));
    if (!enabled || accountId === null) return;
    setState({ ...empty(accountId), loading: true });
    void client.list().then((conversations) => {
      if (generation.current !== gen || accountRef.current !== accountId) return;
      setState({ ...empty(accountId), conversations, initialized: true });
    }).catch((error: unknown) => {
      if (generation.current !== gen || accountRef.current !== accountId) return;
      setState({ ...empty(accountId), initialized: true, error: error instanceof Error ? error.message : "Could not load conversations." });
    });
    return () => { generation.current += 1; };
  }, [accountId, enabled, client]);

  const select = useCallback(async (id: string) => {
    const gen = generation.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const detail = await client.read(id);
      if (generation.current !== gen || accountRef.current !== accountId) return;
      setState((current) => ({ ...current, selectedId: id, messages: detail.messages, loading: false }));
    } catch (error) {
      if (generation.current !== gen || accountRef.current !== accountId) return;
      setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not load conversation." }));
    }
  }, [client, accountId]);

  const create = useCallback(async (): Promise<string | null> => {
    if (!enabled || accountId === null || request.current) return null;
    request.current = true;
    const gen = generation.current;
    // A random client ID makes retrying the same create safe after a lost response.
    const id = pendingCreateId.current ?? globalThis.crypto.randomUUID();
    pendingCreateId.current = id;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const created = await client.create(id);
      if (generation.current !== gen || accountRef.current !== accountId) return null;
      pendingCreateId.current = null;
      setState((current) => ({ ...current, conversations: [created, ...current.conversations], selectedId: created.id, messages: [], loading: false }));
      return created.id;
    } catch (error) {
      if (generation.current === gen && accountRef.current === accountId) setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not create conversation." }));
      return null;
    } finally { if (generation.current === gen) request.current = false; }
  }, [accountId, client, enabled]);

  const refresh = useCallback(async () => {
    const id = effective.selectedId;
    if (id === null || !enabled) return;
    const gen = generation.current;
    try {
      const [detail, conversations] = await Promise.all([client.read(id), client.list()]);
      if (generation.current !== gen || accountRef.current !== accountId) return;
      setState((current) => current.selectedId === id ? { ...current, conversations, messages: detail.messages, error: null } : current);
    } catch (error) {
      if (generation.current === gen && accountRef.current === accountId) setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Could not refresh conversation." }));
    }
  }, [client, effective.selectedId, enabled, accountId]);

  const reloadList = useCallback(async () => {
    if (!enabled || accountId === null) return;
    const gen = generation.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const conversations = await client.list();
      if (generation.current !== gen || accountRef.current !== accountId) return;
      setState((current) => ({ ...current, conversations, loading: false, initialized: true }));
    } catch (error) {
      if (generation.current === gen && accountRef.current === accountId) setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not load conversations." }));
    }
  }, [client, accountId, enabled]);

  const remove = useCallback(async (): Promise<boolean> => {
    const id = effective.selectedId;
    if (!id || request.current) return false;
    request.current = true;
    const gen = generation.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      await client.delete(id);
      if (generation.current !== gen || accountRef.current !== accountId) return false;
      setState((current) => ({ ...current, conversations: current.conversations.filter((item) => item.id !== id), selectedId: null, messages: [], loading: false }));
      return true;
    } catch (error) {
      if (generation.current === gen && accountRef.current === accountId) setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not delete conversation." }));
      return false;
    } finally { if (generation.current === gen) request.current = false; }
  }, [client, effective.selectedId, accountId]);

  return { ...effective, select, create, refresh, reloadList, remove };
}
