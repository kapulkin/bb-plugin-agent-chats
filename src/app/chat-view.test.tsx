// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ChatItem, ChatState } from "../shared/contract";

const app = await loadPluginApp(() => import("../app"));
const id = "11111111-1111-4111-8111-111111111111";
const item = (kind: ChatItem["kind"], itemId: string, text: string): ChatItem => ({
  id: itemId,
  kind,
  turnId: null,
  text,
  tool: null,
  patches: null,
  editable: kind === "user",
});
const state = (seq: number, items: ChatItem[]): ChatState => ({
  items,
  status: "idle",
  error: null,
  requests: [],
  seq,
  cwd: String.raw`C:\work\repo`,
  hostId: "host_1",
});

afterEach(cleanup);

function render(loads: (ChatState | Promise<ChatState>)[], extra: Record<string, (input: unknown) => unknown> = {}) {
  let load = 0;
  return renderSlot(app.navPanels[0]!, { subPath: `chat/claude/${id}` }, {
    rpc: {
      chats_list: () => ({ projects: [], warnings: [], scannedAt: 1, version: "v1" }),
      chat_load: () => loads[Math.min(load++, loads.length - 1)],
      chat_close: () => ({}),
      chat_send: () => ({}),
      chat_edit_preview: () => ({ files: ["a.txt"], note: null, startsNewChat: false }),
      chat_edit: () => ({ client: "claude", id }),
      chat_fork: () => ({ client: "claude", id: "22222222-2222-4222-8222-222222222222" }),
      ...extra,
    },
  });
}

const calls = (slot: ReturnType<typeof render>, method: string) => slot.inspection.rpcCalls.filter((c) => c.method === method);

