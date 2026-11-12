import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { cliInFolderCommand } from "./server";

const chat = (id: string, title: string, updatedAt: number) => ({
  client: "claude" as const,
  id,
  title,
  updatedAt,
  parentId: null,
});
const listing = (...chats: ReturnType<typeof chat>[]) => ({
  projects: [{ key: "c:\\repo", path: "C:\\repo", name: "repo", updatedAt: 9, chats }],
  warnings: [],
  scannedAt: 1,
});

/** `scans` are returned by successive host scans; the last one repeats. */
function setup(scans: ReturnType<typeof listing>[] = [listing()], terminalHostId = "host_1", sdk: Record<string, unknown> = {}) {
  const calls: { method: string; input: unknown; hostId: string }[] = [];
  let scan = 0;
  const terminals: unknown[] = [];
  const closed: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-chats",
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_1", primaryHostPlatform: "win32" }) },
      terminals: {
        create: async (args: unknown) => {
          terminals.push(args);
          return { id: `term_${terminals.length}`, hostId: terminalHostId };
        },
        close: async (args: unknown) => {
          closed.push(args);
          return {};
        },
      },
      ...sdk,
    } as never,
    experimental_callHostRpc: ({ method, input, hostId }) => {
      calls.push({ method, input, hostId });
      if (method === "scan") return scans[Math.min(scan++, scans.length - 1)];
      if (method === "locate") return { cwd: "C:\\repo", title: "Fix the bug" };
      if (method === "new_chat_folder") return { cwd: (input as { cwd: string }).cwd };
      return { message: "opened" };
    },
  });
  return { bb, harness, calls, terminals, closed };
}

const id = "11111111-1111-4111-8111-111111111111";

