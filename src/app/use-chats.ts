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
  return { expanded, toggle };
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
