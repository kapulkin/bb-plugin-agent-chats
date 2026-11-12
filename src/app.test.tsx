// @vitest-environment jsdom
import { cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ListResult } from "./shared/contract";

const app = await loadPluginApp(() => import("./app"));

const listing: ListResult = {
  scannedAt: 1,
  warnings: [],
  projects: [
    {
      key: "c:\\repo",
      path: "C:\\repo",
      name: "repo",
      updatedAt: 2,
      chats: [
        { client: "claude", id: "11111111-1111-4111-8111-111111111111", title: "Claude chat", updatedAt: 2, parentId: null },
        { client: "claude", id: "44444444-4444-4444-8444-444444444444", title: "Claude fork", updatedAt: 3, parentId: "11111111-1111-4111-8111-111111111111" },
        {
          client: "claude",
          id: "55555555-5555-4555-8555-555555555555",
          title: "btw: Side question",
          updatedAt: 4,
          parentId: "11111111-1111-4111-8111-111111111111",
          sideChat: true,
        },
        { client: "codex", id: "22222222-2222-4222-8222-222222222222", title: "Codex chat", updatedAt: 1, parentId: null },
      ],
    },
    { key: "c:\\other", path: "C:\\other", name: "other", updatedAt: 1, chats: [
      { client: "codex", id: "33333333-3333-4333-8333-333333333333", title: "Other chat", updatedAt: 1, parentId: null },
    ] },
    { key: "scratch:", path: "C:\\Users\\me\\Documents\\Codex", name: "Chats without a project", updatedAt: 0, chats: [
      { client: "codex", id: "66666666-6666-4666-8666-666666666666", title: "Scratch chat", updatedAt: 0, parentId: null },
      { client: "claude", id: "88888888-8888-4888-8888-888888888888", title: "Claude scratch chat", updatedAt: 0, parentId: null },
    ] },
  ],
};

afterEach(cleanup);

function render(options: { subPath?: string; openTerminal?: boolean; threadId?: string } = {}) {
  localStorage.clear();
  return renderSlot(app.navPanels[0]!, { subPath: options.subPath ?? "" }, {
    context: { projectId: null, threadId: options.threadId ?? null },
    openTerminal: () => options.openTerminal ?? true,
    rpc: {
      chats_list: () => ({ ...listing, version: "v1" }),
      chat_open: (input: unknown) =>
        (input as { via?: string }).via === "bb"
          ? { message: "Opened in a bb terminal", terminalId: "term_1", inThread: false }
          : { message: "Opened in the Codex app", terminalId: null, inThread: false },
      chat_new_terminal: () => ({ message: "Started a new chat in a bb terminal", terminalId: "term_2", inThread: false }),
      chat_new_app: () => ({ message: "Opened a new chat in the Claude app; send your first message there" }),
      chat_new: (input: unknown) => ({ client: (input as { client: string }).client, id: "77777777-7777-4777-8777-777777777777" }),
    },
  });
}