describe("server", () => {
  it("forwards listing to the primary host", async () => {
    const { bb, harness, calls } = setup();
    await plugin(bb);
    const first = (await harness.callRpc("chats_list", null)) as { version: string };
    // A second viewer gets the same listing without another scan.
    const second = (await harness.callRpc("chats_list", null)) as { version: string };
    await harness.callRpc("chats_list", { force: true });
    expect(calls).toEqual([
      { method: "scan", input: { includeBbChats: false, force: false }, hostId: "host_1" },
      { method: "scan", input: { includeBbChats: false, force: true }, hostId: "host_1" },
    ]);
    expect(second.version).toBe(first.version);
  });

  it("opens with the configured default unless a target is given", async () => {
    const { bb, harness, calls } = setup();
    await plugin(bb);
    await harness.setSettings({ claudeOpener: "app" });
    await harness.callRpc("chat_open", { client: "claude", id });
    // The Codex default is the chat view, which opens in the app; on the server it maps to `bb`.
    await harness.callRpc("chat_open", { client: "codex", id });
    await harness.callRpc("chat_open", { client: "claude", id, via: "bb" });
    expect(calls.map((call) => [call.method, call.input])).toEqual([
      ["open", { client: "claude", id }],
      ["locate", { client: "codex", id }],
      ["locate", { client: "claude", id }],
    ]);
  });

  it("rejects unknown targets", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.callRpc("chat_open", { client: "codex", id, via: "vscode" })).rejects.toThrow();
    await expect(harness.callRpc("chat_open", { client: "claude", id, via: "terminal" })).rejects.toThrow();
  });

  it("resumes the chat in a bb terminal in its folder", async () => {
    const { bb, harness, calls, terminals } = setup();
    await plugin(bb);
    const result = await harness.callRpc("chat_open", { client: "codex", id, via: "bb" });
    expect(calls.map((call) => call.method)).toEqual(["locate"]);
    expect(terminals).toEqual([
      {
        cols: 120,
        rows: 32,
        scope: { kind: "host_path", hostId: "host_1", cwd: "C:\\repo" },
        start: { mode: "argv", argv: ["cmd.exe", "/c", "codex", "resume", id] },
        title: "Codex: Fix the bug",
      },
    ]);
    expect(result).toEqual({ message: "Opened in a bb terminal at C:\\repo", terminalId: "term_1", inThread: false });
  });

  it("asks the host to open a new chat in the client's desktop app", async () => {
    const { bb, harness, calls, terminals } = setup();
    await plugin(bb);
    await harness.callRpc("chat_new_app", { client: "claude", cwd: null });
    expect(calls.map((call) => [call.method, call.input, call.hostId])).toEqual([["new_in_app", { client: "claude", cwd: null }, "host_1"]]);
    expect(terminals).toEqual([]);
  });

  it("starts a new chat's CLI in a bb terminal in the project folder the host confirms", async () => {
    const { bb, harness, calls, terminals } = setup();
    await plugin(bb);
    const result = await harness.callRpc("chat_new_terminal", { client: "codex", cwd: "C:\\repo" });
    await harness.callRpc("chat_new_terminal", { client: "claude", cwd: "C:\\repo", threadId: "thr_1" });
    expect(calls.filter((call) => call.method === "new_chat_folder").map((call) => call.input)).toEqual([
      { client: "codex", cwd: "C:\\repo" },
      { client: "claude", cwd: "C:\\repo" },
    ]);
    expect(terminals).toEqual([
      {
        cols: 120,
        rows: 32,
        scope: { kind: "host_path", hostId: "host_1", cwd: "C:\\repo" },
        start: { mode: "argv", argv: ["cmd.exe", "/c", "codex"] },
        title: "Codex: new chat",
      },
      {
        cols: 120,
        rows: 32,
        scope: { kind: "thread", threadId: "thr_1" },
        start: { mode: "command", command: "Set-Location -LiteralPath 'C:\\repo'; claude" },
        title: "Claude Code: new chat",
      },
    ]);
    expect(result).toEqual({ message: "Started a new chat in a bb terminal at C:\\repo", terminalId: "term_1", inThread: false });
    // Without a project there is no folder to start in: the desktop app makes it.
    await expect(harness.callRpc("chat_new_terminal", { client: "codex", cwd: null })).rejects.toThrow();
  });

  it("opens a bb terminal that belongs to the thread on screen, in the chat's folder", async () => {
    const { bb, harness, terminals } = setup();
    await plugin(bb);
    const result = await harness.callRpc("chat_open", { client: "codex", id, via: "bb", threadId: "thr_1" });
    expect(terminals).toEqual([
      {
        cols: 120,
        rows: 32,
        scope: { kind: "thread", threadId: "thr_1" },
        start: { mode: "command", command: `Set-Location -LiteralPath 'C:\\repo'; codex.cmd resume ${id}` },
        title: "Codex: Fix the bug",
      },
    ]);
    expect(result).toEqual({ message: "Opened in a bb terminal at C:\\repo", terminalId: "term_1", inThread: true });
  });

  it("falls back to a folder terminal when the thread runs on another machine", async () => {
    const { bb, harness, terminals, closed } = setup(undefined, "host_2");
    await plugin(bb);
    const result = await harness.callRpc("chat_open", { client: "claude", id, via: "bb", threadId: "thr_1" });
    expect(closed).toEqual([{ terminalId: "term_1", mode: "force" }]);
    expect((terminals[1] as { scope: unknown }).scope).toEqual({ kind: "host_path", hostId: "host_1", cwd: "C:\\repo" });
    expect(result).toMatchObject({ terminalId: "term_2", inThread: false });
  });

  it("opens no thread terminal when the thread's host is known to be another machine", async () => {
    const { bb, harness, terminals, closed } = setup(undefined, "host_1", {
      threads: { get: async () => ({ environmentId: "env_1" }) },
      environments: { get: async () => ({ hostId: "host_2" }) },
    });
    await plugin(bb);
    const result = await harness.callRpc("chat_open", { client: "claude", id, via: "bb", threadId: "thr_1" });
    expect(closed).toEqual([]);
    expect(terminals.map((terminal) => (terminal as { scope: unknown }).scope)).toEqual([
      { kind: "host_path", hostId: "host_1", cwd: "C:\\repo" },
    ]);
    expect(result).toMatchObject({ terminalId: "term_1", inThread: false });
  });

  it("rejects unknown chat_open fields", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.callRpc("chat_open", { client: "claude", id, via: "app", extra: true })).rejects.toThrow();
  });

  it("quotes the chat folder for the shell", () => {
    expect(cliInFolderCommand(true, "C:\\it's here", ["claude", "--resume", id])).toBe(
      `Set-Location -LiteralPath 'C:\\it''s here'; claude --resume ${id}`,
    );
    // PowerShell treats the typographic single quotes as quotes too.
    expect(cliInFolderCommand(true, "C:\\Bob\u2019s \u2018x\u2019 \u201a\u201b", ["claude", "--resume", id])).toBe(
      `Set-Location -LiteralPath 'C:\\Bob\u2019\u2019s \u2018\u2018x\u2019\u2019 \u201a\u201a\u201b\u201b'; claude --resume ${id}`,
    );
    expect(cliInFolderCommand(false, "/home/it's", ["codex", "resume", id])).toBe(`cd '/home/it'\\''s' && codex resume ${id}`);
  });

  it("rejects ids that are not UUIDs", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.callRpc("chat_open", { client: "claude", id: "../x" })).rejects.toThrow();
  });

  it("publishes only the changed rows after a store change", async () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const { bb, harness, calls } = setup([
      listing(chat(a, "First", 1), chat(b, "Second", 2)),
      listing(chat(a, "First renamed", 3), chat(b, "Second", 2)),
      listing(chat(a, "First renamed", 3), chat(b, "Second", 2)),
    ]);
    await plugin(bb);
    const before = (await harness.callRpc("chats_list", null)) as { version: string };

    await harness.experimental_emitHostSignal("host_1", "changed", { client: "claude" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.at(-1)).toEqual({ method: "scan", input: { includeBbChats: false, force: false }, hostId: "host_1" });
    const published = harness.inspection.realtimeSignals.filter((signal) => signal.channel === "chats-changed");
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({
      from: before.version,
      reload: false,
      chats: { upsert: [{ id: a, title: "First renamed", projectKey: "c:\\repo" }], remove: [] },
    });

    // A change that leaves the listing as it was publishes nothing.
    await harness.experimental_emitHostSignal("host_1", "changed", { client: "claude" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "chats-changed")).toHaveLength(1);
  });

  it("asks the primary host to watch the chat stores", async () => {
    const { bb, harness, calls } = setup();
    await plugin(bb);
    const { controller, done } = harness.runService("watch-chat-stores");
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await done;
    expect(calls).toContainEqual({ method: "watch", input: {}, hostId: "host_1" });
  });

  it("forwards chat view calls to the host and its chat events to viewers", async () => {
    const { bb, harness, calls } = setup();
    await plugin(bb);
    await harness.callRpc("chat_send", { client: "codex", id, text: "Hello" });
    expect(calls.at(-1)).toEqual({ method: "chat_send", input: { client: "codex", id, text: "Hello" }, hostId: "host_1" });
    const event = { client: "codex", id, seq: 3, status: "running" };
    await harness.experimental_emitHostSignal("host_1", "chatEvent", event);
    expect(harness.inspection.realtimeSignals).toContainEqual(expect.objectContaining({ channel: "chat-events", payload: event }));
  });
});
