// The app's data hooks: the live chat listing, the tree's fold state, and one
// chat's title.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_usePluginId,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { CHATS_CHANGED, type ChatClient, type ListResult } from "../shared/contract";
import { applyDelta, chatsDeltaSchema, toListing, toListResult, type Listing } from "../shared/listing";
import type { rpcContract } from "../server";
import { errorMessage } from "../shared/text";

/** Expanded tree nodes, remembered per browser. */
export function useExpanded() {
  const storageKey = `${experimental_usePluginId()}:expanded`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback(
    (node: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(node)) next.add(node);
        localStorage.setItem(storageKey, JSON.stringify([...next]));
        return next;
      });
    },
    [storageKey],
  );
  /** Add `add` and drop `remove` (e.g. a client group's `|closed` marker) in one update. */
  const update = useCallback(
    (add: string[], remove: string[]) => {
      setExpanded((current) => {
        const next = new Set(current);
        for (const node of add) next.add(node);
        for (const node of remove) next.delete(node);
        localStorage.setItem(storageKey, JSON.stringify([...next]));
        return next;
      });
    },
    [storageKey],
  );
  return { expanded, toggle, update };
}

/** A chat the trees should show once it is listed: a chat just started from a "New chat" button. */
export interface RevealRequest {
  client: ChatClient;
  id: string;
  /** Distinguishes requests, so each tree handles each one once. */
  seq: number;
  at: number;
}

/** A reveal request is dropped when its chat is not listed within this time. */
const REVEAL_TTL_MS = 120_000;
let revealRequest: RevealRequest | null = null;
let revealSeq = 0;
const revealListeners = new Set<() => void>();

/** Ask every chat tree in this window to open the folders down to the chat and scroll to it. */
export function requestReveal(client: ChatClient, id: string): void {
  revealSeq += 1;
  revealRequest = { client, id, seq: revealSeq, at: Date.now() };
  for (const listener of revealListeners) listener();
}

/** The pending reveal request, current while it is fresh. */
export function useRevealRequest(): RevealRequest | null {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    revealListeners.add(listener);
    return () => {
      revealListeners.delete(listener);
    };
  }, []);
  return revealRequest !== null && Date.now() - revealRequest.at < REVEAL_TTL_MS ? revealRequest : null;
}

/**
 * The listing, kept current by deltas from the server. A delta applies only on
 * top of the version it was computed from; any gap (a missed delta, a server
 * reload, a `reload` delta) refetches the listing once.
 */
export function useChats() {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listingRef = useRef<Listing | null>(null);
  listingRef.current = listing;

  const load = useCallback(
    (force: boolean) => {
      // Only a requested rescan shows the spinner; catching up stays silent.
      if (force) setLoading(true);
      rpc
        .call("chats_list", force ? { force: true } : null)
        .then(
          ({ version, ...result }) => {
            setListing(toListing(result, version));
            setError(null);
          },
          (cause: unknown) => setError(errorMessage(cause)),
        )
        .finally(() => {
          if (force) setLoading(false);
        });
    },
    [rpc],
  );
  const refresh = useCallback(() => load(true), [load]);
  useEffect(() => load(false), [load]);

  useRealtime(CHATS_CHANGED, (payload) => {
    const delta = chatsDeltaSchema.safeParse(payload);
    const base = listingRef.current;
    if (base === null) return;
    const next = delta.success ? applyDelta(base, delta.data) : null;
    if (next === null) {
      // Already at or past this version: nothing to do.
      if (delta.success && delta.data.to === base.version) return;
      load(false);
      return;
    }
    listingRef.current = next;
    setListing(next);
  });
  // Deltas are not replayed, so a reconnect may have missed some: catch up.
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") load(false);
    previousConnection.current = connection;
  }, [connection, load]);

  const data = useMemo<ListResult | null>(() => (listing === null ? null : toListResult(listing)), [listing]);
  return { rpc, data, loading, error, refresh };
}

/** A chat's title from the server's listing, for the chat view header. */
export function useChatTitle(client: ChatClient, id: string | null): string | null {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (id === null) return;
    rpc.call("chats_list", null).then(
      (listing) => {
        const chat = listing.projects.flatMap((project) => project.chats).find((c) => c.client === client && c.id === id);
        setTitle(chat?.title ?? null);
      },
      () => setTitle(null),
    );
  }, [rpc, client, id]);
  return title;
}
