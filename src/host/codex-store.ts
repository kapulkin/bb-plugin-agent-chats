// Codex's store: threads from its SQLite thread index (`state_<n>.sqlite`)
// and each thread's fork origin from the first line of its rollout file.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Transform } from "node:stream";
import zlib from "node:zlib";
import { UUID } from "../shared/contract";
import { normalizeCwd, TITLE_MAX, type ScannedChat } from "./scanned-chat";
import { oneLine } from "../shared/text";

export function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : path.join(homedir(), ".codex");
}

interface SqliteModule {
  DatabaseSync: new (
    file: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { all(): Record<string, unknown>[] };
    close(): void;
  };
}

async function codexStateDb(home: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(home);
  } catch {
    return null;
  }
  let best: { version: number; name: string } | null = null;
  for (const name of names) {
    const match = /^state_(\d+)\.sqlite$/.exec(name);
    if (match && (best === null || Number(match[1]) > best.version)) best = { version: Number(match[1]), name };
  }
  return best === null ? null : path.join(home, best.name);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

// ---------------------------------------------------------------- forks

/** Fork origin per Codex thread id, read once from its rollout's first line. */
export const codexForkCache = new Map<string, string | null>();
const FIRST_LINE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The first line of a Codex rollout file. Codex compresses older rollouts to
 * `<rollout>.zst` and leaves the index pointing at the uncompressed name, so
 * both are tried. Returns null when neither exists or can be read.
 */
async function readRolloutFirstLine(rolloutPath: string): Promise<string | null> {
  const plain = normalizeCwd(rolloutPath);
  const candidates = plain.endsWith(".zst") ? [plain] : [plain, `${plain}.zst`];
  for (const file of candidates) {
    try {
      await stat(file);
    } catch {
      continue;
    }
    const zstd = file.endsWith(".zst") ? zstdDecompressor() : null;
    if (file.endsWith(".zst") && zstd === null) return null;
    const source = createReadStream(file);
    const stream: Readable = zstd === null ? source : source.pipe(zstd);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const newline = chunk.indexOf(0x0a);
        chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
        size += chunk.length;
        if (newline !== -1 || size >= FIRST_LINE_MAX_BYTES) break;
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch {
      return null;
    } finally {
      source.destroy();
      zstd?.destroy();
    }
  }
  return null;
}

/** zstd decompression when the host's Node provides it (Node 22.15+ / 23.8+). */
function zstdDecompressor(): Transform | null {
  const factory = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
  return typeof factory === "function" ? factory() : null;
}

/**
 * `forked_from_id` from the `session_meta` record that opens a Codex rollout
 * file. Returns undefined when the rollout is missing or its first line is not
 * a complete `session_meta` record yet (a thread Codex is still creating), so
 * the next scan reads it again instead of remembering it as not forked.
 */
async function codexForkOf(rolloutPath: string): Promise<string | null | undefined> {
  const line = await readRolloutFirstLine(rolloutPath);
  if (line === null) return undefined;
  try {
    const record = JSON.parse(line) as { type?: unknown; payload?: { forked_from_id?: unknown } };
    if (record.type !== "session_meta") return undefined;
    const forkedFrom = record.payload?.forked_from_id;
    return typeof forkedFrom === "string" && UUID.test(forkedFrom) ? forkedFrom.toLowerCase() : null;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- scan

/** Codex threads from the thread index; null when the index exists but could not be read. */
export async function scanCodex(warnings: string[]): Promise<ScannedChat[] | null> {
  const home = codexHome();
  const dbFile = await codexStateDb(home);
  if (dbFile === null) {
    warnings.push(`Codex: no thread index (state_*.sqlite) in ${home}`);
    return [];
  }
  let sqlite: SqliteModule;
  try {
    sqlite = (await import("node:sqlite")) as unknown as SqliteModule;
  } catch {
    warnings.push(`Codex: this runtime (Node ${process.versions.node}) has no node:sqlite`);
    return [];
  }
  let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
  try {
    // Opening fails on a locked or damaged index; the caller keeps the last listing.
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare("SELECT * FROM threads WHERE archived = 0").all();
    const chats: ScannedChat[] = [];
    for (const row of rows) {
      const id = row.id;
      const cwd = row.cwd;
      if (typeof id !== "string" || !UUID.test(id) || typeof cwd !== "string" || cwd === "") continue;
      // Subagent and reviewer threads are internal to a parent chat.
      if (typeof row.source === "string" && row.source.includes("subagent")) continue;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const first = typeof row.title === "string" ? row.title : "";
      const title = oneLine(name !== "" ? name : first, TITLE_MAX);
      const updatedAt =
        asNumber(row.updated_at_ms) ??
        (asNumber(row.updated_at) ?? 0) * 1000;
      let forkOf = codexForkCache.get(id);
      if (forkOf === undefined) {
        const origin = typeof row.rollout_path === "string" ? await codexForkOf(row.rollout_path) : undefined;
        // Only settled origins are remembered; an unknown one is read again next scan.
        if (origin !== undefined) codexForkCache.set(id, origin);
        forkOf = origin ?? null;
      }
      // An untitled thread never received a prompt, unless it is a fork, which
      // Codex leaves untitled until its first new turn; `scan` names it.
      if (title === "" && forkOf === null) continue;
      chats.push({
        client: "codex",
        id,
        title,
        updatedAt,
        cwd: normalizeCwd(cwd),
        fromBb: row.originator === "bb",
        forkOf,
      });
    }
    return chats;
  } catch (error) {
    warnings.push(`Codex: could not read the thread index ${dbFile}: ${String(error)}`);
    return null;
  } finally {
    db?.close();
  }
}
