// Listing deltas shared by the server and the app. The server keeps the last
// listing it sent, diffs each new scan against it, and publishes only the
// changed rows; a viewer applies a delta only on top of the exact version it
// was computed from and refetches the whole listing otherwise.
import { z } from "zod";
import { chatSchema, clientSchema, type Chat, type ListResult } from "./contract";

/** A chat row with the project it belongs to. */
const chatRowSchema = chatSchema.extend({ projectKey: z.string() });
export type ChatRow = z.infer<typeof chatRowSchema>;

/** A project without its chats. */
const projectHeaderSchema = z.object({
  key: z.string(),
  path: z.string(),
  name: z.string(),
  updatedAt: z.number(),
});
type ProjectHeader = z.infer<typeof projectHeaderSchema>;

/** Realtime payload on `chats-changed`. */
export const chatsDeltaSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Too many changes for one message: refetch the listing instead. */
  reload: z.boolean(),
  projects: z.object({ upsert: z.array(projectHeaderSchema), remove: z.array(z.string()) }),
  chats: z.object({ upsert: z.array(chatRowSchema), remove: z.array(z.string()) }),
  warnings: z.array(z.string()),
});
export type ChatsDelta = z.infer<typeof chatsDeltaSchema>;

/** A listing in keyed form, which deltas apply to. */
export interface Listing {
  version: string;
  scannedAt: number;
  warnings: string[];
  projects: Map<string, ProjectHeader>;
  chats: Map<string, ChatRow>;
}

/** Chat rows are keyed by client and id; ids are unique only per client. */
const rowKey = (chat: { client: z.infer<typeof clientSchema>; id: string }) => `${chat.client}:${chat.id}`;

/** More changed rows than this are sent as `reload` rather than as rows. */
const MAX_DELTA_ROWS = 500;

export function toListing(result: ListResult, version: string): Listing {
  const projects = new Map<string, ProjectHeader>();
  const chats = new Map<string, ChatRow>();
  for (const { chats: projectChats, ...header } of result.projects) {
    projects.set(header.key, header);
    for (const chat of projectChats) chats.set(rowKey(chat), { ...chat, projectKey: header.key });
  }
  return { version, scannedAt: result.scannedAt, warnings: result.warnings, projects, chats };
}

/** Projects newest first, each with its chats newest first. */
export function toListResult(listing: Listing): ListResult {
  const byProject = new Map<string, Chat[]>();
  for (const { projectKey, ...chat } of listing.chats.values()) {
    const list = byProject.get(projectKey);
    if (list === undefined) byProject.set(projectKey, [chat]);
    else list.push(chat);
  }
  const projects = [...listing.projects.values()]
    .map((header) => ({
      ...header,
      chats: (byProject.get(header.key) ?? []).sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter((project) => project.chats.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { projects, warnings: listing.warnings, scannedAt: listing.scannedAt };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Rows added, changed, or removed between two listings; null when nothing changed. */
export function diffListings(previous: Listing, next: Listing): ChatsDelta | null {
  const delta: ChatsDelta = {
    from: previous.version,
    to: next.version,
    reload: false,
    projects: { upsert: [], remove: [] },
    chats: { upsert: [], remove: [] },
    warnings: next.warnings,
  };
  for (const [key, header] of next.projects) {
    if (!sameJson(previous.projects.get(key), header)) delta.projects.upsert.push(header);
  }
  for (const key of previous.projects.keys()) if (!next.projects.has(key)) delta.projects.remove.push(key);
  for (const [key, row] of next.chats) {
    if (!sameJson(previous.chats.get(key), row)) delta.chats.upsert.push(row);
  }
  for (const key of previous.chats.keys()) if (!next.chats.has(key)) delta.chats.remove.push(key);

  const rows =
    delta.projects.upsert.length + delta.projects.remove.length + delta.chats.upsert.length + delta.chats.remove.length;
  if (rows === 0 && sameJson(previous.warnings, next.warnings)) return null;
  if (rows > MAX_DELTA_ROWS) {
    return { ...delta, reload: true, projects: { upsert: [], remove: [] }, chats: { upsert: [], remove: [] } };
  }
  return delta;
}

/** The listing after `delta`, or null when it cannot apply and a refetch is needed. */
export function applyDelta(listing: Listing, delta: ChatsDelta): Listing | null {
  if (delta.reload || delta.from !== listing.version) return null;
  const projects = new Map(listing.projects);
  const chats = new Map(listing.chats);
  for (const key of delta.projects.remove) projects.delete(key);
  for (const header of delta.projects.upsert) projects.set(header.key, header);
  for (const key of delta.chats.remove) chats.delete(key);
  for (const row of delta.chats.upsert) chats.set(rowKey(row), row);
  return { version: delta.to, scannedAt: Date.now(), warnings: delta.warnings, projects, chats };
}