describe("agent chats page", () => {
  it("folds projects and opens a chat in its client", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    expect(await slot.findByText("Claude Code")).toBeTruthy();
    expect(slot.queryByText("Other chat")).toBeNull();

    // By default a click opens the chat view (here no side panel accepts it, so the page shows it).
    fireEvent.click(slot.getByText("Codex chat"));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "chats", options: { subPath: "chat/codex/22222222-2222-4222-8222-222222222222" } }),
    );
    expect(slot.inspection.rpcCalls.some((call) => call.method === "chat_open")).toBe(false);

    fireEvent.click(slot.getByText("Codex"));
    expect(slot.queryByText("Codex chat")).toBeNull();
  });

  it("filters across projects", async () => {
    const slot = render();
    await slot.findByText("repo");
    fireEvent.change(slot.getByLabelText("Filter projects and chats"), { target: { value: "other chat" } });
    expect(await slot.findByText("Other chat")).toBeTruthy();
    expect(slot.queryByText("repo")).toBeNull();
  });

  it("opens a chat with an explicit target from the row actions", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getAllByLabelText("Open in Claude app")[0]!);
    await slot.findByText("Opened in the Codex app");
    expect(slot.inspection.rpcCalls.at(-1)?.input).toEqual({
      client: "claude",
      id: "11111111-1111-4111-8111-111111111111",
      via: "app",
    });
  });

  it("shows a tooltip naming each hover action", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    const button = slot.getAllByLabelText("Open in bb terminal")[0]!;
    fireEvent.focus(button);
    fireEvent.pointerMove(button);
    expect((await slot.findAllByText("claude --resume in a bb terminal tab")).length).toBeGreaterThan(0);
    expect(slot.queryAllByLabelText("Open in terminal")).toHaveLength(0);
  });

  it("shows the bb terminal that resumes the chat", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getAllByLabelText("Open in bb terminal")[0]!);
    await slot.findByText(/Opened in a bb terminal|could not be shown/);
    expect(slot.inspection.rpcCalls.at(-1)?.input).toEqual({
      client: "claude",
      id: "11111111-1111-4111-8111-111111111111",
      via: "bb",
    });
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("term_1");
  });

  it("never switches the main area when the page refuses a terminal, and offers the Agent chats page", async () => {
    const slot = render({ openTerminal: false });
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getAllByLabelText("Open in bb terminal")[0]!);
    const offer = await slot.findByText("Show on Agent chats page");
    expect(slot.inspection.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
    fireEvent.click(offer);
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "chats", options: { subPath: "terminal/term_1" } }),
    );
  });

  it("finds the thread on screen from the page address when bb's context has none", async () => {
    window.history.pushState({}, "", "/projects/proj_personal/threads/thr_personal1");
    try {
      const slot = render();
      fireEvent.click(await slot.findByText("repo"));
      fireEvent.click(slot.getAllByLabelText("Open in bb terminal")[0]!);
      await slot.findByText(/Opened in a bb terminal/);
      expect(slot.inspection.rpcCalls.at(-1)?.input).toMatchObject({ via: "bb", threadId: "thr_personal1" });
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("shows the terminal named by its sub-path and returns to the page root", async () => {
    const slot = render({ subPath: "terminal/term_7" });
    await slot.findByText("repo");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const calls = JSON.stringify(slot.inspection.navigateCalls);
    expect(calls).toContain('"terminalId":"term_7"');
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "chats", options: { replace: true } }),
    );
  });

  it("folds forks, and side chats in their own folder, under the chat they came from", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    expect(slot.getByText("Claude chat")).toBeTruthy();
    expect(slot.queryByText("Claude fork")).toBeNull();
    expect(slot.queryByText("Side chats")).toBeNull();
    fireEvent.click(slot.getByLabelText("Show 1 fork and 1 side chat"));
    expect(slot.getByText("Claude fork")).toBeTruthy();
    // The side chat is not a fork: it waits in a folded "Side chats" folder.
    expect(slot.getByText("Side chats")).toBeTruthy();
    expect(slot.queryByText("btw: Side question")).toBeNull();
    fireEvent.click(slot.getByText("Side chats"));
    expect(slot.getByText("btw: Side question")).toBeTruthy();
    fireEvent.click(slot.getByLabelText("Hide 1 fork and 1 side chat"));
    expect(slot.queryByText("Claude fork")).toBeNull();
    expect(slot.queryByText("btw: Side question")).toBeNull();
  });

  it("applies a delta in place and refetches only when it cannot", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    const listCalls = () => slot.inspection.rpcCalls.filter((call) => call.method === "chats_list").length;
    const initial = listCalls();
    const delta = (from: string, to: string, title: string) => ({
      from,
      to,
      reload: false,
      projects: { upsert: [], remove: [] },
      chats: {
        upsert: [{ client: "codex", id: "22222222-2222-4222-8222-222222222222", title, updatedAt: 5, parentId: null, projectKey: "c:\\repo" }],
        remove: ["claude:11111111-1111-4111-8111-111111111111"],
      },
      warnings: [],
    });

    await slot.behavior.emitRealtime("chats-changed", delta("v1", "v2", "Codex renamed"));
    expect(await slot.findByText("Codex renamed")).toBeTruthy();
    expect(slot.queryByText("Claude chat")).toBeNull();
    expect(listCalls()).toBe(initial);

    // A delta from a version this view does not hold means one was missed.
    await slot.behavior.emitRealtime("chats-changed", delta("v7", "v8", "Skipped"));
    expect(listCalls()).toBe(initial + 1);

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    expect(listCalls()).toBe(initial + 2);
  });

  it("rescans on demand with force", async () => {
    const slot = render();
    await slot.findByText("repo");
    fireEvent.click(slot.getByLabelText("Rescan chats"));
    expect(slot.inspection.rpcCalls.at(-1)).toMatchObject({ method: "chats_list", input: { force: true } });
  });

  it("opens the chat view in the side panel of the page on screen", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      experimental_panel: { openTab: (options) => options.tab.context.kind === "thread" },
      rpc: { chats_list: () => ({ ...listing, version: "v1" }) },
    });
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getAllByLabelText("Open chat view")[0]!);
    expect(slot.inspection.experimental_panelCalls).toContainEqual(
      expect.objectContaining({
        method: "openTab",
        options: expect.objectContaining({
          tab: { id: "chat", context: { kind: "thread" }, availability: "action" },
          params: { client: "claude", id: "11111111-1111-4111-8111-111111111111", title: "Claude chat" },
        }),
      }),
    );
    expect(slot.inspection.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
  });

  it("switches to the Agent chats page only where no side panel accepts the tab", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getAllByLabelText("Open chat view")[0]!);
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "chats", options: { subPath: "chat/claude/11111111-1111-4111-8111-111111111111" } }),
    );
  });

  it("registers the chat tab for thread pages, the New thread screen, and its own page", () => {
    expect(app.tabs.map((tab) => [tab.id, tab.context.kind, tab.availability])).toEqual([
      ["chat", "thread", "action"],
      ["chat", "nav-panel", "action"],
    ]);
    expect(app.newThreadPanelActions.map((action) => action.id)).toEqual(["chat"]);
  });

  it("opens a bb terminal that belongs to the thread on screen", async () => {
    const slot = render({ threadId: "thr_1" });
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getAllByLabelText("Open in bb terminal")[0]!);
    await slot.findByText(/Opened in a bb terminal/);
    expect(slot.inspection.rpcCalls.at(-1)?.input).toEqual({
      client: "claude",
      id: "11111111-1111-4111-8111-111111111111",
      via: "bb",
      threadId: "thr_1",
    });
  });

  it("opens a chat's actions on a long press and runs the chosen one", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    const title = slot.getByText("Claude chat");
    fireEvent.pointerDown(title, { pointerType: "touch", clientX: 10, clientY: 10 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    fireEvent.pointerUp(title, { pointerType: "touch" });
    // The click that ends the long press does not open the chat.
    fireEvent.click(title);
    expect(slot.inspection.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
    const menu = await slot.findByRole("menu");
    expect(menu.textContent).toContain("Open chat view");
    fireEvent.click(slot.getByRole("menuitem", { name: /Open in bb terminal/ }));
    await slot.findByText(/Opened in a bb terminal/);
    expect(slot.inspection.rpcCalls.at(-1)?.input).toEqual({
      client: "claude",
      id: "11111111-1111-4111-8111-111111111111",
      via: "bb",
    });
    expect(slot.queryByRole("menu")).toBeNull();
  });

  it("does not open the actions when the finger moves (scrolling)", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    const title = slot.getByText("Claude chat");
    fireEvent.pointerDown(title, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(title, { pointerType: "touch", clientX: 10, clientY: 60 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(slot.queryByRole("menu")).toBeNull();
  });

  it("opens the same actions on right-click", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.contextMenu(slot.getByText("Claude chat"));
    fireEvent.click(await slot.findByRole("menuitem", { name: /Open chat view/ }));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "chats", options: { subPath: "chat/claude/11111111-1111-4111-8111-111111111111" } }),
    );
  });

  it("selects a thread terminal's tab in the page's side panel when the terminal opener declines", async () => {
    let selected: string | null = null;
    localStorage.clear();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      context: { projectId: null, threadId: "thr_1" },
      openTerminal: () => false,
      experimental_panel: { selectTab: (key: string) => ((selected = key), true) },
      experimental_panelTabs: {
        open: true,
        selectedKey: null,
        tabs: [{ key: "tab-7", title: "Claude Code: x", status: null, closable: true, detail: { kind: "terminal", terminalId: "term_1" } }],
      },
      rpc: {
        chats_list: () => ({ ...listing, version: "v1" }),
        chat_open: () => ({ message: "Opened in a bb terminal", terminalId: "term_1", inThread: true }),
      },
    });
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getAllByLabelText("Open in bb terminal")[0]!);
    await slot.findByText("Opened in a bb terminal");
    expect(selected).toBe("tab-7");
    expect(slot.inspection.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
  });

  it("keeps the thread page when its own terminal's tab cannot be selected from here", async () => {
    localStorage.clear();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      context: { projectId: null, threadId: "thr_1" },
      openTerminal: () => false,
      rpc: {
        chats_list: () => ({ ...listing, version: "v1" }),
        chat_open: () => ({ message: "Opened in a bb terminal", terminalId: "term_1", inThread: true }),
      },
    });
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getAllByLabelText("Open in bb terminal")[0]!);
    expect(await slot.findByText(/a tab in this thread's side panel/, {}, { timeout: 8000 })).toBeTruthy();
    expect(slot.inspection.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
  }, 10_000);

  it("asks the mounted Agent chats page to show a terminal the list could not", async () => {
    const page = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      openTerminal: () => true,
      rpc: { chats_list: () => ({ ...listing, version: "v1" }) },
    });
    await page.findByText("repo");
    const list = render({ openTerminal: false });
    const inList = within(list.container);
    fireEvent.click(await inList.findByText("repo"));
    fireEvent.click(inList.getAllByLabelText("Open in bb terminal")[0]!);
    await list.findByText(/Opened in a bb terminal/);
    expect(JSON.stringify(page.inspection.navigateCalls)).toContain("term_1");
    expect(list.queryByText("Show on Agent chats page")).toBeNull();
    expect(list.inspection.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
  });

  it("registers a hidden thread segment that lets a thread page focus its own new terminal", () => {
    const segment = app.threadContextSegments.find((candidate) => candidate.id === "terminal-opener");
    expect(segment).toBeDefined();
    expect(typeof segment?.useVisible).toBe("function");
  });

  it("orders client groups in a project by their newest chat", async () => {
    const { clientGroupsByActivity } = await import("./app/chat-tree");
    const chat = (client: "claude" | "codex", updatedAt: number) => ({ client, id: `${client}-${updatedAt}`, title: "t", updatedAt, parentId: null });
    expect(clientGroupsByActivity([chat("claude", 5), chat("codex", 9), chat("claude", 1)]).map((g) => g.client)).toEqual(["codex", "claude"]);
    expect(clientGroupsByActivity([chat("claude", 10), chat("codex", 9)]).map((g) => g.client)).toEqual(["claude", "codex"]);
    expect(clientGroupsByActivity([chat("codex", 3)]).map((g) => g.client)).toEqual(["codex"]);
  });
});

