import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { claudeExecutable, drainQuery, editPlan, forkPoint, mapClaudeMessages } from "./claude";
import { AppServer, CodexChat, mapCodexTurns, startNewCodexChat } from "./codex";
import { isSystemReminder } from "../shared/text";
import { ChatSession, pendingUserItem, setChatEmitter } from "./hub";
import type { ChatEvent } from "../shared/contract";

const msg = (type: "user" | "assistant", uuid: string, content: unknown): SessionMessage => ({
  type,
  uuid,
  session_id: "s",
  message: { role: type, content },
  parent_tool_use_id: null,
  parent_agent_id: null,
});

// Two turns: a prompt, a Write with its result, a reply; then a second prompt and reply.
const session: SessionMessage[] = [
  msg("user", "u1", "Write ALPHA"),
  msg("assistant", "a1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.txt", content: "ALPHA" } }]),
  msg("user", "r1", [{ type: "tool_result", tool_use_id: "t1", content: "written" }]),
  msg("assistant", "a2", [{ type: "text", text: "DONE" }]),
  msg("user", "u2", [{ type: "text", text: "Write BETA" }]),
  msg("assistant", "a3", [{ type: "text", text: "DONE again" }]),
];

describe("Claude Code history", () => {
  it("maps prompts, tool calls with results and patches, and replies", () => {
    const items = mapClaudeMessages(session);
    expect(items.map((i) => [i.kind, i.id, i.editable])).toEqual([
      ["user", "u1", true],
      ["tool", "t1", false],
      ["assistant", "a2#0", false],
      ["user", "u2", true],
      ["assistant", "a3#0", false],
    ]);
    const tool = items[1]!;
    expect(tool.tool).toMatchObject({ name: "Write", output: "written", status: "completed" });
    expect(tool.patches?.[0]?.diff).toContain("+ALPHA");
  });

  it("plans in-place edits: resume point, drop guard only for the last prompt, first prompt flagged", () => {
    expect(editPlan(session, "u2")).toEqual({ kept: "a2", dropsTurn: "u2", first: false });
    expect(editPlan(session, "u1")).toEqual({ kept: null, dropsTurn: null, first: true });
    const three = [...session, msg("user", "u3", "Write DELTA"), msg("assistant", "a4", [{ type: "text", text: "ok" }])];
    expect(editPlan(three, "u2")).toEqual({ kept: "a2", dropsTurn: null, first: false });
    expect(() => editPlan(session, "r1")).toThrow(/no longer in this chat/);
  });

  it("shows a prompt without the system reminder sent before it", () => {
    // The Claude app sends one before the first message of a chat without a project.
    const reminder = "<system-reminder>\nThe working directory is a scratch folder.\n</system-reminder>";
    const items = mapClaudeMessages([msg("user", "u1", [{ type: "text", text: reminder }, { type: "text", text: "Draw a pelican" }])]);
    expect(items.map((item) => item.text)).toEqual(["Draw a pelican"]);
    // A message that is only a reminder still shows something.
    expect(mapClaudeMessages([msg("user", "u2", [{ type: "text", text: reminder }])])[0]?.text).toBe(reminder);
  });

  it("forks through the end of the pressed message's turn", () => {
    expect(forkPoint(session, "u1")).toBe("a2");
    expect(forkPoint(session, "a2#0")).toBe("a2");
    expect(forkPoint(session, "u2")).toBe("a3");
  });
});

