// Claude Code's session store: listing metadata (folder, title, first prompt)
// and fork origin of each session file under `<config>/projects`.
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { UUID } from "../shared/contract";
import { normalizeCwd, TITLE_MAX, type ScannedChat } from "./scanned-chat";
import { oneLine } from "../shared/text";

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;

export function claudeProjectsDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configured ? configured : path.join(homedir(), ".claude"), "projects");
}

// ---------------------------------------------------------------- text

const WRAPPER_TAGS =
  /^\s*<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|ide_[a-z_]+|environment_context|user_instructions|bash-[a-z-]+)>[\s\S]*?<\/\1>/;

function cleanPrompt(text: string): string {
  let rest = text;
  for (let match = WRAPPER_TAGS.exec(rest); match; match = WRAPPER_TAGS.exec(rest)) {
    rest = rest.slice(match[0].length);
  }
  if (rest.trimStart().startsWith("Caveat:")) return "";
  return oneLine(rest, TITLE_MAX);
}

// ---------------------------------------------------------------- metadata

interface ClaudeMeta {
  cwd: string | null;
  firstPrompt: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summary: string | null;
  entrypoint: string | null;
}

async function readSlices(file: string, size: number): Promise<{ head: string; tail: string; headEnd: number }> {
  const handle = await open(file, "r");
  try {
    const headLength = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    if (size <= HEAD_BYTES) return { head: head.toString("utf8"), tail: "", headEnd: size };
    const tailLength = Math.min(size - headLength, TAIL_BYTES);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    // Where the head's last whole line ends: the line cut by the head is read from there.
    const headEnd = head.lastIndexOf(0x0a) + 1;
    return { head: head.toString("utf8"), tail: tail.toString("utf8"), headEnd };
  } finally {
    await handle.close();
  }
}

const MIDDLE_CHUNK_BYTES = 1024 * 1024;
/** Records too large to hold a folder or a prompt are skipped without parsing. */
const SNAPSHOT_LINE = '{"type":"file-history-snapshot"';

/**
 * Fill in the folder and first prompt from past the head. A long session
 * resumed in the Claude app can start with megabytes of file snapshots before
 * its first message, so neither is in the head.
 */
async function readMiddle(file: string, from: number, size: number, meta: ClaudeMeta): Promise<void> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(MIDDLE_CHUNK_BYTES);
    let carry = "";
    for (let position = from; position < size && (meta.cwd === null || meta.firstPrompt === null); ) {
      const { bytesRead } = await handle.read(buffer, 0, MIDDLE_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const lines = (carry + buffer.toString("utf8", 0, bytesRead)).split("\n");
      carry = lines.pop() ?? "";
      if (carry.startsWith(SNAPSHOT_LINE)) carry = SNAPSHOT_LINE; // only its start matters
      fillStart(meta, lines.filter((line) => !line.startsWith(SNAPSHOT_LINE)).join("\n"));
    }
    if (carry !== "" && !carry.startsWith(SNAPSHOT_LINE)) fillStart(meta, carry);
  } finally {
    await handle.close();
  }
}

/** The folder, entry point and first prompt, where the meta has none yet. */
function fillStart(meta: ClaudeMeta, text: string): void {
  for (const record of jsonLines(text)) {
    if (meta.cwd === null && typeof record.cwd === "string") meta.cwd = record.cwd;
    if (meta.entrypoint === null && typeof record.entrypoint === "string") meta.entrypoint = record.entrypoint;
    if (meta.firstPrompt === null) {
      const prompt = userText(record);
      const cleaned = prompt === null ? "" : cleanPrompt(prompt);
      if (cleaned !== "") meta.firstPrompt = cleaned;
    }
    if (meta.cwd !== null && meta.firstPrompt !== null) return;
  }
}

function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object") yield value as Record<string, unknown>;
    } catch {
      // Partial line at a slice boundary.
    }
  }
}

function userText(record: Record<string, unknown>): string | null {
  if (record.type !== "user" || record.isMeta === true) return null;
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // The Claude app can send a reminder and the prompt as separate text blocks.
    const texts = content
      .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string);
    if (texts.length > 0) return texts.join("\n");
  }
  return null;
}

function parseClaude(head: string, tail: string): ClaudeMeta {
  const meta: ClaudeMeta = {
    cwd: null,
    firstPrompt: null,
    customTitle: null,
    aiTitle: null,
    summary: null,
    entrypoint: null,
  };
  // The folder and first prompt come from the start of the session only: the
  // tail can name a folder the session moved to later, which is not the folder
  // Claude Code files (and resumes) the session under. When the head has
  // neither, `readMiddle` reads on from it. Later records win for titles, so
  // the tail is read after the head.
  fillStart(meta, head);
  for (const record of [...jsonLines(head), ...jsonLines(tail)]) {
    if (record.type === "custom-title" && typeof record.customTitle === "string") meta.customTitle = record.customTitle;
    if (record.type === "ai-title" && typeof record.aiTitle === "string") meta.aiTitle = record.aiTitle;
    if (record.type === "summary" && typeof record.summary === "string") meta.summary = record.summary;
  }
  return meta;
}

// ---------------------------------------------------------------- forks

