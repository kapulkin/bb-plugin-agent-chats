// Shared wire contracts. The host entry (src/host.ts) reads the Claude Code and
// Codex stores on the machine, drives the chats open in chat views, and opens
// the desktop apps; the server (src/server.ts) forwards the app's RPC calls to it.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const clientSchema = z.enum(["claude", "codex"]);
export type ChatClient = z.infer<typeof clientSchema>;

/** Where a chat opens: `app` is the client's desktop app; `bb` resumes its CLI in a bb terminal tab. */
export const openViaSchema = z.enum(["app", "bb"]);
export type OpenVia = z.infer<typeof openViaSchema>;

export const chatSchema = z.object({
  client: clientSchema,
  id: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  /**
   * The chat this one is shown under: its fork origin, flattened so the tree
   * is at most two fork levels deep. Null for a top-level chat.
   */
  parentId: z.string().nullable(),
  /**
   * A Claude app side chat ("btw"), shown in a "Side chats" folder under its
   * parent (`parentId`) instead of as a fork. Absent for every other chat.
   */
  sideChat: z.literal(true).optional(),
});
export type Chat = z.infer<typeof chatSchema>;

const projectSchema = z.object({
  /** Normalized cwd used for grouping. */
  key: z.string(),
  path: z.string(),
  name: z.string(),
  updatedAt: z.number(),
  chats: z.array(chatSchema),
});
export type Project = z.infer<typeof projectSchema>;

/**
 * The key of the "Chats without a project" group (the desktop apps' scratch
 * folders). It is not a folder key, so no project folder collides with it, and
 * a new chat started from it runs where its client puts chats without a project.
 */
export const PROJECTLESS_KEY = "scratch:";

const listResultSchema = z.object({
  projects: z.array(projectSchema),
  warnings: z.array(z.string()),
  scannedAt: z.number(),
});
export type ListResult = z.infer<typeof listResultSchema>;

/** A Claude Code session id or a Codex thread id. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = z.string().regex(UUID);

const chatRefSchema = z.object({ client: clientSchema, id: uuid });

const openResultSchema = z.object({ message: z.string() });

// ---------------------------------------------------------------- chat view

/** One entry of a chat's conversation as the chat view renders it. */
const chatItemSchema = z.object({
  /** Claude Code: record uuid (+ `#n` for one block of it). Codex: item id. */
  id: z.string(),
  kind: z.enum(["user", "assistant", "tool", "notice"]),
  /** Codex turn id; null for Claude Code. */
  turnId: z.string().nullable(),
  text: z.string().nullable(),
  tool: z
    .object({
      name: z.string(),
      /** bb icon name for the row. */
      icon: z.string(),
      /** One readable line, e.g. "Searched: …" or "Ran: git status". */
      summary: z.string(),
      /** Pages the call opened or found. */
      links: z.array(z.object({ title: z.string(), url: z.string() })),
      /** The raw input, shown on demand. */
      input: z.string(),
      output: z.string().nullable(),
      status: z.string().nullable(),
    })
    .nullable(),
  /** File changes as one unified patch per file. */
  patches: z.array(z.object({ path: z.string(), diff: z.string() })).nullable(),
  /** User messages can be edited in place and forked from. */
  editable: z.boolean(),
});
export type ChatItem = z.infer<typeof chatItemSchema>;

/** A question the agent is waiting on (an approval, or input). */
const chatRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

const chatStatusSchema = z.enum(["idle", "running", "error"]);

/** The whole view state of one chat. */
const chatStateSchema = z.object({
  items: z.array(chatItemSchema),
  status: chatStatusSchema,
  error: z.string().nullable(),
  requests: z.array(chatRequestSchema),
  /** Events after this sequence number apply on top of this state. */
  seq: z.number(),
  /** The chat's folder, which relative file links in messages resolve against. */
  cwd: z.string().nullable(),
  /** bb host holding the chat's files; added by the server. */
  hostId: z.string().nullable().optional(),
});
export type ChatState = z.infer<typeof chatStateSchema>;

/**
 * A change to one open chat. `reset` means the history changed (a turn ended,
 * an edit or a revert) and the view reloads it; otherwise `upsert` items
 * replace items with the same id or are appended.
 */
export const chatEventSchema = z.object({
  client: clientSchema,
  id: z.string(),
  seq: z.number(),
  upsert: z.array(chatItemSchema).optional(),
  status: chatStatusSchema.optional(),
  error: z.string().nullable().optional(),
  requests: z.array(chatRequestSchema).optional(),
  reset: z.boolean().optional(),
});
export type ChatEvent = z.infer<typeof chatEventSchema>;

/** Realtime channel for chat view events. */
export const CHAT_EVENTS = "chat-events";

/** What editing a message will do to files, shown before the edit runs. */
const editPreviewSchema = z.object({
  /** Files that will be restored to their state before the edited message. */
  files: z.array(z.string()),
  /** Shown with the confirmation, e.g. that Codex does not undo files. */
  note: z.string().nullable(),
  /** The first Claude Code message cannot be rewritten in place: a new chat starts. */
  startsNewChat: z.boolean(),
});
export type EditPreview = z.infer<typeof editPreviewSchema>;