describe("Codex history", () => {
  it("maps turns to items with their turn ids", () => {
    const items = mapCodexTurns([
      {
        id: "turn-1",
        items: [
          { type: "userMessage", id: "i1", content: [{ type: "text", text: "Fix it" }] },
          { type: "reasoning", id: "i2", summary: [], content: [] },
          { type: "commandExecution", id: "i3", command: "npm test", aggregatedOutput: "ok", status: "completed" },
          { type: "fileChange", id: "i4", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b" }], status: "completed" },
          { type: "agentMessage", id: "i5", text: "Fixed." },
        ],
      },
    ]);
    expect(items.map((i) => [i.kind, i.id, i.turnId, i.editable])).toEqual([
      ["user", "i1", "turn-1", true],
      ["tool", "i3", "turn-1", false],
      ["tool", "i4", "turn-1", false],
      ["assistant", "i5", "turn-1", false],
    ]);
    expect(items[1]!.tool).toMatchObject({ name: "command", input: "npm test", output: "ok" });
    expect(items[2]!.patches).toEqual([{ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }]);
  });
});

describe("chat session events", () => {
  afterEach(() => vi.useRealTimers());

  it("numbers events and resolves approvals by answer or by timeout fallback", async () => {
    vi.useFakeTimers();
    const events: ChatEvent[] = [];
    setChatEmitter(async (event) => {
      events.push(event);
    });
    const chat = new ChatSession("claude", "c1");
    chat.setStatus("running");
    const answered = chat.ask({ id: "q1", title: "Allow Write?", detail: "", options: [{ id: "allow", label: "Allow" }] }, "deny");
    expect(chat.requests().map((r) => r.id)).toEqual(["q1"]);
    chat.answer("q1", "allow");
    await expect(answered).resolves.toBe("allow");

    const timedOut = chat.ask({ id: "q2", title: "Allow Bash?", detail: "", options: [] }, "deny");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await expect(timedOut).resolves.toBe("deny");

    chat.reset();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.at(-1)).toMatchObject({ reset: true });
    expect(chat.requests()).toEqual([]);
  });
});

describe("chat session answers", () => {
  it("rejects an option the request does not offer and keeps the request pending", async () => {
    setChatEmitter(async () => undefined);
    const chat = new ChatSession("codex", "c2");
    const options = [
      { id: "accept", label: "Allow" },
      { id: "decline", label: "Deny" },
    ];
    const answered = chat.ask({ id: "q1", title: "Run?", detail: "", options }, "decline");
    expect(() => chat.answer("q1", "acceptForever")).toThrow(/not an answer/);
    expect(chat.requests().map((r) => r.id)).toEqual(["q1"]);
    expect(chat.answer("q1", "accept")).toBe(true);
    await expect(answered).resolves.toBe("accept");
    expect(chat.answer("q1", "accept")).toBe(false);
  });

  it("gives each provisional user message its own id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => pendingUserItem("x").id));
    expect(ids.size).toBe(50);
  });
});

