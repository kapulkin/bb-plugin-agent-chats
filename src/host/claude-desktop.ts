// The Claude desktop app's chat records. The app keeps one record per chat in
// `<LOCALAPPDATA>/Claude-Data/<instance>/claude-code-sessions/<account>/<org>/local_*.json`
// (the location verified on Windows). A desktop chat runs on a chain of Claude
// Code sessions: `cliSessionId` is the current one and `priorCliSessionIds`
// the ones it replaced, which keep the titles they had then. The listing shows
// each chain once, as its current session, with the app's own title, folder,
// and place in the app's fork tree.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chatKey, normalizeCwd, type ScannedChat } from "./scanned-chat";

export interface DesktopChat {
  /** The app's own id of the chat (`local_<uuid>`). */
  localId: string;
  /** The Claude Code session the app resumes now. */
  current: string;
  /** The chat's project folder in the app, or null when the record has none. */
  cwd: string | null;
  /**
   * The app's id of the chat this one was forked from, or null when it is not
   * a fork or the user detached it to the top level.
   */
  forkedFrom: string | null;
  /**
   * For a side chat, the app's id of the chat it was opened from; null for
   * every other chat. The app's own test (`isBtwChild`): `spawnedFrom.btw` and
   * not detached to the top level.
   */
  sideOf: string | null;
  /** Sessions this chat ran on before, which the app no longer resumes. */
  priors: string[];
  /** The app's title, or null when it has none. */
  title: string | null;
}

const RECORD_FILE = /^local_.*\.json$/;

/** The app's record folders: one `claude-code-sessions` per app instance. */
export async function claudeDesktopRoots(): Promise<string[]> {
  const local = process.env.LOCALAPPDATA?.trim();
  if (!local) return [];
  const base = path.join(local, "Claude-Data");
  let instances: string[];
  try {
    instances = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const instance of instances) {
    const root = path.join(base, instance, "claude-code-sessions");
    try {
      if ((await stat(root)).isDirectory()) roots.push(root);
    } catch {
      // This instance has no Claude Code chats.
    }
  }
  return roots;
}

/** Whether a changed path under a record folder is a chat record. */
export function isDesktopRecord(root: string, changed: string): boolean {
  const parts = path.relative(root, changed).split(/[\\/]/);
  return parts.length === 3 && RECORD_FILE.test(parts[2]!);
}

const recordCache = new Map<string, { mtimeMs: number; size: number; chat: DesktopChat | null }>();

function parseRecord(json: string): DesktopChat | null {
  const record = JSON.parse(json) as Record<string, unknown>;
  if (typeof record.cliSessionId !== "string" || record.cliSessionId === "") return null;
  const priors = Array.isArray(record.priorCliSessionIds)
    ? record.priorCliSessionIds.filter((id): id is string => typeof id === "string")
    : [];
  const title = typeof record.title === "string" && record.title.trim() !== "" ? record.title.trim() : null;
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);
  // "Detach to top level" keeps `forkedFromSessionId` and sets `lineageDetached`.
  const forkedFrom = record.lineageDetached === true ? null : text(record.forkedFromSessionId);
  const cwd = text(record.cwd);
  const spawnedFrom = record.spawnedFrom as { btw?: unknown; sessionId?: unknown } | null | undefined;
  const sideOf =
    spawnedFrom?.btw === true && record.lineageDetached !== true ? (text(spawnedFrom.sessionId) ?? forkedFrom) : null;
  return {
    localId: text(record.sessionId) ?? "",
    current: record.cliSessionId,
    cwd: cwd === null ? null : normalizeCwd(cwd),
    forkedFrom,
    sideOf,
    priors,
    title,
  };
}

/** Every chat record of the app, each file reread only when it changed. */
export async function readDesktopChats(warnings: string[]): Promise<DesktopChat[]> {
  const chats: DesktopChat[] = [];
  const seen = new Set<string>();
  for (const root of await claudeDesktopRoots()) {
    let accounts: string[];
    try {
      accounts = await readdir(root);
    } catch {
      continue;
    }
    for (const account of accounts) {
      let orgs: string[];
      try {
        orgs = await readdir(path.join(root, account));
      } catch {
        continue;
      }
      for (const org of orgs) {
        let names: string[];
        try {
          names = await readdir(path.join(root, account, org));
        } catch {
          continue;
        }
        for (const name of names) {
          if (!RECORD_FILE.test(name)) continue;
          const file = path.join(root, account, org, name);
          seen.add(file);
          try {
            const info = await stat(file);
            let cached = recordCache.get(file);
            if (cached === undefined || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
              cached = { mtimeMs: info.mtimeMs, size: info.size, chat: parseRecord(await readFile(file, "utf8")) };
              recordCache.set(file, cached);
            }
            if (cached.chat !== null) chats.push(cached.chat);
          } catch (error) {
            // A record being rewritten reads as broken JSON: it is read again next time.
            recordCache.delete(file);
            warnings.push(`Claude app: could not read ${file}: ${String(error)}`);
          }
        }
      }
    }
  }
  for (const file of recordCache.keys()) if (!seen.has(file)) recordCache.delete(file);
  return chats;
}

