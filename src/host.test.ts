import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import entry, { attachedViews } from "./host";

const root = mkdtempSync(path.join(tmpdir(), "agent-chats-"));
const home = path.join(root, "home");
const repo = path.join(root, "repo");
const bbData = path.join(root, "bbdata");
const context = {
  signal: new AbortController().signal,
  experimental_paths: { dataDir: path.join(bbData, "plugins", "agent-chats", "host-data"), tempDir: root },
} as unknown as Parameters<typeof entry.handlers.scan>[1];

const ids = {
  titled: "11111111-1111-4111-8111-111111111111",
  prompt: "22222222-2222-4222-8222-222222222222",
  empty: "33333333-3333-4333-8333-333333333333",
  sdk: "44444444-4444-4444-8444-444444444444",
  codex: "55555555-5555-4555-8555-555555555555",
  codexScratch: "66666666-6666-4666-8666-666666666666",
  codexSub: "77777777-7777-4777-8777-777777777777",
  codexBb: "88888888-8888-4888-8888-888888888888",
  forkA: "aaaaaaaa-0000-4000-8000-00000000000a",
  forkB: "aaaaaaaa-0000-4000-8000-00000000000b",
  forkC: "aaaaaaaa-0000-4000-8000-00000000000c",
  forkD: "aaaaaaaa-0000-4000-8000-00000000000d",
  codexFork: "aaaaaaaa-0000-4000-8000-0000000000cf",
  codexZstFork: "aaaaaaaa-0000-4000-8000-0000000000ce",
  codexUntitledFork: "aaaaaaaa-0000-4000-8000-0000000000cd",
  codexUntitledForkOfFork: "aaaaaaaa-0000-4000-8000-0000000000cc",
  missing: "bbbbbbbb-0000-4000-8000-00000000000b",
  lateClaudeFork: "aaaaaaaa-0000-4000-8000-0000000000e1",
  lateCodexFork: "aaaaaaaa-0000-4000-8000-0000000000e2",
  chainOld: "cccccccc-0000-4000-8000-00000000000a",
  chainNow: "cccccccc-0000-4000-8000-00000000000b",
  chainFork: "cccccccc-0000-4000-8000-00000000000c",
  appRoot: "eeeeeeee-0000-4000-8000-00000000000a",
  appDetached: "eeeeeeee-0000-4000-8000-00000000000b",
  appFork: "eeeeeeee-0000-4000-8000-00000000000c",
  appForkOfFork: "eeeeeeee-0000-4000-8000-00000000000d",
  appSide: "eeeeeeee-0000-4000-8000-00000000000e",
  appSideFork: "eeeeeeee-0000-4000-8000-00000000000f",
  claudeScratch: "dddddddd-0000-4000-8000-00000000000a",
};

const claudeProjects = () => path.join(home, ".claude", "projects", "repo");
const lateCodexRollout = () => path.join(home, ".codex", "rollout-late.jsonl");
const desktopRecords = () => path.join(home, "AppData", "Local", "Claude-Data", "claude_x", "claude-code-sessions");
const desktopRecord = () => path.join(desktopRecords(), "account", "org", "local_1.json");

