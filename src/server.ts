// Server entry: the plugin's settings, the chat listing (kept current from the
// host's store watch and sent to viewers as deltas), and bb terminals that
// resume a chat. Everything that touches the chat stores runs in the host
// entry (host.ts) on bb's primary host; the server forwards those calls to it
// and relays its chat events to open chat views.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CHAT_EVENTS,
  CHATS_CHANGED,
  hostContract,
  hostSignals,
  openViaSchema,
  rpcContract,
  type ChatClient,
  type OpenVia,
} from "./shared/contract";
import { diffListings, toListing, toListResult, type Listing } from "./shared/listing";

export type { rpcContract } from "./shared/contract";

type ChatViewMethod =
  | "chat_load"
  | "chat_send"
  | "chat_stop"
  | "chat_close"
  | "chat_edit_preview"
  | "chat_edit"
  | "chat_fork"
  | "chat_answer";

/**
 * Shell command for a bb terminal command start: change to the chat's folder,
 * then run the CLI. bb runs it in Windows PowerShell on Windows hosts, where
 * `codex.cmd` avoids the execution policy that can block npm's `codex.ps1`.
 */
export function resumeInFolderCommand(windows: boolean, cwd: string, command: string[]): string {
  if (windows) {
    const [cli, ...args] = command;
    const exe = cli === "codex" ? "codex.cmd" : cli;
    // PowerShell also ends a single-quoted string at the typographic quotes U+2018..U+201B.
    return `Set-Location -LiteralPath '${cwd.replace(/['‘-‛]/g, "$&$&")}'; ${[exe, ...args].join(" ")}`;
  }
  return `cd '${cwd.replaceAll("'", "'\\''")}' && ${command.join(" ")}`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    claudeOpener: {
      type: "select",
      label: "Open Claude Code chats in",
      options: ["view", "bb", "app"],
      experimental_optionLabels: {
        view: "Chat view in bb",
        bb: "bb terminal (claude --resume)",
        app: "Claude desktop app",
      },
      default: "view",
    },
    codexOpener: {
      type: "select",
      label: "Open Codex chats in",
      options: ["view", "bb", "app"],
      experimental_optionLabels: {
        view: "Chat view in bb",
        bb: "bb terminal (codex resume)",
        app: "Codex desktop app",
      },
      default: "view",
    },
    includeBbChats: {
      type: "boolean",
      label: "Include chats started by bb",
      default: false,
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });

  // The last listing sent to viewers. Each refresh diffs the new scan against
  // it and publishes only the changed rows as a delta from version to version;
  // versions carry this server generation, so a viewer from before a reload
  // never applies a delta to the wrong base.
  const generation = randomUUID().slice(0, 8);
  let counter = 0;
  let current: { listing: Listing; includeBbChats: boolean } | null = null;
  let refreshQueue: Promise<unknown> = Promise.resolve();

  function refreshListing(force: boolean): Promise<Listing> {
    const run = refreshQueue.then(async () => {
      const { includeBbChats } = await settings.get();
      const result = await host.call(
        "scan",
        { includeBbChats, force },
        { hostId: (await primaryHost()).hostId },
      );
      // The version advances only when viewers receive a change.
      const next = toListing(result, `${generation}.${counter + 1}`);
      const previous = current;
      if (previous !== null) {
        const delta = diffListings(previous.listing, next);
        // Unchanged: keep the version viewers already hold.
        if (delta === null) {
          previous.includeBbChats = includeBbChats;
          return previous.listing;
        }
        bb.realtime.publish(CHATS_CHANGED, delta);
        bb.log.debug(
          delta.reload
            ? `listing ${delta.to}: reload`
            : `listing ${delta.to}: ${delta.chats.upsert.length} chats changed, ${delta.chats.remove.length} removed`,
        );
      }
      counter += 1;
      current = { listing: next, includeBbChats };
      return next;
    });
    refreshQueue = run.catch(() => undefined);
    return run;
  }

  // Live updates: the host watches both chat stores and signals changes; the
  // resulting delta is published to every open viewer.
  host.experimental_onSignal("changed", ({ payload }) => {
    bb.log.debug(`${payload.client} chat store changed`);
    refreshListing(false).catch((error) => bb.log.warn(`could not refresh chats: ${String(error)}`));
  });
  // Chat view: the host drives open chats and numbers their events; views
  // filter by chat and reload on a gap.
  host.experimental_onSignal("chatEvent", ({ payload }) => {
    bb.realtime.publish(CHAT_EVENTS, payload);
  });
  const onHost = async <M extends ChatViewMethod>(method: M, input: Parameters<typeof host.call<M>>[1]) =>
    host.call(method, input, { hostId: (await primaryHost()).hostId });
  settings.onChange((next, previous) => {
    if (next.includeBbChats === previous.includeBbChats || current === null) return;
    refreshListing(false).catch((error) => bb.log.warn(`could not refresh chats: ${String(error)}`));
  });
  // Starting the watch is idempotent, so it is re-requested every minute: a
  // restarted host worker or daemon starts watching again within that time.
  bb.background.service("watch-chat-stores", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await host.call("watch", {}, { hostId: (await primaryHost()).hostId, signal });
        } catch (error) {
          if (!signal.aborted) bb.log.warn(`could not watch chat stores: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  async function primaryHost(): Promise<{ hostId: string; windows: boolean }> {
    const { primaryHostId, primaryHostPlatform } = await bb.sdk.system.config();
    if (primaryHostId === null) throw new Error("bb has no primary host to read chats from");
    return { hostId: primaryHostId, windows: primaryHostPlatform === "win32" };
  }

  /** Whether a thread runs on `hostId`, read from its environment; "unknown" when that fails. */
  async function threadOnHost(threadId: string, hostId: string): Promise<"same" | "other" | "unknown"> {
    try {
      const { environmentId } = await bb.sdk.threads.get({ threadId });
      if (environmentId === null) return "unknown";
      const environment = await bb.sdk.environments.get({ environmentId });
      return environment.hostId === hostId ? "same" : "other";
    } catch {
      return "unknown";
    }
  }

  /** Resume the chat's CLI in a bb terminal tab in the chat's folder. */
  async function openInBbTerminal(client: ChatClient, id: string, threadId: string | undefined) {
    const { hostId, windows } = await primaryHost();
    const { cwd, title } = await host.call("locate", { client, id }, { hostId });
    const command = client === "claude" ? ["claude", "--resume", id] : ["codex", "resume", id];
    const size = { cols: 120, rows: 32 };
    const terminalTitle = `${client === "claude" ? "Claude Code" : "Codex"}: ${title}`.slice(0, 80);
    const message = `Opened in a bb terminal at ${cwd}`;

    // A thread page shows only its own terminals, so a terminal opened there
    // belongs to that thread. It starts in the thread's folder, so its command
    // changes to the chat's folder first. A thread on another machine, where the
    // chat's folder does not exist, gets none. The chat's host is the primary
    // host, so `windows` is that machine's platform either way.
    if (threadId !== undefined && (await threadOnHost(threadId, hostId)) !== "other") {
      const terminal = await bb.sdk.terminals.create({
        ...size,
        scope: { kind: "thread", threadId },
        start: { mode: "command", command: resumeInFolderCommand(windows, cwd, command) },
        title: terminalTitle,
      });
      if (terminal.hostId === hostId) return { message, terminalId: terminal.id, inThread: true };
      // The thread's host could not be read beforehand and is another machine:
      // the command may have started there, so the terminal is closed at once.
      await bb.sdk.terminals.close({ terminalId: terminal.id, mode: "force" });
    }
    const terminal = await bb.sdk.terminals.create({
      ...size,
      scope: { kind: "host_path", hostId, cwd },
      // cmd.exe resolves npm's `.cmd` shims (codex) that a bare argv cannot.
      start: { mode: "argv", argv: windows ? ["cmd.exe", "/c", ...command] : command },
      title: terminalTitle,
    });
    return { message, terminalId: terminal.id, inThread: false };
  }

  /** The server-side target when a caller names none; the chat view opens in the app, so it maps to `bb`. */
  async function defaultOpener(client: ChatClient): Promise<OpenVia> {
    const values = await settings.get();
    const parsed = openViaSchema.safeParse(client === "claude" ? values.claudeOpener : values.codexOpener);
    return parsed.success ? parsed.data : "bb";
  }

  bb.rpc.register(rpcContract, {
    chats_list: async (input) => {
      const { includeBbChats } = await settings.get();
      const force = input?.force ?? false;
      const listing =
        force || current === null || current.includeBbChats !== includeBbChats
          ? await refreshListing(force)
          : current.listing;
      return { ...toListResult(listing), version: listing.version };
    },
    chat_load: async (input) => ({ ...(await onHost("chat_load", input)), hostId: (await primaryHost()).hostId }),
    chat_send: (input) => onHost("chat_send", input),
    chat_stop: (input) => onHost("chat_stop", input),
    chat_close: (input) => onHost("chat_close", input),
    chat_edit_preview: (input) => onHost("chat_edit_preview", input),
    chat_edit: (input) => onHost("chat_edit", input),
    chat_fork: (input) => onHost("chat_fork", input),
    chat_answer: (input) => onHost("chat_answer", input),
    chat_open: async ({ client, id, via, threadId }) => {
      const target = via ?? (await defaultOpener(client));
      const result =
        target === "bb"
          ? await openInBbTerminal(client, id, threadId)
          : {
              ...(await host.call("open", { client, id }, { hostId: (await primaryHost()).hostId })),
              terminalId: null,
              inThread: false,
            };
      bb.log.info(`opened ${client} chat ${id}: ${result.message}`);
      return result;
    },
  });
}