const chatMessageRefSchema = chatRefSchema.extend({ messageId: z.string().min(1) });
/** Where a new chat started in bb runs: a project folder of the listing. */
const newChatSchema = z.object({ client: clientSchema, cwd: z.string().min(1) });
/**
 * Where the desktop app starts a new chat: a project folder, or null for a chat
 * without a project, whose folder the app makes itself.
 */
const newAppChatSchema = z.object({ client: clientSchema, cwd: z.string().min(1).nullable() });
const chatResultRefSchema = z.object({ client: clientSchema, id: z.string() });

/** Chat view methods, identical on the host and on the server. */
const chatViewMethods = {
  /**
   * `attach`: a view opened the chat. The host keeps the chat's driver until
   * every attached view sent `chat_close`; reloads leave it out.
   */
  chat_load: { input: chatRefSchema.extend({ attach: z.boolean().optional() }).strict(), output: chatStateSchema },
  chat_send: { input: chatRefSchema.extend({ text: z.string().min(1).max(100_000) }).strict(), output: z.object({}) },
  chat_stop: { input: chatRefSchema.strict(), output: z.object({}) },
  chat_close: { input: chatRefSchema.strict(), output: z.object({}) },
  chat_edit_preview: { input: chatMessageRefSchema.strict(), output: editPreviewSchema },
  /** Returns the chat that continues: the same one, or a new one when `startsNewChat`. */
  chat_edit: {
    input: chatMessageRefSchema.extend({ text: z.string().min(1).max(100_000) }).strict(),
    output: chatResultRefSchema,
  },
  chat_fork: { input: chatMessageRefSchema.strict(), output: chatResultRefSchema },
  /**
   * Start a chat in `cwd`, a project folder of the listing, whose first turn
   * sends `text`. Returns the new chat, whose driver already runs that turn.
   */
  chat_new: { input: newChatSchema.extend({ text: z.string().min(1).max(100_000) }).strict(), output: chatResultRefSchema },
  chat_answer: {
    input: chatRefSchema.extend({ requestId: z.string().min(1), optionId: z.string().min(1) }).strict(),
    output: z.object({}),
  },
};

/** Host → server: a chat store changed on disk, or an open chat changed. */
export const hostSignals = {
  changed: {
    payload: z.object({ client: clientSchema }).strict(),
  },
  chatEvent: {
    payload: chatEventSchema,
  },
} satisfies ExperimentalHostSignals;

/** Realtime channel of listing changes; the payload is a `ChatsDelta` (shared/listing.ts). */
export const CHATS_CHANGED = "chats-changed";

export const hostContract = defineRpcContract({
  /** Start watching both chat stores; idempotent while the worker lives. */
  watch: {
    input: z.object({}).strict(),
    output: z.object({ watching: z.array(clientSchema) }),
  },
  /**
   * The listing. `force` rereads both stores; otherwise only the files the
   * store watch reported since the last scan are reread.
   */
  scan: {
    input: z.object({ includeBbChats: z.boolean(), force: z.boolean() }).strict(),
    output: listResultSchema,
  },
  /** Open the chat in its client's desktop app. */
  open: {
    input: chatRefSchema.strict(),
    output: openResultSchema,
  },
  /** The scanned folder and title of a chat whose folder still exists. */
  locate: {
    input: chatRefSchema.strict(),
    output: z.object({ cwd: z.string(), title: z.string() }),
  },
  /** The project folder a new chat starts in, for a bb terminal, checked against the listing. */
  new_chat_folder: {
    input: newChatSchema.strict(),
    output: z.object({ cwd: z.string() }),
  },
  /** Open the desktop app's new-chat screen in a listed project's folder, or without a project. */
  new_in_app: {
    input: newAppChatSchema.strict(),
    output: openResultSchema,
  },
  ...chatViewMethods,
});

export const rpcContract = defineRpcContract({
  /**
   * The current listing and its version. `force` rereads both stores (the
   * rescan button); without it the server's last listing is returned.
   */
  chats_list: {
    input: z.object({ force: z.boolean().optional() }).nullable(),
    output: listResultSchema.extend({ version: z.string() }),
  },
  chat_open: {
    input: chatRefSchema.extend({
      via: openViaSchema.optional(),
      /** The bb thread on screen; a `bb` terminal belongs to it so its page shows the terminal. */
      threadId: z.string().min(1).optional(),
    }).strict(),
    /** `terminalId` is set for the `bb` target; the app shows that terminal. */
    output: openResultSchema.extend({
      terminalId: z.string().nullable(),
      /** The terminal belongs to the thread on screen, so that thread's side panel lists it. */
      inThread: z.boolean(),
    }),
  },
  /** Open the client's desktop app on a new chat; the user sends the first message there. */
  chat_new_app: {
    input: newAppChatSchema.strict(),
    output: openResultSchema,
  },
  /** Start a new chat's CLI (`claude` or `codex`) in a bb terminal tab; see `new_chat_folder`. */
  chat_new_terminal: {
    input: newChatSchema.extend({ threadId: z.string().min(1).optional() }).strict(),
    output: openResultSchema.extend({ terminalId: z.string(), inThread: z.boolean() }),
  },
  ...chatViewMethods,
});