describe("Claude Code executable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-chats-claude-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const touch = (...parts: string[]) => {
    mkdirSync(path.join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(path.join(dir, ...parts), "");
    return path.join(dir, ...parts);
  };

  it("never returns a Windows shim and falls back to the installer's folders", () => {
    const home = path.join(dir, "home");
    touch("shims", "claude.cmd");
    touch("shims", "claude.ps1");
    expect(claudeExecutable(path.join(dir, "shims"), home, true)).toBeUndefined();
    const installed = touch("home", ".local", "bin", "claude.exe");
    expect(claudeExecutable(path.join(dir, "shims"), home, true)).toBe(installed);
    const onPath = touch("bin", "claude.exe");
    expect(claudeExecutable([path.join(dir, "shims"), path.join(dir, "bin")].join(";"), home, true)).toBe(onPath);
    // POSIX: the native installer's wrapper when PATH lacks it (macOS GUI apps).
    const local = touch("home", ".claude", "local", "claude");
    expect(claudeExecutable("", home, false)).toBe(local);
  });

  it("closes a query that does not end within the drain timeout", async () => {
    const close = vi.fn();
    const endless = {
      close,
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
    };
    await drainQuery(endless, 20);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// A stand-in for `codex app-server`: answers every request; `turn/start` with
// "fail" errors, "crash" exits after answering, "slow" completes the turn later.
const FAKE_APP_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined || m.method === undefined) return;
  const text = m.params && m.params.input ? m.params.input[0].text : "";
  if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: "t-started" } } });
  if (m.method !== "turn/start") return send({ id: m.id, result: {} });
  if (text === "fail") return send({ id: m.id, error: { message: "turn refused" } });
  const turn = { id: "turn-" + m.id, status: "completed" };
  send({ id: m.id, result: { turn } });
  if (text === "crash") {
    process.stderr.write("boom\\n");
    setTimeout(() => process.exit(3), 20);
  }
  if (text === "slow") setTimeout(() => send({ method: "turn/completed", params: { threadId: m.params.threadId, turn } }), 100);
});
`;

describe("Codex app-server", () => {
  const servers: AppServer[] = [];
  const chats: CodexChat[] = [];
  afterEach(() => {
    for (const chat of chats.splice(0)) chat.dispose();
    for (const server of servers.splice(0)) server.stop();
  });
  function codexChat(threadId: string) {
    setChatEmitter(async () => undefined);
    const server = new AppServer(process.execPath, ["-e", FAKE_APP_SERVER]);
    servers.push(server);
    const session = new ChatSession("codex", threadId);
    const chat = new CodexChat(session, threadId, server);
    chats.push(chat);
    const methods = vi.spyOn(server, "request");
    return { server, session, chat, methods: () => methods.mock.calls.map((call) => call[0]) };
  }

  it("reports a missing Codex CLI instead of crashing", async () => {
    const server = new AppServer("bb-agent-chats-no-such-cli");
    servers.push(server);
    const exits: string[] = [];
    server.onExit((message) => exits.push(message));
    await expect(server.request("thread/read", {})).rejects.toThrow("Codex CLI not found on PATH");
    expect(exits).toEqual(["Codex CLI not found on PATH"]);
  });

  it("resets its chats when the app-server exits, so the next send resumes on a new one", async () => {
    const { session, chat, methods } = codexChat("t-exit");
    await chat.send("crash");
    expect(session.status).toBe("running");
    await vi.waitFor(() => expect(session.status).toBe("error"));
    expect(session.error).toMatch(/exited \(code 3\): boom/);

    await expect(chat.send("fail")).rejects.toThrow("turn refused");
    expect(methods()).toEqual(["thread/resume", "turn/start", "thread/resume", "turn/start"]);
    expect(session).toMatchObject({ status: "error", error: "turn refused" });
    // The failed start left no turn to steer: the next send starts one.
    await chat.send("again");
    expect(methods().at(-1)).toBe("turn/start");
  });

  it("starts one turn for concurrent sends and steers it with the second", async () => {
    const { chat, methods } = codexChat("t-concurrent");
    await Promise.all([chat.send("one"), chat.send("two")]);
    expect(methods()).toEqual(["thread/resume", "turn/start", "turn/steer"]);
  });

  it("releases the thread after the running turn when the view closes during it", async () => {
    const { chat, methods } = codexChat("t-close");
    const released = vi.fn();
    chat.onReleased = released;
    await chat.send("slow");
    chat.close();
    expect(methods()).not.toContain("thread/unsubscribe");
    await vi.waitFor(() => expect(methods()).toContain("thread/unsubscribe"));
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("starts a new thread in its folder and runs the first turn without a resume", async () => {
    setChatEmitter(async () => undefined);
    const server = new AppServer(process.execPath, ["-e", FAKE_APP_SERVER]);
    servers.push(server);
    const requests = vi.spyOn(server, "request");
    const { id, chat } = await startNewCodexChat("C:\\work", "Fix it", { server });
    chats.push(chat);
    expect(id).toBe("t-started");
    expect(requests.mock.calls.map((call) => call[0])).toEqual(["thread/start", "turn/start"]);
    expect(requests.mock.calls[0]![1]).toEqual({ cwd: "C:\\work", threadSource: "user" });
  });

  it("refuses a second driver for the same thread", () => {
    const { server } = codexChat("t-twice");
    expect(() => new CodexChat(new ChatSession("codex", "t-twice"), "t-twice", server)).toThrow(/already has a driver/);
  });
});

describe("system reminders", () => {
  it("are recognized as whole text blocks only", () => {
    expect(isSystemReminder("<system-reminder>\nx\n</system-reminder>")).toBe(true);
    expect(isSystemReminder("Draw a pelican")).toBe(false);
    expect(isSystemReminder("<system-reminder>x</system-reminder> and more")).toBe(false);
  });
});