function jsonl(...records: object[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

beforeAll(() => {
  const projects = path.join(home, ".claude", "projects", "repo");
  mkdirSync(projects, { recursive: true });
  mkdirSync(repo);
  writeFileSync(
    path.join(projects, `${ids.titled}.jsonl`),
    jsonl(
      { type: "user", cwd: repo, entrypoint: "claude-desktop", message: { content: "first prompt" } },
      { type: "ai-title", aiTitle: "AI title" },
      { type: "custom-title", customTitle: "Renamed chat" },
    ),
  );
  writeFileSync(
    path.join(projects, `${ids.prompt}.jsonl`),
    jsonl(
      { type: "user", cwd: repo, isMeta: true, message: { content: "meta" } },
      {
        type: "user",
        cwd: repo,
        message: { content: [{ type: "text", text: "<system-reminder>x</system-reminder>  Fix   the\nbug" }] },
      },
    ),
  );
  writeFileSync(path.join(projects, `${ids.empty}.jsonl`), jsonl({ type: "ai-title", aiTitle: "No prompt" }));
  writeFileSync(
    path.join(projects, `${ids.sdk}.jsonl`),
    jsonl({ type: "user", cwd: repo, entrypoint: "sdk-cli", message: { content: "from bb" } }),
  );
  writeFileSync(path.join(projects, "not-a-uuid.jsonl"), jsonl({ type: "user", cwd: repo, message: { content: "x" } }));

  // Older forks copy the parent's history; copied records keep the ancestors' session ids.
  const copied = (sessionId: string, text: string) => ({ type: "user", sessionId, cwd: repo, message: { content: text } });
  const forkFile = (id: string, title: string, ...ancestors: string[]) =>
    writeFileSync(
      path.join(projects, `${id}.jsonl`),
      jsonl(
        ...ancestors.map((ancestor) => copied(ancestor, `from ${ancestor}`)),
        copied(id, "own prompt"),
        { type: "custom-title", sessionId: id, customTitle: title },
      ),
    );
  forkFile(ids.forkA, "Fork A", ids.titled);
  forkFile(ids.forkB, "Fork B", ids.titled, ids.forkA);
  forkFile(ids.forkC, "Fork C", ids.titled, ids.forkA, ids.forkB);
  // Newer forks name their origin explicitly.
  writeFileSync(
    path.join(projects, `${ids.forkD}.jsonl`),
    jsonl(
      { type: "attachment", sessionId: ids.forkD, forkedFrom: { sessionId: ids.prompt, messageUuid: "m1" } },
      copied(ids.forkD, "explicit fork"),
    ),
  );

  // A Claude app chat on a chain of two sessions. The current one was resumed
  // in the app: megabytes of file snapshots come before its first message.
  writeFileSync(
    path.join(projects, `${ids.chainOld}.jsonl`),
    jsonl(copied(ids.chainOld, "chain prompt"), { type: "custom-title", sessionId: ids.chainOld, customTitle: "Old name" }),
  );
  const snapshot = { type: "file-history-snapshot", messageId: "m", snapshot: { files: "x".repeat(100 * 1024) } };
  writeFileSync(
    path.join(projects, `${ids.chainNow}.jsonl`),
    jsonl(
      { type: "custom-title", customTitle: "Session name" },
      ...Array.from({ length: 30 }, () => snapshot),
      { type: "user", sessionId: ids.chainNow, cwd: repo, message: { content: "chain prompt" } },
      ...Array.from({ length: 5 }, () => snapshot),
    ),
  );
  // A fork of the chain's replaced session.
  writeFileSync(
    path.join(projects, `${ids.chainFork}.jsonl`),
    jsonl(
      { type: "attachment", sessionId: ids.chainFork, forkedFrom: { sessionId: ids.chainOld, messageUuid: "m1" } },
      copied(ids.chainFork, "chain fork"),
      { type: "custom-title", sessionId: ids.chainFork, customTitle: "Chain fork" },
    ),
  );
  // A Claude app chat started without a project runs in its own scratch folder.
  const claudeScratch = path.join(home, "AppData", "Local", "Claude-Data", "claude_x", "scratch-workspaces", "account", "org", "scratch-2026-11-10-abc");
  writeFileSync(
    path.join(projects, `${ids.claudeScratch}.jsonl`),
    jsonl({ type: "user", sessionId: ids.claudeScratch, cwd: claudeScratch, message: { content: "no project" } }),
  );
  mkdirSync(path.dirname(desktopRecord()), { recursive: true });
  writeFileSync(
    desktopRecord(),
    JSON.stringify({ sessionId: "local_1", cliSessionId: ids.chainNow, priorCliSessionIds: [ids.chainOld], title: "App name", titleSource: "auto" }),
  );
  // A fork tree in the app: root <- detached side chat <- fork <- fork of that fork.
  // The app records each origin; the session files say otherwise for the last two.
  const appChat = (id: string, cwd: string, ...extra: object[]) =>
    writeFileSync(path.join(projects, `${id}.jsonl`), jsonl(...extra, { type: "user", sessionId: id, cwd, message: { content: `prompt ${id}` } }));
  appChat(ids.appRoot, repo);
  appChat(ids.appDetached, repo);
  // Its session file names a subfolder; the app files it under the project.
  appChat(ids.appFork, path.join(repo, "references"));
  appChat(ids.appForkOfFork, repo, { type: "attachment", sessionId: ids.appForkOfFork, forkedFrom: { sessionId: ids.appDetached, messageUuid: "m" } });
  const appRecord = (local: string, cliSessionId: string, title: string, more: object = {}) =>
    writeFileSync(
      path.join(path.dirname(desktopRecord()), `${local}.json`),
      JSON.stringify({ sessionId: local, cliSessionId, cwd: repo, title, ...more }),
    );
  appRecord("local_root", ids.appRoot, "App root");
  appRecord("local_detached", ids.appDetached, "Detached side chat", {
    forkedFromSessionId: "local_root",
    lineageDetached: true,
    lineageDetachedBy: "user",
  });
  appRecord("local_fork", ids.appFork, "App fork", { forkedFromSessionId: "local_detached" });
  appRecord("local_fork_of_fork", ids.appForkOfFork, "App fork of fork", { forkedFromSessionId: "local_fork" });
  // A side chat opened from the fork of a fork (third level), and a fork of that side chat.
  appChat(ids.appSide, repo);
  appChat(ids.appSideFork, repo);
  appRecord("local_side", ids.appSide, "btw: Side question", {
    forkedFromSessionId: "local_fork_of_fork",
    spawnedFrom: { sessionId: "local_fork_of_fork", sideSession: true, userFork: true, btw: true },
  });
  appRecord("local_side_fork", ids.appSideFork, "Side fork", {
    forkedFromSessionId: "local_side",
    spawnedFrom: { sessionId: "local_side", sideSession: true, userFork: true },
  });

  const codexHome = path.join(home, ".codex");
  mkdirSync(codexHome);
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, name TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, originator TEXT, rollout_path TEXT)",
  );
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(ids.codex, `\\\\?\\${repo}`, "long first message", "Codex name", "vscode", 0, 2000, null, null);
  insert.run(ids.codexScratch, path.join(home, "Documents", "Codex", "2026-10-01", "slug"), "scratch", null, "vscode", 0, 1000, null, null);
  insert.run(ids.codexSub, repo, "sub", null, '{"subagent":{"other":"guardian"}}', 0, 1000, null, null);
  insert.run(ids.codexBb, repo, "bb chat", null, "vscode", 0, 1000, "bb", null);
  insert.run("99999999-9999-4999-8999-999999999999", repo, "archived", null, "vscode", 1, 1000, null, null);
  const rollout = path.join(codexHome, "rollout-fork.jsonl");
  writeFileSync(rollout, jsonl({ type: "session_meta", payload: { id: ids.codexFork, forked_from_id: ids.codex, cwd: repo } }));
  insert.run(ids.codexFork, repo, "fork", "Codex fork", "vscode", 0, 3000, null, rollout);
  // Codex compresses older rollouts next to the indexed path as `<rollout>.zst`.
  const compressed = path.join(codexHome, "rollout-zst-fork.jsonl");
  const zstdCompressSync = (zlib as unknown as { zstdCompressSync: (data: string) => Buffer }).zstdCompressSync;
  writeFileSync(
    `${compressed}.zst`,
    zstdCompressSync(jsonl({ type: "session_meta", payload: { id: ids.codexZstFork, forked_from_id: ids.codex, cwd: repo } })),
  );
  insert.run(ids.codexZstFork, repo, "zst fork", "Codex zst fork", "vscode", 0, 2500, null, compressed);
  // Codex leaves a fork made by `thread/fork` untitled until its first new turn.
  const untitledFork = path.join(codexHome, "rollout-untitled-fork.jsonl");
  writeFileSync(untitledFork, jsonl({ type: "session_meta", payload: { id: ids.codexUntitledFork, forked_from_id: ids.codex, cwd: repo } }));
  insert.run(ids.codexUntitledFork, repo, "", null, "vscode", 0, 2400, null, untitledFork);
  // A fork of that untitled fork, also untitled.
  const untitledForkOfFork = path.join(codexHome, "rollout-untitled-fork-2.jsonl");
  writeFileSync(
    untitledForkOfFork,
    jsonl({ type: "session_meta", payload: { id: ids.codexUntitledForkOfFork, forked_from_id: ids.codexUntitledFork, cwd: repo } }),
  );
  insert.run(ids.codexUntitledForkOfFork, repo, "", null, "vscode", 0, 2300, null, untitledForkOfFork);
  // A thread Codex has indexed but whose rollout is not written yet.
  insert.run(ids.lateCodexFork, repo, "late", "Late Codex fork", "vscode", 0, 1500, null, lateCodexRollout());
  db.close();

  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.CODEX_HOME = codexHome;
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Watch listeners by store folder, registered once per (test) worker. */
const watchListeners = new Map<string, (event: unknown) => unknown>();

describe("scan", () => {
  it("groups user chats by project and client", async () => {
    const result = await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    expect(result.warnings).toEqual([]);
    const byName = Object.fromEntries(result.projects.map((project) => [project.name, project]));
    expect(Object.keys(byName).sort()).toEqual(["Chats without a project", "repo"]);

    const titles = Object.fromEntries(byName.repo!.chats.map((chat) => [chat.id, `${chat.client}:${chat.title}`]));
    expect(titles).toMatchObject({
      [ids.titled]: "claude:Renamed chat",
      [ids.prompt]: "claude:Fix the bug",
      [ids.codex]: "codex:Codex name",
    });
    // Both apps' scratch chats share one group, which lists both scratch roots.
    const scratch = byName["Chats without a project"]!;
    expect(scratch.chats.map((chat) => chat.id).sort()).toEqual([ids.codexScratch, ids.claudeScratch].sort());
    expect(scratch.path.split("\n").sort()).toEqual(
      [path.join(home, "Documents", "Codex"), path.join(home, "AppData", "Local", "Claude-Data", "claude_x", "scratch-workspaces")].sort(),
    );
  });

  it("nests forks under their origin, at most two fork levels deep", async () => {
    const result = await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    const repoChats = result.projects.find((project) => project.name === "repo")!.chats;
    const parents = Object.fromEntries(repoChats.map((chat) => [chat.id, chat.parentId]));
    expect(parents).toMatchObject({
      [ids.titled]: null,
      [ids.forkA]: ids.titled,
      [ids.forkB]: ids.forkA,
      // A fork of a fork of a fork is lifted to the second level.
      [ids.forkC]: ids.forkA,
      [ids.forkD]: ids.prompt,
      [ids.codex]: null,
      [ids.codexFork]: ids.codex,
      [ids.codexZstFork]: ids.codex,
      [ids.codexUntitledFork]: ids.codex,
    });
    expect(repoChats.find((chat) => chat.id === ids.codexUntitledFork)?.title).toBe("Codex name (fork)");
  });

  it("re-reads fork origins that were not written yet on an earlier scan", async () => {
    // A Claude session whose records do not carry a session id yet.
    writeFileSync(
      path.join(claudeProjects(), `${ids.lateClaudeFork}.jsonl`),
      jsonl({ type: "user", cwd: repo, message: { content: "late prompt" } }),
    );
    const before = await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    const parentsBefore = Object.fromEntries(before.projects.flatMap((p) => p.chats).map((c) => [c.id, c.parentId]));
    expect(parentsBefore[ids.lateClaudeFork]).toBeNull();
    expect(parentsBefore[ids.lateCodexFork]).toBeNull();

    writeFileSync(
      path.join(claudeProjects(), `${ids.lateClaudeFork}.jsonl`),
      jsonl(
        { type: "user", sessionId: ids.titled, cwd: repo, message: { content: "copied" } },
        { type: "user", sessionId: ids.lateClaudeFork, cwd: repo, message: { content: "late prompt" } },
      ),
    );
    writeFileSync(
      lateCodexRollout(),
      jsonl({ type: "session_meta", payload: { id: ids.lateCodexFork, forked_from_id: ids.codex, cwd: repo } }),
    );
    const after = await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    const parentsAfter = Object.fromEntries(after.projects.flatMap((p) => p.chats).map((c) => [c.id, c.parentId]));
    expect(parentsAfter[ids.lateClaudeFork]).toBe(ids.titled);
    expect(parentsAfter[ids.lateCodexFork]).toBe(ids.codex);
  });

  it.runIf(process.platform === "win32")("keeps one folder path for a project whose chats differ in case", async () => {
    const file = path.join(claudeProjects(), `${ids.missing}.jsonl`);
    writeFileSync(file, jsonl({ type: "user", sessionId: ids.missing, cwd: repo.toUpperCase(), message: { content: "upper" } }));
    try {
      const result = await entry.handlers.scan({ includeBbChats: false, force: true }, context);
      const project = result.projects.find((p) => p.chats.some((c) => c.id === ids.missing))!;
      expect(project.chats.map((c) => c.id)).toContain(ids.codex);
      expect(project.path).not.toContain("\n");
    } finally {
      rmSync(file);
    }
    await entry.handlers.scan({ includeBbChats: false, force: true }, context);
  });

  it("titles a chat from a prompt sent after a reminder block", async () => {
    const file = path.join(claudeProjects(), `${ids.missing}.jsonl`);
    writeFileSync(
      file,
      jsonl({
        type: "user",
        cwd: repo,
        message: { content: [{ type: "text", text: "<system-reminder>scratch folder</system-reminder>" }, { type: "text", text: "Draw a pelican" }] },
      }),
    );
    try {
      const result = await entry.handlers.scan({ includeBbChats: false, force: true }, context);
      expect(result.projects.flatMap((p) => p.chats).find((c) => c.id === ids.missing)?.title).toBe("Draw a pelican");
    } finally {
      rmSync(file);
    }
    await entry.handlers.scan({ includeBbChats: false, force: true }, context);
  });

  it("shows a Claude app chat once, as its current session, with the app's title", async () => {
    const result = await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    const repoChats = result.projects.find((project) => project.name === "repo")!.chats;
    const byId = Object.fromEntries(repoChats.map((chat) => [chat.id, chat]));
    expect(byId[ids.chainOld]).toBeUndefined();
    expect(byId[ids.chainNow]).toMatchObject({ title: "App name", parentId: null });
    // A fork of the replaced session hangs under the chat it belongs to.
    expect(byId[ids.chainFork]).toMatchObject({ title: "Chain fork", parentId: ids.chainNow });
    await expect(entry.handlers.locate({ client: "claude", id: ids.chainNow }, context)).resolves.toEqual({ cwd: repo, title: "App name" });
  });

  it("follows the Claude app's fork tree and folders, with detached chats at the top level", async () => {
    const result = await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    expect(result.projects.map((project) => project.name)).not.toContain("references");
    const parents = Object.fromEntries(
      result.projects.find((project) => project.name === "repo")!.chats.map((chat) => [chat.id, chat.parentId]),
    );
    expect(parents).toMatchObject({
      [ids.appRoot]: null,
      [ids.appDetached]: null,
      [ids.appFork]: ids.appDetached,
      // The app's origin wins over the session file's, and the third level is flattened to the second.
      [ids.appForkOfFork]: ids.appFork,
    });
  });

  it("marks Claude app side chats and keeps them under the chat they were opened from", async () => {
    const result = await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    const byId = Object.fromEntries(result.projects.find((project) => project.name === "repo")!.chats.map((chat) => [chat.id, chat]));
    // Not lifted by the two-level flattening: it stays with the chat it belongs to.
    expect(byId[ids.appSide]).toMatchObject({ parentId: ids.appForkOfFork, sideChat: true });
    // A fork of a side chat is an ordinary fork, nested under the side chat.
    expect(byId[ids.appSideFork]).toMatchObject({ parentId: ids.appSide });
    expect(byId[ids.appSideFork]!.sideChat).toBeUndefined();
    expect(byId[ids.appForkOfFork]!.sideChat).toBeUndefined();
  });

  it("includes chats started by bb on request", async () => {
    const result = await entry.handlers.scan({ includeBbChats: true, force: false }, context);
    const chatIds = result.projects.flatMap((project) => project.chats.map((chat) => chat.id));
    expect(chatIds).toContain(ids.sdk);
    expect(chatIds).toContain(ids.codexBb);
    expect(chatIds).not.toContain(ids.codexSub);
  });

  it("locates a chat's folder and title for a bb terminal", async () => {
    await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    await expect(entry.handlers.locate({ client: "codex", id: ids.codex }, context)).resolves.toEqual({
      cwd: repo,
      title: "Codex name",
    });
  });

  it("refuses to open an unknown chat", async () => {
    await expect(
      entry.handlers.open({ client: "codex", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, context),
    ).rejects.toThrow(/No codex chat/);
  });

  it("watches both chat stores and signals only chat-relevant changes", async () => {
    const listeners = watchListeners;
    const signals: unknown[] = [];
    const watchContext = {
      ...context,
      experimental_watch: async (options: { rootPath: string }, listener: (event: unknown) => unknown) => {
        listeners.set(options.rootPath, listener);
        return { dispose: async () => undefined };
      },
      experimental_emitSignal: async (signal: string, payload: unknown) => {
        signals.push([signal, payload]);
      },
    } as unknown as Parameters<typeof entry.handlers.watch>[1];

    await expect(entry.handlers.watch({}, watchContext)).resolves.toEqual({ watching: ["claude", "codex"] });
    // Idempotent: a second request adds no watches.
    await entry.handlers.watch({}, watchContext);
    expect(listeners.size).toBe(3);

    const claudeRoot = path.join(home, ".claude", "projects");
    const codexRoot = path.join(home, ".codex");
    const change = (root: string, ...parts: string[]) => ({
      kind: "changed",
      changes: [{ path: path.join(root, ...parts), type: "update" }],
    });
    await listeners.get(claudeRoot)!(change(claudeRoot, "repo", "x.jsonl"));
    await listeners.get(codexRoot)!(change(codexRoot, "logs_2.sqlite"));
    await listeners.get(codexRoot)!(change(codexRoot, "sessions", "2026", "11", "11", "rollout-x.jsonl.zst"));
    await listeners.get(codexRoot)!(change(codexRoot, "state_5.sqlite-wal"));
    await listeners.get(codexRoot)!({ kind: "rescan-required" });
    // The Claude app's chat records: a record changes, other app files do not count.
    await listeners.get(desktopRecords())!(change(desktopRecords(), "account", "org", "local_2.json"));
    await listeners.get(desktopRecords())!(change(desktopRecords(), "account", "org", "local_2.json.tmp"));
    expect(signals).toEqual([
      ["changed", { client: "claude" }],
      ["changed", { client: "codex" }],
      ["changed", { client: "codex" }],
      ["changed", { client: "codex" }],
      ["changed", { client: "claude" }],
    ]);
  });

  it("rereads only the session files the watch reported", async () => {
    // Watching is per worker: reuse the watch the previous test started.
    const listeners = watchListeners;
    const claudeRoot = path.join(home, ".claude", "projects");
    const reported = path.join(claudeRoot, "repo", `${ids.prompt}.jsonl`);
    const unreported = path.join(claudeRoot, "repo", `${ids.titled}.jsonl`);
    const titleOf = async (id: string, force: boolean) =>
      (await entry.handlers.scan({ includeBbChats: false, force }, context)).projects
        .flatMap((project) => project.chats)
        .find((chat) => chat.id === id)?.title;

    await entry.handlers.scan({ includeBbChats: false, force: true }, context);
    const retitle = (file: string, title: string) =>
      writeFileSync(file, jsonl({ type: "user", cwd: repo, message: { content: "prompt" } }, { type: "custom-title", customTitle: title }));
    retitle(reported, "Reported rename");
    retitle(unreported, "Unreported rename");
    await listeners.get(claudeRoot)!({ kind: "changed", changes: [{ path: reported, type: "update" }] });

    expect(await titleOf(ids.prompt, false)).toBe("Reported rename");
    // Not reported by the watch, so an incremental scan does not reread it...
    expect(await titleOf(ids.titled, false)).toBe("Renamed chat");
    // ...while a forced scan rereads everything.
    expect(await titleOf(ids.titled, true)).toBe("Unreported rename");

    // A reported deletion removes the chat.
    rmSync(reported);
    await listeners.get(claudeRoot)!({ kind: "changed", changes: [{ path: reported, type: "delete" }] });
    expect(await titleOf(ids.prompt, false)).toBeUndefined();
  });

  it("follows a rename in the Claude app once the watch reports its record", async () => {
    const titleOf = async () =>
      (await entry.handlers.scan({ includeBbChats: false, force: false }, context)).projects
        .flatMap((project) => project.chats)
        .find((chat) => chat.id === ids.chainNow)?.title;
    expect(await titleOf()).toBe("App name");
    writeFileSync(
      desktopRecord(),
      JSON.stringify({ sessionId: "local_1", cliSessionId: ids.chainNow, priorCliSessionIds: [ids.chainOld], title: "Renamed in app", titleSource: "user" }),
    );
    await watchListeners.get(desktopRecords())!({ kind: "changed", changes: [{ path: desktopRecord(), type: "update" }] });
    expect(await titleOf()).toBe("Renamed in app");
  });

  it("titles untitled forks from their origin's own title on every scan", async () => {
    for (let scan = 0; scan < 3; scan++) {
      const result = await entry.handlers.scan({ includeBbChats: false, force: scan === 2 }, context);
      const titles = Object.fromEntries(result.projects.flatMap((p) => p.chats).map((c) => [c.id, c.title]));
      expect(titles[ids.codexUntitledFork]).toBe("Codex name (fork)");
      expect(titles[ids.codexUntitledForkOfFork]).toBe("Forked chat");
    }
  });

  it("keeps the Codex listing and warns when the thread index cannot be read", async () => {
    const damaged = path.join(home, ".codex", "state_99.sqlite");
    writeFileSync(damaged, "not a database");
    try {
      const result = await entry.handlers.scan({ includeBbChats: false, force: true }, context);
      expect(result.warnings.some((warning) => warning.includes("could not read the thread index"))).toBe(true);
      expect(result.projects.flatMap((p) => p.chats).map((c) => c.id)).toContain(ids.codex);
    } finally {
      rmSync(damaged);
    }
    const recovered = await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    expect(recovered.warnings).toEqual([]);
  });

  it("rescans for the same unknown chat at most once per interval", async () => {
    const lookup = () => entry.handlers.locate({ client: "claude", id: ids.missing }, context);
    await expect(lookup()).rejects.toThrow(/No claude chat/);
    const file = path.join(claudeProjects(), `${ids.missing}.jsonl`);
    writeFileSync(file, jsonl({ type: "user", cwd: repo, message: { content: "created after the miss" } }));
    try {
      // Within the interval the miss is not rescanned, so the new file is not seen yet.
      await expect(lookup()).rejects.toThrow(/No claude chat/);
    } finally {
      rmSync(file);
    }
  });
});

describe("chat drivers", () => {
  const chatContext = {
    ...context,
    experimental_emitSignal: async () => undefined,
  } as unknown as Parameters<typeof entry.handlers.chat_load>[1];
  const ref = { client: "claude" as const, id: ids.titled };

  it("keeps a driver while a view is attached and drops it after the last one closes", async () => {
    await entry.handlers.scan({ includeBbChats: false, force: false }, context);
    // Concurrent first calls share one driver.
    await Promise.all([
      entry.handlers.chat_load({ ...ref, attach: true }, chatContext),
      entry.handlers.chat_load({ ...ref, attach: true }, chatContext),
    ]);
    expect(attachedViews(ref.client, ref.id)).toBe(2);
    // A reload does not attach.
    await entry.handlers.chat_load(ref, chatContext);
    expect(attachedViews(ref.client, ref.id)).toBe(2);
    await entry.handlers.chat_close(ref, chatContext);
    expect(attachedViews(ref.client, ref.id)).toBe(1);
    await entry.handlers.chat_close(ref, chatContext);
    expect(attachedViews(ref.client, ref.id)).toBeNull();
    // An extra close is harmless.
    await entry.handlers.chat_close(ref, chatContext);
    expect(attachedViews(ref.client, ref.id)).toBeNull();
  });
});