const claudeCache = new Map<string, { mtimeMs: number; size: number; meta: ClaudeMeta }>();
/** Fork origin per session file; a fork's copied prefix never changes, so it is read once. */
export const claudeForkCache = new Map<string, string | null>();

const SESSION_ID = /"sessionId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
const FORKED_FROM = /"forkedFrom":\{[^}]*"sessionId":"([0-9a-f-]{36})"/i;
const FORK_CHUNK_BYTES = 1024 * 1024;

/**
 * Resolve a Claude Code session's fork origin. Newer versions write
 * `forkedFrom`; older forks start with a copy of the parent's history whose
 * records keep the ancestors' session ids, so the last foreign id before the
 * session's own records is its direct parent. Returns undefined while no
 * record carries a session id yet, so a file still being written is re-read
 * on the next scan instead of being remembered as not forked.
 */
async function claudeForkOf(file: string, id: string, head: string): Promise<string | null | undefined> {
  const explicit = FORKED_FROM.exec(head)?.[1];
  if (explicit !== undefined) return explicit.toLowerCase();
  SESSION_ID.lastIndex = 0;
  const first = SESSION_ID.exec(head)?.[1]?.toLowerCase();
  if (first === undefined) return undefined;
  if (first === id.toLowerCase()) return null;

  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(FORK_CHUNK_BYTES);
    let parent: string | null = null;
    let carry = "";
    for (let position = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, FORK_CHUNK_BYTES, position);
      if (bytesRead === 0) return parent;
      position += bytesRead;
      // Keep a short tail so a match split across chunks is still found.
      const text = carry + buffer.toString("utf8", 0, bytesRead);
      SESSION_ID.lastIndex = 0;
      for (let match = SESSION_ID.exec(text); match; match = SESSION_ID.exec(text)) {
        const sessionId = match[1]!.toLowerCase();
        if (sessionId === id.toLowerCase()) return parent;
        parent = sessionId;
      }
      carry = text.slice(-64);
    }
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------- scan

/**
 * Read one Claude Code session file: its listing metadata (cached by mtime and
 * size) and fork origin. Null when the file is gone or holds nothing to resume.
 */
export async function readClaudeChat(file: string, id: string, warnings: string[]): Promise<ScannedChat | null> {
  let info;
  try {
    info = await stat(file);
  } catch {
    claudeCache.delete(file);
    claudeForkCache.delete(file);
    return null;
  }
  try {
    let cached = claudeCache.get(file);
    // The head read for the metadata also serves the fork lookup below.
    let head: string | undefined;
    if (cached === undefined || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
      const slices = await readSlices(file, info.size);
      head = slices.head;
      const meta = parseClaude(slices.head, slices.tail);
      if ((meta.cwd === null || meta.firstPrompt === null) && info.size > HEAD_BYTES) {
        await readMiddle(file, slices.headEnd, info.size, meta);
      }
      cached = { mtimeMs: info.mtimeMs, size: info.size, meta };
      claudeCache.set(file, cached);
    }
    const { meta } = cached;
    // No cwd or no user prompt: nothing to resume.
    if (meta.cwd === null || meta.firstPrompt === null) return null;
    let forkOf = claudeForkCache.get(file);
    if (forkOf === undefined) {
      head ??= (await readSlices(file, Math.min(info.size, HEAD_BYTES))).head;
      const origin = await claudeForkOf(file, id, head);
      // Only settled origins are remembered; an unknown one is read again next scan.
      if (origin !== undefined) claudeForkCache.set(file, origin);
      forkOf = origin ?? null;
    }
    const title = oneLine(meta.customTitle ?? meta.aiTitle ?? meta.summary ?? meta.firstPrompt, TITLE_MAX);
    return {
      client: "claude",
      id,
      title: title === "" ? id : title,
      updatedAt: Math.round(info.mtimeMs),
      cwd: normalizeCwd(meta.cwd),
      // bb's Claude sessions record `entrypoint` "sdk-cli", as does any Agent SDK
      // session (including the chat view's own), so only the folder test in
      // `scan` identifies them.
      fromBb: false,
      forkOf,
    };
  } catch (error) {
    warnings.push(`Claude Code: could not read ${file}: ${String(error)}`);
    return null;
  }
}

/** The session id of a Claude Code session file `<projects>/<dir>/<uuid>.jsonl`, else null. */
export function claudeSessionId(root: string, file: string): string | null {
  const parts = path.relative(root, file).split(/[\\/]/);
  if (parts.length !== 2 || !parts[1]!.endsWith(".jsonl")) return null;
  const id = parts[1]!.slice(0, -".jsonl".length);
  return UUID.test(id) ? id : null;
}

export async function scanClaude(warnings: string[]): Promise<ScannedChat[]> {
  const root = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    warnings.push(`Claude Code: no session store at ${root}`);
    return [];
  }
  const chats: ScannedChat[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!UUID.test(id)) continue;
      const file = path.join(root, dir, name);
      seen.add(file);
      const chat = await readClaudeChat(file, id, warnings);
      if (chat !== null) chats.push(chat);
    }
  }
  for (const file of claudeCache.keys()) if (!seen.has(file)) claudeCache.delete(file);
  for (const file of claudeForkCache.keys()) if (!seen.has(file)) claudeForkCache.delete(file);
  return chats;
}