describe("new chat button", () => {
  const newChatCalls = (slot: ReturnType<typeof render>) =>
    slot.inspection.navigateCalls.filter((call) => call.method === "toPluginPanel" && JSON.stringify(call).includes('"new/'));

  it("opens a new chat view in the project, and a click on the folder itself only folds it", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    // The folder row folds and unfolds without starting a chat.
    fireEvent.click(slot.getByText("Claude Code"));
    expect(slot.queryByText("Claude chat")).toBeNull();
    fireEvent.click(slot.getByText("Claude Code"));
    expect(slot.getByText("Claude chat")).toBeTruthy();
    expect(newChatCalls(slot)).toHaveLength(0);
    // The button starts one, and leaves the folder open.
    fireEvent.click(slot.getByLabelText("New Claude Code chat"));
    expect(slot.getByText("Claude chat")).toBeTruthy();
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "chats", options: { subPath: `new/claude/${encodeURIComponent("C:\\repo")}` } }),
    );
  });

  it("offers the chat view and a bb terminal from the arrow, right-click, or long press", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getByLabelText("More ways to start a Codex chat"));
    const menu = slot.getByRole("menu", { name: "Start a new Codex chat" });
    fireEvent.click(within(menu).getByText("New chat in bb terminal (codex)"));
    await slot.findByText(/Started a new chat in a bb terminal/);
    expect(slot.inspection.rpcCalls.find((call) => call.method === "chat_new_terminal")?.input).toEqual({ client: "codex", cwd: "C:\\repo" });
    expect(slot.queryByRole("menu", { name: "Start a new Codex chat" })).toBeNull();
    fireEvent.contextMenu(slot.getByLabelText("New Codex chat"));
    fireEvent.click(within(slot.getByRole("menu", { name: "Start a new Codex chat" })).getByText("New chat view"));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "chats", options: { subPath: `new/codex/${encodeURIComponent("C:\\repo")}` } }),
    );
  });

  it("starts a chat without a project only in the Claude app, with no menu, and hides that button on phones", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("Chats without a project"));
    // Codex: no button at all (its link cannot ask for "no project").
    expect(slot.queryByLabelText("New Codex chat")).toBeNull();
    expect(slot.queryByLabelText("More ways to start a Codex chat")).toBeNull();
    expect(slot.queryByLabelText("New Codex chat in Codex app")).toBeNull();
    expect(slot.queryByLabelText("New Claude Code chat")).toBeNull();
    expect(slot.queryByLabelText("More ways to start a Claude Code chat")).toBeNull();
    const button = slot.getByLabelText("New Claude Code chat in Claude app");
    // Hidden on small touch screens: no desktop app there.
    expect(button.closest("[data-testid=new-app-chat]")?.className).toContain("max-md:pointer-coarse:hidden");
    fireEvent.contextMenu(button);
    expect(slot.queryByRole("menu")).toBeNull();
    fireEvent.click(button);
    expect(await slot.findByText(/send your first message there/)).toBeTruthy();
    expect(slot.inspection.rpcCalls.find((call) => call.method === "chat_new_app")?.input).toEqual({ client: "claude", cwd: null });
    expect(slot.inspection.rpcCalls.some((call) => call.method === "chat_new" || call.method === "chat_new_terminal")).toBe(false);
  });

  it("opens a new chat in the client's desktop app from the menu, like a chat's own targets", async () => {
    const slot = render();
    fireEvent.click(await slot.findByText("repo"));
    fireEvent.click(slot.getByLabelText("More ways to start a Claude Code chat"));
    const menu = slot.getByRole("menu", { name: "Start a new Claude Code chat" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "New chat view",
      "New chat in bb terminal (claude)",
      "New chat in Claude app",
      "Cancel",
    ]);
    fireEvent.click(within(menu).getByText("New chat in Claude app"));
    expect(await slot.findByText(/send your first message there/)).toBeTruthy();
    expect(slot.inspection.rpcCalls.find((call) => call.method === "chat_new_app")?.input).toEqual({ client: "claude", cwd: "C:\\repo" });
  });

  it("starts the chat with the first message and continues in its chat view", async () => {
    const slot = render({ subPath: `new/codex/${encodeURIComponent("C:\\repo")}` });
    expect(await slot.findByText(/New Codex chat in repo/)).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Message"), { target: { value: "Fix the login bug" } });
    fireEvent.click(slot.getByLabelText("Send"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "chat_new")?.input).toEqual({
      client: "codex",
      cwd: "C:\\repo",
      text: "Fix the login bug",
    });
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({
        method: "toPluginPanel",
        path: "chats",
        options: { subPath: "chat/codex/77777777-7777-4777-8777-777777777777", replace: true },
      }),
    );
    // bb keeps the page mounted and changes its sub-path: the new chat's view becomes the chat's view.
    const Page = app.navPanels[0]!.component;
    slot.lifecycle.rerender(<Page subPath="chat/codex/77777777-7777-4777-8777-777777777777" />);
    expect(await slot.findByLabelText("Back to chats")).toBeTruthy();
    expect(slot.queryByText(/New Codex chat in repo/)).toBeNull();
  });

  it("opens the folders down to a revealed chat", async () => {
    const { revealNodes } = await import("./app/chat-tree");
    const project = listing.projects[0]!;
    expect(revealNodes(project, "claude", "55555555-5555-4555-8555-555555555555")).toEqual({
      add: ["c:\\repo", "c:\\repo|claude|forks|11111111-1111-4111-8111-111111111111", "c:\\repo|claude|side|11111111-1111-4111-8111-111111111111"],
      remove: ["c:\\repo|claude|closed"],
    });
    expect(revealNodes(project, "codex", "22222222-2222-4222-8222-222222222222")).toEqual({ add: ["c:\\repo"], remove: ["c:\\repo|codex|closed"] });
  });
});
