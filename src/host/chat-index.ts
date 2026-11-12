// The chat index: every listed chat of both stores, built by a full scan and
// then kept current from the store watch, grouped into projects with forks
// nested under their origin. Fork origins persist across worker restarts.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ChatClient, ListResult, Project } from "../shared/contract";
import { chatKey, isInside, projectKey, type HostContext, type ScannedChat } from "./scanned-chat";
import { applyDesktopChats, claudeDesktopRoots, isDesktopRecord, readDesktopChats, type DesktopChat } from "./claude-desktop";
import { claudeForkCache, claudeProjectsDir, claudeSessionId, readClaudeChat, scanClaude } from "./claude-store";
import { codexForkCache, codexHome, scanCodex } from "./codex-store";

const lastScan = new Map<string, ScannedChat>();

// ---------------------------------------------------------------- grouping

// The desktop apps give each chat started without a project its own scratch
// folder; all of them share one group. Codex Desktop:
// <home>/Documents/Codex/<yyyy-mm-dd>/<slug>. The Claude app:
// <LOCALAPPDATA>/Claude-Data/<instance>/scratch-workspaces/<account>/<org>/scratch-<date>-<id>.
const SCRATCH_FOLDERS = [
  /^(.*[\\/]Documents[\\/]Codex)[\\/]\d{4}-\d{2}-\d{2}[\\/][^\\/]+$/i,
  /^(.*[\\/]Claude-Data[\\/][^\\/]+[\\/]scratch-workspaces)[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+$/i,
];
/** The key of the shared group; not a folder key, so no project folder can collide with it. */
const SCRATCH_KEY = "scratch:";

function groupFor(cwd: string): { key: string; path: string; name: string } {
  for (const pattern of SCRATCH_FOLDERS) {
    const scratch = pattern.exec(cwd);
    if (scratch) return { key: SCRATCH_KEY, path: scratch[1]!, name: "Chats without a project" };
  }
  return { key: projectKey(cwd), path: cwd, name: path.basename(cwd) || cwd };
}

const MAX_FORK_DEPTH = 2;

/**
 * Where each chat appears in the fork tree: under its fork origin, with forks
 * deeper than MAX_FORK_DEPTH lifted to their ancestor at that depth's parent
 * level. Only chats shown in the same project and client take part; a fork
 * whose origin is not among them is top-level.
 */
function displayParents(chats: ScannedChat[]): Map<string, string | null> {
  const byKey = new Map(chats.map((chat) => [chatKey(chat.client, chat.id), chat]));
  const parents = new Map<string, string | null>();
  for (const chat of chats) {
    // A side chat stays directly under the chat it was opened from.
    if (chat.sideChat === true) {
      const parent = chat.forkOf === null ? undefined : byKey.get(chatKey(chat.client, chat.forkOf));
      parents.set(chatKey(chat.client, chat.id), parent === undefined ? null : parent.id);
      continue;
    }
    // Ancestors nearest first: [parent, grandparent, ..., root]. A side chat is
    // the root of its own forks, which nest inside its "Side chats" folder.
    const ancestors: ScannedChat[] = [];
    const visited = new Set([chatKey(chat.client, chat.id)]);
    for (let origin = chat.forkOf; origin !== null; ) {
      const key = chatKey(chat.client, origin);
      const ancestor = byKey.get(key);
      if (ancestor === undefined || visited.has(key)) break;
      visited.add(key);
      ancestors.push(ancestor);
      if (ancestor.sideChat === true && byKey.has(chatKey(chat.client, ancestor.forkOf ?? ""))) break;
      origin = ancestor.forkOf;
    }
    const depth = Math.min(ancestors.length, MAX_FORK_DEPTH);
    // depth 1 -> the root; depth 2 and deeper -> the root's child on this branch.
    parents.set(chatKey(chat.client, chat.id), depth === 0 ? null : ancestors[ancestors.length - depth]!.id);
  }
  return parents;
}

/** bb's data dir: the ancestor of this plugin's host data dir named by `plugins`. */
function bbDataDir(pluginDataDir: string): string {
  const marker = `${path.sep}plugins${path.sep}`;
  const index = pluginDataDir.lastIndexOf(marker);
  return index > 0 ? pluginDataDir.slice(0, index) : path.join(homedir(), ".bb");
}

// ---------------------------------------------------------------- fork cache

// Fork origins never change, but finding a Claude Code fork's parent can read
// megabytes of copied history, so they persist across host worker restarts.
const FORK_CACHE_FILE = "fork-origins.json";
/** Bumped when origins were computed wrongly; version 2 reads compressed Codex rollouts. */
const FORK_CACHE_VERSION = 2;
let forkCacheLoaded = false;

async function loadForkCaches(pluginDataDir: string): Promise<void> {
  if (forkCacheLoaded) return;
  forkCacheLoaded = true;
  try {
    const saved = JSON.parse(await readFile(path.join(pluginDataDir, FORK_CACHE_FILE), "utf8")) as {
      version?: number;
      claude?: Record<string, string | null>;
      codex?: Record<string, string | null>;
    };
    for (const [file, origin] of Object.entries(saved.claude ?? {})) claudeForkCache.set(file, origin);
    // Before version 2, compressed Codex rollouts were recorded as not forked.
    if (saved.version === FORK_CACHE_VERSION) {
      for (const [id, origin] of Object.entries(saved.codex ?? {})) codexForkCache.set(id, origin);
    }
  } catch {
    // First run, or an unreadable cache: origins are recomputed.
  }
}

async function saveForkCaches(pluginDataDir: string): Promise<void> {
  await mkdir(pluginDataDir, { recursive: true });
  const saved = {
    version: FORK_CACHE_VERSION,
    claude: Object.fromEntries(claudeForkCache),
    codex: Object.fromEntries(codexForkCache),
  };
  await writeFile(path.join(pluginDataDir, FORK_CACHE_FILE), JSON.stringify(saved));
}

// ---------------------------------------------------------------- refresh

// The chat index (`lastScan`) is built by a full scan of both stores, then kept
// current from the store watch: changed Claude Code session files are reread
// one by one, and the Codex thread index (one query) is reread when any Codex
// file changed. Anything the watch cannot vouch for falls back to a full scan.

/** Claude Code session files the watch reported since the last refresh. */
const pendingClaudeFiles = new Set<string>();
/** Whether the watch reported a Codex change since the last refresh. */
let codexChanged = false;
/** Set when the watch overflowed: the next refresh rereads both stores. */
let fullScanNeeded = true;
/** Whether the watch reported a changed Claude app chat record since the last refresh. */
let desktopChanged = false;
/** The Claude app's chat records as last read. */
let desktopChats: DesktopChat[] = [];
/** Warnings of the Claude app records' last read. */
let desktopWarnings: string[] = [];
/** Warnings of each store's last read. */
const storeWarnings: Record<ChatClient, string[]> = { claude: [], codex: [] };

function replaceClient(client: ChatClient, chats: ScannedChat[]): void {
  for (const [key, chat] of lastScan) if (chat.client === client) lastScan.delete(key);
  for (const chat of chats) lastScan.set(chatKey(chat.client, chat.id), chat);
}

/** Bring the chat index up to date, rereading only what changed when possible. */
async function refreshIndex(force: boolean, pluginDataDir: string): Promise<void> {
  await loadForkCaches(pluginDataDir);
  const knownOrigins = claudeForkCache.size + codexForkCache.size;
  // A store the watch does not cover (not watched yet, or missing) cannot be
  // refreshed from its reports, so it is reread in full; the other one is not.
  const fullClaude = force || fullScanNeeded || !watching.has("claude");
  const fullCodex = force || fullScanNeeded || !watching.has("codex");
  const files = [...pendingClaudeFiles];
  const codex = codexChanged;
  // Records are reread whenever the watch cannot vouch for them (cheap: unchanged files are not read).
  const desktop = fullClaude || desktopChanged || watchingDesktop.size === 0;
  const rescan = fullScanNeeded;
  pendingClaudeFiles.clear();
  codexChanged = false;
  desktopChanged = false;
  fullScanNeeded = false;

  try {
    const claudeWarnings: string[] = [];
    const codexWarnings: string[] = [];
    const [claudeChats, codexChats] = await Promise.all([
      fullClaude ? scanClaude(claudeWarnings) : undefined,
      fullCodex || codex ? scanCodex(codexWarnings) : undefined,
    ]);
    if (claudeChats !== undefined) {
      replaceClient("claude", claudeChats);
      storeWarnings.claude = claudeWarnings;
    } else {
      const root = claudeProjectsDir();
      for (const file of files) {
        const id = claudeSessionId(root, file);
        if (id === null) continue;
        const chat = await readClaudeChat(file, id, storeWarnings.claude);
        if (chat === null) lastScan.delete(chatKey("claude", id));
        else lastScan.set(chatKey("claude", id), chat);
      }
    }
    if (desktop) {
      const warnings: string[] = [];
      desktopChats = await readDesktopChats(warnings);
      desktopWarnings = warnings;
    }
    if (codexChats !== undefined) {
      // An index that could not be read keeps the last listing and is read again next time.
      if (codexChats === null) codexChanged = true;
      else replaceClient("codex", codexChats);
      storeWarnings.codex = codexWarnings;
    }
  } catch (error) {
    // Nothing reported is lost: the next refresh reads it again.
    for (const file of files) pendingClaudeFiles.add(file);
    if (codex) codexChanged = true;
    if (desktop) desktopChanged = true;
    if (rescan) fullScanNeeded = true;
    throw error;
  }
  if (claudeForkCache.size + codexForkCache.size !== knownOrigins) {
    await saveForkCaches(pluginDataDir).catch((error) =>
      storeWarnings.claude.push(`Could not save fork origins: ${String(error)}`),
    );
  }
}

/** One index refresh at a time; a refresh requested meanwhile runs after it. */
let indexQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(task, task);
  indexQueue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------- listing

/** A chat's title, or for an untitled fork its origin's title (never a derived one). */
function titleWith(chat: ScannedChat, origin: ScannedChat | undefined): string {
  if (chat.title !== "" || chat.forkOf === null) return chat.title;
  return origin === undefined || origin.title === "" ? "Forked chat" : `${origin.title} (fork)`;
}

/**
 * A chat's listed title: the Claude app's title for one of its chats, else
 * the stored one; an untitled fork takes its origin's title.
 */
export function displayTitle(stored: ScannedChat): string {
  const [chat = stored] = applyDesktopChats([stored], desktopChats);
  const origin = chat.forkOf === null ? undefined : lastScan.get(chatKey(chat.client, chat.forkOf));
  return titleWith(chat, origin === undefined ? undefined : (applyDesktopChats([origin], desktopChats)[0] ?? origin));
}

/** The listing: the index brought up to date, grouped by project, newest first. */
export async function scan(includeBbChats: boolean, force: boolean, pluginDataDir: string): Promise<ListResult> {
  await serialized(() => refreshIndex(force, pluginDataDir));
  const warnings = [...new Set([...storeWarnings.claude, ...desktopWarnings, ...storeWarnings.codex])];
  const merged = applyDesktopChats([...lastScan.values()], desktopChats);
  const byKey = new Map(merged.map((chat) => [chatKey(chat.client, chat.id), chat]));
  // Copies, titled from `merged`: a fork title never derives from another derived one.
  const all = merged.map((chat) =>
    chat.title === "" && chat.forkOf !== null
      ? { ...chat, title: titleWith(chat, byKey.get(chatKey(chat.client, chat.forkOf))) }
      : chat,
  );
  const listed = new Map(all.map((chat) => [chatKey(chat.client, chat.id), chat]));

  const bbRoot = bbDataDir(pluginDataDir);
  const projects = new Map<string, Project>();
  for (const chat of all) {
    if (!includeBbChats && (chat.fromBb || isInside(chat.cwd, bbRoot))) continue;
    const group = groupFor(chat.cwd);
    let project = projects.get(group.key);
    if (project === undefined) {
      project = { ...group, updatedAt: 0, chats: [] };
      projects.set(group.key, project);
    } else if (group.key === SCRATCH_KEY && !project.path.split("\n").includes(group.path)) {
      // The shared scratch group lists each app's scratch root, one per line, in a stable order.
      project.path = [...project.path.split("\n"), group.path].sort().join("\n");
    }
    project.chats.push({ client: chat.client, id: chat.id, title: chat.title, updatedAt: chat.updatedAt, parentId: null });
    project.updatedAt = Math.max(project.updatedAt, chat.updatedAt);
  }
  for (const project of projects.values()) {
    const members = project.chats.map((chat) => listed.get(chatKey(chat.client, chat.id))!);
    const parents = displayParents(members);
    for (const chat of project.chats) {
      chat.parentId = parents.get(chatKey(chat.client, chat.id)) ?? null;
      // Only a side chat shown under its parent goes into a "Side chats" folder.
      if (chat.parentId !== null && listed.get(chatKey(chat.client, chat.id))!.sideChat === true) chat.sideChat = true;
    }
  }
  const sorted = [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const project of sorted) project.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  return { projects: sorted, warnings, scannedAt: Date.now() };
}

/** An id missing from the index forces a full rescan at most this often. */
const MISSING_RESCAN_MS = 10_000;
/** When each missing id last forced a rescan. */
const missingRescans = new Map<string, number>();

/**
 * Resolves a chat from the last scan, rescanning when it is missing (a chat
 * created since). Asking again for the same missing id within
 * MISSING_RESCAN_MS does not rescan again.
 */
export async function findChat(client: ChatClient, id: string, pluginDataDir: string): Promise<ScannedChat> {
  const key = chatKey(client, id);
  let chat = lastScan.get(key);
  const now = Date.now();
  if (chat === undefined && now - (missingRescans.get(key) ?? 0) >= MISSING_RESCAN_MS) {
    for (const [missing, at] of missingRescans) if (now - at >= MISSING_RESCAN_MS) missingRescans.delete(missing);
    missingRescans.set(key, now);
    await scan(true, true, pluginDataDir);
    chat = lastScan.get(key);
  }
  if (chat === undefined) throw new Error(`No ${client} chat with id ${id}`);
  return chat;
}

// ---------------------------------------------------------------- watch

/** A store write is reported once it has been quiet this long, or after the max wait. */
const WATCH_DEBOUNCE_MS = 2000;
const WATCH_MAX_WAIT_MS = 10_000;

/** Clients whose store this worker watches; a new worker starts with none. */
const watching = new Set<ChatClient>();
/** The Claude app record folders this worker watches. */
const watchingDesktop = new Set<string>();

/** Whether a changed path can change the chat list for that client. */
function isChatChange(client: ChatClient, root: string, changed: string): boolean {
  const relative = path.relative(root, changed).replaceAll("\\", "/");
  if (client === "claude") return relative.endsWith(".jsonl");
  // Codex: thread logs, and the thread index with its write-ahead log.
  return (
    (relative.startsWith("sessions/") && /\.jsonl(\.zst)?$/.test(relative)) ||
    /^state_\d+\.sqlite(-wal)?$/.test(relative)
  );
}

/**
 * Watch each store's folder and tell the server when chats may have changed.
 * The server repeats this request, so a store folder that is missing now, or
 * whose watch failed, is watched once it can be; until then every refresh
 * rereads that store in full.
 */
export async function watchStores(context: HostContext): Promise<ChatClient[]> {
  const stores: [ChatClient, string][] = [
    ["claude", claudeProjectsDir()],
    ["codex", codexHome()],
  ];
  let failure: unknown = null;
  for (const [client, root] of stores) {
    if (watching.has(client)) continue;
    try {
      if (!(await stat(root)).isDirectory()) continue;
    } catch {
      continue;
    }
    const notify = () => context.experimental_emitSignal("changed", { client }).catch(() => undefined);
    try {
      await context.experimental_watch(
        { rootPath: root, debounceMs: WATCH_DEBOUNCE_MS, maxWaitMs: WATCH_MAX_WAIT_MS },
        (event) => {
          // After a watcher overflow the current state is unknown: reread everything.
          if (event.kind === "rescan-required") {
            fullScanNeeded = true;
            return notify();
          }
          if (event.kind !== "changed") return;
          const relevant = event.changes.filter((change) => isChatChange(client, root, change.path));
          if (relevant.length === 0) return;
          if (client === "codex") codexChanged = true;
          else for (const change of relevant) pendingClaudeFiles.add(change.path);
          return notify();
        },
      );
    } catch (error) {
      // The other store is still watched; this failure is reported below.
      failure ??= error;
      continue;
    }
    watching.add(client);
    // Changes made before the watch started were not reported: read once more in full.
    fullScanNeeded = true;
  }
  // The Claude app's chat records: a rename there or a new session in a chat's chain.
  for (const root of await claudeDesktopRoots()) {
    if (watchingDesktop.has(root)) continue;
    try {
      await context.experimental_watch(
        { rootPath: root, debounceMs: WATCH_DEBOUNCE_MS, maxWaitMs: WATCH_MAX_WAIT_MS },
        (event) => {
          if (event.kind === "changed" && !event.changes.some((change) => isDesktopRecord(root, change.path))) return;
          desktopChanged = true;
          return context.experimental_emitSignal("changed", { client: "claude" }).catch(() => undefined);
        },
      );
    } catch (error) {
      failure ??= error;
      continue;
    }
    watchingDesktop.add(root);
    desktopChanged = true;
  }
  if (failure !== null) throw failure;
  return [...watching];
}
