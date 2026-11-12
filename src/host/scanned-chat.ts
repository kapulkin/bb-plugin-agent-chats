// The host's record of one listed chat, and the folder and key helpers shared
// by the store readers, the chat index, and the chat registry.
import path from "node:path";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import type { Chat, ChatClient, hostSignals } from "../shared/contract";

export const isWindows = process.platform === "win32";

/** Listed titles are cut to this many characters. */
export const TITLE_MAX = 120;

/** The context of a host entry call. */
export type HostContext = ExperimentalHostRpcContext<typeof hostSignals>;

export interface ScannedChat extends Omit<Chat, "parentId"> {
  cwd: string;
  /** Started by bb (or another SDK host) rather than by the user directly. */
  fromBb: boolean;
  /** The chat this one was forked from, or null when it is not a fork. */
  forkOf: string | null;
}

export const chatKey = (client: ChatClient, id: string) => `${client}:${id.toLowerCase()}`;

/** Strips Windows extended-length prefixes and trailing separators. */
export function normalizeCwd(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("\\\\?\\UNC\\")) value = `\\\\${value.slice(8)}`;
  else if (value.startsWith("\\\\?\\")) value = value.slice(4);
  const normalized = isWindows ? path.win32.normalize(value) : path.posix.normalize(value);
  const root = path.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
}

export function projectKey(cwd: string): string {
  return isWindows ? cwd.toLowerCase() : cwd;
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(projectKey(parent), projectKey(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