describe("chat view", () => {
  it("shows the conversation and sends a message", async () => {
    const slot = render([state(0, [item("user", "u1", "Hello"), item("assistant", "a1", "Hi there")])]);
    expect(await slot.findByText("Hi there")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Message"), { target: { value: "Next question" } });
    fireEvent.click(slot.getByLabelText("Send"));
    await slot.findByText("Hi there");
    expect(calls(slot, "chat_send").at(-1)?.input).toEqual({ client: "claude", id, text: "Next question" });
  });

  it("applies numbered events and reloads after a gap", async () => {
    const slot = render([state(0, [item("assistant", "a1", "First")]), state(5, [item("assistant", "a1", "Reloaded")])]);
    await slot.findByText("First");
    await slot.behavior.emitRealtime("chat-events", { client: "claude", id, seq: 1, upsert: [item("assistant", "a2", "Streamed")] });
    expect(await slot.findByText("Streamed")).toBeTruthy();
    expect(calls(slot, "chat_load")).toHaveLength(1);
    await slot.behavior.emitRealtime("chat-events", { client: "claude", id, seq: 4, status: "running" });
    expect(await slot.findByText("Reloaded")).toBeTruthy();
    expect(calls(slot, "chat_load")).toHaveLength(2);
    // The view's first load attaches it; reloads do not.
    expect(calls(slot, "chat_load").map((call) => call.input)).toEqual([{ client: "claude", id, attach: true }, { client: "claude", id }]);
  });

  it("ignores stale and duplicate events without reloading", async () => {
    const slot = render([state(3, [item("assistant", "a1", "Current")])]);
    await slot.findByText("Current");
    await slot.behavior.emitRealtime("chat-events", { client: "claude", id, seq: 2, upsert: [item("assistant", "a1", "Stale")] });
    await slot.behavior.emitRealtime("chat-events", { client: "claude", id, seq: 3, upsert: [item("assistant", "a1", "Duplicate")] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.queryByText("Stale")).toBeNull();
    expect(slot.queryByText("Duplicate")).toBeNull();
    expect(calls(slot, "chat_load")).toHaveLength(1);
  });

  it("applies events that arrive while the conversation loads", async () => {
    let finish: (value: ChatState) => void = () => undefined;
    const pending = new Promise<ChatState>((resolve) => (finish = resolve));
    const slot = render([pending]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // One event the load already includes, one after it.
    await slot.behavior.emitRealtime("chat-events", { client: "claude", id, seq: 2, upsert: [item("assistant", "a1", "Old")] });
    await slot.behavior.emitRealtime("chat-events", { client: "claude", id, seq: 3, upsert: [item("assistant", "a2", "Buffered")] });
    finish(state(2, [item("assistant", "a1", "Loaded")]));
    expect(await slot.findByText("Buffered")).toBeTruthy();
    expect(slot.getByText("Loaded")).toBeTruthy();
    expect(calls(slot, "chat_load")).toHaveLength(1);
  });

  it("sends once while a send is still in flight", async () => {
    let finish: () => void = () => undefined;
    const slot = render([state(0, [item("assistant", "a1", "Hi")])], {
      chat_send: () => new Promise((resolve) => (finish = () => resolve({}))),
    });
    await slot.findByText("Hi");
    const box = slot.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "First" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(box, { target: { value: "Second" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls(slot, "chat_send").map((call) => (call.input as { text: string }).text)).toEqual(["First"]);
    finish();
  });

  it("edits a message after confirming which files are restored", async () => {
    const slot = render([state(0, [item("user", "u1", "Old text")])]);
    await slot.findByText("Old text");
    fireEvent.click(slot.getByLabelText("Edit message"));
    fireEvent.change(slot.getByLabelText("Edited message"), { target: { value: "New text" } });
    fireEvent.click(slot.getByText("Save and resend"));
    expect(await slot.findByText("a.txt")).toBeTruthy();
    fireEvent.click(slot.getByText("Rewrite"));
    await slot.findByText("Old text");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls(slot, "chat_edit").at(-1)?.input).toEqual({ client: "claude", id, messageId: "u1", text: "New text" });
  });

  it("forks from a message and opens the new chat", async () => {
    const slot = render([state(0, [item("user", "u1", "Fork me")])]);
    await slot.findByText("Fork me");
    fireEvent.click(slot.getByLabelText("Fork from here"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls(slot, "chat_fork").at(-1)?.input).toEqual({ client: "claude", id, messageId: "u1" });
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "chats", options: { subPath: "chat/claude/22222222-2222-4222-8222-222222222222" } }),
    );
  });
});

describe("chat events", () => {
  it("skips events the state holds and asks for a reload on a gap or a reset", async () => {
    const { applyChatEvent } = await import("./chat-view");
    const base = state(4, [item("assistant", "a1", "x")]);
    expect(applyChatEvent(base, { client: "claude", id, seq: 4, status: "running" })).toBe(base);
    expect(applyChatEvent(base, { client: "claude", id, seq: 6, status: "running" })).toBeNull();
    expect(applyChatEvent(base, { client: "claude", id, seq: 5, reset: true })).toBeNull();
    expect(applyChatEvent(base, { client: "claude", id, seq: 5, status: "running" })).toMatchObject({ seq: 5, status: "running" });
  });
});

describe("code blocks", () => {
  it("normalizes line breaks and names each block distinctly", async () => {
    const { codeText, codePath } = await import("./chat-view");
    expect(codeText("a\r\nb\rc\u2028d")).toBe("a\nb\nc\nd");
    expect(codePath("toolu_01:x#1", "input.json")).toBe("toolu_01_x_1/input.json");
    expect(codePath("a", "input.json")).not.toBe(codePath("b", "input.json"));
  });

  it("explains Edit and Fork in their tooltips", async () => {
    const slot = render([state(0, [item("user", "u1", "Explain me")])]);
    await slot.findByText("Explain me");
    const edit = slot.getByLabelText("Edit message");
    fireEvent.focus(edit);
    fireEvent.pointerMove(edit);
    expect((await slot.findAllByText(/later messages are replaced, and file changes made after it are undone/)).length).toBeGreaterThan(0);
    const fork = slot.getByLabelText("Fork from here");
    fireEvent.focus(fork);
    fireEvent.pointerMove(fork);
    expect((await slot.findAllByText(/This chat stays unchanged/)).length).toBeGreaterThan(0);
  });

  it("copies the chat name from the header's context menu", async () => {
    const slot = render([state(0, [item("user", "u1", "Hello")])]);
    await slot.findByText("Hello");
    fireEvent.contextMenu(slot.getByLabelText("Chat header"));
    fireEvent.click(await slot.findByText("Copy chat name"));
    expect(await slot.findByText("Copied")).toBeTruthy();
    expect(slot.inspection.experimental_clipboardWrites.at(-1)).toEqual({ text: id });
  });

  it("opens a local file link from a message in bb's file preview", async () => {
    const slot = render([state(0, [item("assistant", "a1", "See [the proposal](bundled/tool/proposal.md#L12) and [docs](https://example.com).")])], {});
    // The test harness renders Markdown as plain text, so add the link bb's Markdown would render.
    const message = await slot.findByText(/See \[the proposal\]/);
    const link = document.createElement("a");
    link.setAttribute("href", "bundled/tool/proposal.md#L12");
    link.textContent = "the proposal";
    message.appendChild(link);
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({
        method: "experimental_openFilePreview",
        options: {
          target: { kind: "host", hostId: "host_1", path: String.raw`C:\work\repo\bundled\tool\proposal.md` },
          location: { kind: "line", line: 12, column: null },
        },
      }),
    );
    expect(slot.inspection.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
  });

  it("opens scrolled to the end of the conversation", async () => {
    const heights = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 5000 });
    try {
      const slot = render([state(0, [item("user", "u1", "First"), item("assistant", "a1", "Last reply")])]);
      const last = await slot.findByText("Last reply");
      const scroller = last.closest(".overflow-y-auto") as HTMLElement;
      expect(scroller.scrollTop).toBe(5000);
    } finally {
      if (heights) Object.defineProperty(HTMLElement.prototype, "scrollHeight", heights);
    }
  });
});