/**
 * The Claude Code chats as the app shows them: each desktop chat once, as its
 * current session (or, when that file is missing, its most recent listed
 * one), titled as in the app (when it has a title), in the app's folder,
 * last updated when any of its sessions was. Its fork origin is the chat the
 * app records it was forked from; a chat detached to the top level, or not a
 * fork in the app, has none. Only when the app's origin is not listed does the
 * origin read from the session files count. A side chat's origin is the chat
 * it was opened from, and it is marked `sideChat`. The sessions it replaced
 * are left out, and forks of them are moved to it.
 */
export function applyDesktopChats(chats: ScannedChat[], desktop: DesktopChat[]): ScannedChat[] {
  const byKey = new Map(chats.filter((c) => c.client === "claude").map((c) => [chatKey(c.client, c.id), c]));
  // A session that is some chat's current one is never hidden as another's prior.
  const currents = new Set(desktop.map((d) => chatKey("claude", d.current)));
  /** Replaced session -> the session shown for its chat. */
  const shownFor = new Map<string, ScannedChat>();
  const replaced = new Map<string, ScannedChat>();
  /** The app's chat id -> the session shown for it. */
  const shownByLocal = new Map<string, ScannedChat>();
  const shownRecords: [DesktopChat, ScannedChat][] = [];

  for (const record of desktop) {
    const memberKeys = [record.current, ...record.priors]
      .map((id) => chatKey("claude", id))
      .filter((key, index) => index === 0 || !currents.has(key));
    const members = memberKeys.map((key) => byKey.get(key)).filter((c): c is ScannedChat => c !== undefined);
    if (members.length === 0) continue;
    const shown = byKey.get(memberKeys[0]!) ?? members.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    const shownKey = chatKey("claude", shown.id);
    const memberSet = new Set(memberKeys);
    // The chain's own origin: a fork origin outside the chain, oldest member first.
    let forkOf: string | null = null;
    for (const member of [...members].sort((a, b) => a.updatedAt - b.updatedAt)) {
      if (member.forkOf !== null && !memberSet.has(chatKey("claude", member.forkOf))) {
        forkOf = member.forkOf;
        break;
      }
    }
    replaced.set(shownKey, {
      ...shown,
      title: record.title ?? shown.title,
      cwd: record.cwd ?? shown.cwd,
      forkOf,
      updatedAt: Math.max(...members.map((m) => m.updatedAt)),
    });
    for (const key of memberKeys) if (key !== shownKey) shownFor.set(key, shown);
    if (record.localId !== "") shownByLocal.set(record.localId, shown);
    shownRecords.push([record, shown]);
  }

  // The app's fork tree, once every chat's shown session is known.
  for (const [record, shown] of shownRecords) {
    const key = chatKey("claude", shown.id);
    const merged = replaced.get(key)!;
    // A side chat belongs to the chat it was opened from, when that one is listed.
    const sideParent = record.sideOf === null ? undefined : shownByLocal.get(record.sideOf);
    if (sideParent !== undefined && chatKey("claude", sideParent.id) !== key) {
      merged.forkOf = sideParent.id;
      merged.sideChat = true;
      continue;
    }
    const parent = record.forkedFrom === null ? undefined : shownByLocal.get(record.forkedFrom);
    if (record.forkedFrom === null) merged.forkOf = null;
    else if (parent !== undefined && chatKey("claude", parent.id) !== key) merged.forkOf = parent.id;
  }

  const result: ScannedChat[] = [];
  for (const chat of chats) {
    const key = chatKey(chat.client, chat.id);
    if (chat.client === "claude" && shownFor.has(key)) continue;
    const next = replaced.get(key) ?? chat;
    const origin = next.client === "claude" && next.forkOf !== null ? shownFor.get(chatKey("claude", next.forkOf)) : undefined;
    // Forks of a replaced session hang under the chat it belongs to (never under themselves).
    result.push(origin === undefined || chatKey("claude", origin.id) === key ? next : { ...next, forkOf: origin.id });
  }
  return result;
}
