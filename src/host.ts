// Host entry: runs on bb's primary host, which holds the Claude Code and Codex
// stores. It lists chats from the store metadata (host/chat-index.ts), drives the
// chats open in chat views, whose full conversations it reads and writes
// through the Claude Agent SDK and `codex app-server` (chat/claude.ts,
// chat/codex.ts), and opens a chat in its desktop app (host/launch.ts).
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { ClaudeChat } from "./chat/claude";
import { CodexChat, stopCodexAppServer } from "./chat/codex";
import { ChatSession, setChatEmitter } from "./chat/hub";
import { hostContract, hostSignals, type ChatClient } from "./shared/contract";
import { chatKey, type HostContext } from "./host/scanned-chat";
import { displayTitle, findChat, scan, watchStores } from "./host/chat-index";
import { openInApp, requireFolder } from "./host/launch";

type ChatDriver = ClaudeChat | CodexChat;

/**
 * Chat drivers by `client:id`, with the number of views attached to each. The
 * entry holds the driver's creation, so concurrent calls share one driver. A
 * driver is closed when its last view detaches and dropped once it is idle.
 */
const chats = new Map<string, { chat: Promise<ChatDriver>; views: number }>();

/** Track `chat` under `key`; the entry is dropped when the driver releases with no view attached. */
function register(key: string, chat: Promise<ChatDriver>): { chat: Promise<ChatDriver>; views: number } {
  const entry = { chat, views: 0 };
  chats.set(key, entry);
  chat.then(
    (driver) => {
      driver.onReleased = () => {
        if (chats.get(key) !== entry || entry.views > 0) return;
        chats.delete(key);
        if (driver instanceof CodexChat) driver.dispose();
      };
    },
    () => {
      if (chats.get(key) === entry) chats.delete(key);
    },
  );
  return entry;
}

function chatFor(client: ChatClient, id: string, context: HostContext): Promise<ChatDriver> {
  setChatEmitter((event) => context.experimental_emitSignal("chatEvent", event));
  const key = chatKey(client, id);
  const existing = chats.get(key);
  if (existing !== undefined) return existing.chat;
  const create = async (): Promise<ChatDriver> => {
    const session = new ChatSession(client, id);
    return client === "claude"
      ? new ClaudeChat(session, id, (await findChat(client, id, context.experimental_paths.dataDir)).cwd)
      : new CodexChat(session, id);
  };
  // Registered before any await, so a concurrent call finds this entry.
  return register(key, create()).chat;
}

/** Views attached to a chat's driver; null when the host holds no driver for it. */
export function attachedViews(client: ChatClient, id: string): number | null {
  return chats.get(chatKey(client, id))?.views ?? null;
}

/** The Codex turn of a chat item, which Codex edits and forks address. */
async function codexTurnOf(chat: CodexChat, itemId: string): Promise<string> {
  const item = (await chat.history()).find((candidate) => candidate.id === itemId);
  if (item?.turnId == null) throw new Error("The message is no longer in this chat");
  return item.turnId;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    watch: async (_input, context) => ({ watching: await watchStores(context) }),
    scan: ({ includeBbChats, force }, context) => scan(includeBbChats, force, context.experimental_paths.dataDir),
    open: async ({ client, id }, context) => {
      const chat = await findChat(client, id, context.experimental_paths.dataDir);
      return { message: await openInApp(chat) };
    },
    locate: async ({ client, id }, context) => {
      const chat = await findChat(client, id, context.experimental_paths.dataDir);
      await requireFolder(chat.cwd);
      return { cwd: chat.cwd, title: displayTitle(chat) };
    },
    chat_load: async ({ client, id, attach }, context) => {
      const pending = chatFor(client, id, context);
      // Counted before any await, so a close that follows always finds it.
      if (attach === true) chats.get(chatKey(client, id))!.views += 1;
      const chat = await pending;
      const { session } = chat;
      // Read the sequence number first: events after it apply on top of this history.
      const seq = session.seq;
      const cwd = await findChat(client, id, context.experimental_paths.dataDir).then(
        (found) => found.cwd,
        () => null,
      );
      return { items: await chat.history(), status: session.status, error: session.error, requests: session.requests(), seq, cwd };
    },
    chat_send: async ({ client, id, text }, context) => {
      await (await chatFor(client, id, context)).send(text);
      return {};
    },
    chat_stop: async ({ client, id }, context) => {
      await (await chatFor(client, id, context)).stop();
      return {};
    },
    chat_close: async ({ client, id }) => {
      const entry = chats.get(chatKey(client, id));
      if (entry === undefined || entry.views === 0) return {};
      entry.views -= 1;
      if (entry.views > 0) return {};
      const chat = await entry.chat.catch(() => null);
      // A view may have attached again meanwhile.
      if (entry.views === 0) chat?.close();
      return {};
    },
    chat_edit_preview: async ({ client, id, messageId }, context) => {
      const chat = await chatFor(client, id, context);
      return chat instanceof ClaudeChat ? chat.previewEdit(messageId) : chat.previewEdit();
    },
    chat_edit: async ({ client, id, messageId, text }, context) => {
      const chat = await chatFor(client, id, context);
      if (chat instanceof CodexChat) {
        await chat.edit(await codexTurnOf(chat, messageId), text);
        return { client, id };
      }
      const result = await chat.edit(messageId, text);
      // The new chat's view attaches to the driver that already runs its first turn.
      if (result.newChat !== null) register(chatKey("claude", result.id), Promise.resolve(result.newChat));
      return { client, id: result.id };
    },
    chat_fork: async ({ client, id, messageId }, context) => {
      const chat = await chatFor(client, id, context);
      const forked = chat instanceof ClaudeChat ? await chat.fork(messageId) : await chat.fork(await codexTurnOf(chat, messageId));
      return { client, id: forked };
    },
    chat_answer: async ({ client, id, requestId, optionId }, context) => {
      // Throws for an option the request does not offer.
      (await chatFor(client, id, context)).session.answer(requestId, optionId);
      return {};
    },
  },
  dispose: async () => {
    // Running turns end with the worker: interrupt Claude queries and Codex turns first.
    await Promise.allSettled([...chats.values()].map(async (entry) => (await entry.chat).shutdown()));
    chats.clear();
    stopCodexAppServer();
  },
});
