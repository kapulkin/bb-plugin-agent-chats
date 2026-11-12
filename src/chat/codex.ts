// Codex chats in the chat view, through `codex app-server` (JSON-RPC over
// stdio, the protocol Codex's own clients use): history, sending, stopping,
// editing in place by reverting the thread, forking, and approvals.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { ChatSession, clip, pendingUserItem, withTimeout } from "./hub";
import type { ChatItem, ChatRequest, EditPreview } from "../shared/contract";
import {
  outputText,
  presentCodexWebSearch,
  presentCommand,
  presentFileChange,
  presentNamedTool,
  type ToolPresentation,
} from "./tools";
import { version as pluginVersion } from "../../package.json";
import { errorMessage } from "../shared/text";

type Json = Record<string, unknown>;
const REQUEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------- items

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Map one Codex thread item to a chat item; null for items the view does not show. */
function mapCodexItem(item: Json, turnId: string | null): ChatItem | null {
  const id = text(item.id) || `${turnId ?? "item"}-${text(item.type)}`;
  const base = { id, turnId, text: null, tool: null, patches: null, editable: false } as const;
  const tool = (name: string, view: ToolPresentation, input: unknown, output: unknown, status: unknown): ChatItem => ({
    ...base,
    kind: "tool",
    tool: {
      name,
      ...view,
      input: clip(typeof input === "string" ? input : JSON.stringify(input ?? null, null, 2)),
      output: outputText(output),
      status: typeof status === "string" ? status : null,
    },
  });
  switch (item.type) {
    case "userMessage": {
      const content = Array.isArray(item.content) ? (item.content as Json[]) : [];
      const prompt = content.filter((c) => c.type === "text").map((c) => text(c.text)).join("\n");
      return { ...base, kind: "user", text: prompt, editable: turnId !== null };
    }
    case "agentMessage":
      return text(item.text).trim() === "" ? null : { ...base, kind: "assistant", text: text(item.text) };
    case "commandExecution":
      return tool("command", presentCommand(text(item.command)), item.command, item.aggregatedOutput, item.status);
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
      const paths = changes.map((c) => text(c.path));
      return {
        ...tool("edit files", presentFileChange(paths), paths.join("\n"), null, item.status),
        patches: changes.map((c) => ({ path: text(c.path), diff: text(c.diff) })),
      };
    }
    case "mcpToolCall": {
      const name = `${text(item.server)}.${text(item.tool)}`;
      return tool(name, presentNamedTool(name, item.arguments), item.arguments, item.error ?? item.result, item.status);
    }
    case "dynamicToolCall":
      return tool(text(item.tool), presentNamedTool(text(item.tool), item.arguments), item.arguments, item.contentItems, item.status);
    case "webSearch": {
      const { type: _type, id: _id, ...rest } = item;
      return tool("web search", presentCodexWebSearch(item), rest, null, null);
    }
    default:
      return null;
  }
}

export function mapCodexTurns(turns: Json[]): ChatItem[] {
  return turns.flatMap((turn) => {
    const turnId = text(turn.id) || null;
    const items = Array.isArray(turn.items) ? (turn.items as Json[]) : [];
    return items.flatMap((item) => mapCodexItem(item, turnId) ?? []);
  });
}

// ---------------------------------------------------------------- app-server

type ServerRequestHandler = (method: string, params: Json) => Promise<unknown>;
type NotificationHandler = (method: string, params: Json) => void;

/** Characters of the app-server's stderr kept for error messages. */
const STDERR_TAIL_CHARS = 4000;
/** How a shell reports a missing command (on Windows `codex` starts through cmd.exe). */
const NOT_FOUND = /is not recognized as an internal or external command|command not found/i;
/** cmd.exe's and POSIX shells' exit codes for a missing command. */
const NOT_FOUND_EXIT_CODES = new Set([9009, 127]);
/** How this plugin introduces itself to `codex app-server`. */
const CLIENT_INFO = { name: "bb-agent-chats", title: null, version: pluginVersion };

/** One shared `codex app-server` child per host worker. */
export class AppServer {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private stderrTail = "";
  /** Whether the current child answered `initialize`. */
  private initialized = false;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly exitListeners = new Set<(message: string) => void>();
  readonly threads = new Map<string, { onNotification: NotificationHandler; onRequest: ServerRequestHandler }>();

  constructor(
    private readonly command = "codex",
    private readonly args = ["app-server"],
  ) {}

  /** Called with the reason whenever a running app-server exits or fails to start; returns the unsubscribe. */
  onExit(listener: (message: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private start(): Promise<void> {
    // A bare name goes through the shell on Windows, which resolves npm's `codex.cmd`.
    const shell = process.platform === "win32" && !path.isAbsolute(this.command);
    const child = spawn(this.command, this.args, { shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.stderrTail = "";
    this.initialized = false;
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // Writes to a child that already exited fail here; the exit below reports why.
    child.stdin!.on("error", () => undefined);
    readline.createInterface({ input: child.stdout! }).on("line", (line) => this.receive(line));
    child.once("error", (error: NodeJS.ErrnoException) => this.exited(child, error.code === "ENOENT" ? null : error.message));
    // `close` follows the end of stderr, so its tail is complete.
    child.once("close", (code, signal) => this.exited(child, `codex app-server exited (${signal ?? `code ${code}`})`));
    return this.call("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    }).then(() => {
      if (this.child === child) this.initialized = true;
    });
  }

  /** The child is gone: fail what waits on it and tell the open chats. Runs once per child. */
  private exited(child: ChildProcess, reason: string | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    const tail = this.stderrTail.trim();
    const message =
      reason === null || (!this.initialized && (NOT_FOUND_EXIT_CODES.has(child.exitCode ?? 0) || NOT_FOUND.test(tail)))
        ? "Codex CLI not found on PATH"
        : tail === ""
          ? reason
          : `${reason}: ${clip(tail.split("\n").slice(-5).join("\n"), 1000)}`;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
    for (const listener of [...this.exitListeners]) listener(message);
  }

  private ensure(): Promise<void> {
    if (this.ready === null) {
      const ready = this.start().catch((error) => {
        if (this.ready === ready) this.ready = null;
        throw error;
      });
      this.ready = ready;
    }
    return this.ready;
  }

  private write(child: ChildProcess | null, message: Json): void {
    // An answer meant for an app-server that exited must not reach its successor.
    if (child === null || child !== this.child) return;
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.child === null) {
        reject(new Error("codex app-server is not running"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server: ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write(this.child, { id, method, params });
    });
  }

  async request<T = Json>(method: string, params: unknown): Promise<T> {
    await this.ensure();
    return (await this.call(method, params)) as T;
  }

  private receive(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id === "number" && this.pending.has(id) && message.method === undefined) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      const error = message.error as { message?: string } | undefined;
      if (error) entry.reject(new Error(error.message ?? JSON.stringify(error)));
      else entry.resolve(message.result);
      return;
    }
    const method = typeof message.method === "string" ? message.method : null;
    if (method === null) return;
    const params = (message.params ?? {}) as Json;
    const thread = this.threads.get(text(params.threadId));
    if (id !== undefined) {
      // A request from the server (an approval or a question): answer it.
      const child = this.child;
      const handle = thread?.onRequest ?? (async () => Promise.reject(new Error("No open chat for this thread")));
      handle(method, params).then(
        (result) => this.write(child, { id, result }),
        (error: unknown) => this.write(child, { id, error: { code: -32603, message: errorMessage(error) } }),
      );
      return;
    }
    thread?.onNotification(method, params);
  }

  stop(): void {
    this.child?.stdin?.end();
    this.child?.kill();
  }
}

const appServer = new AppServer();
export const stopCodexAppServer = (): void => appServer.stop();

// ---------------------------------------------------------------- driver

const userInput = (value: string) => [{ type: "text", text: value, text_elements: [] }];
/** The answer to a request the user can no longer give: decline when offered. */
const declineAnswer = (request: ChatRequest) => (request.options.some((o) => o.id === "decline") ? "decline" : request.options[0]!.id);

export class CodexChat {
  private resumed = false;
  private resuming: Promise<void> | null = null;
  private activeTurnId: string | null = null;
  /** A `turn/start` in flight; sends wait for it so only one turn starts. */
  private starting: Promise<void> | null = null;
  /** The last turn that completed, in case its completion arrives before `turn/start` answers. */
  private completedTurnId: string | null = null;
  private closeWhenIdle = false;
  private disposed = false;
  private readonly live = new Map<string, ChatItem>();
  private readonly handlers: { onNotification: NotificationHandler; onRequest: ServerRequestHandler };
  private readonly stopWatchingExit: () => void;
  /** Called when the view closed and the thread was released, so the host can drop this driver. */
  onReleased: (() => void) | null = null;

  constructor(
    readonly session: ChatSession,
    private readonly threadId: string,
    private readonly server: AppServer = appServer,
  ) {
    // Two drivers for one thread would split its events; the host keeps one per chat.
    if (server.threads.has(threadId)) throw new Error("This Codex chat already has a driver");
    this.handlers = {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    };
    server.threads.set(threadId, this.handlers);
    this.stopWatchingExit = server.onExit((message) => this.onServerExit(message));
  }

  /** The app-server exited: the next send resumes the thread on a new one. */
  private onServerExit(message: string): void {
    const closing = this.closeWhenIdle;
    this.resumed = false;
    this.activeTurnId = null;
    this.closeWhenIdle = false;
    this.live.clear();
    this.session.cancelRequests(declineAnswer);
    this.session.setStatus("error", message);
    // The view closed during the turn the exit ended.
    if (closing) this.onReleased?.();
  }

  /** The thread was just started on this app-server, which keeps it loaded: no resume is needed. */
  markStarted(): void {
    this.resumed = true;
  }

  /** Forget this driver; the host calls this once it dropped it. */
  dispose(): void {
    this.disposed = true;
    this.stopWatchingExit();
    if (this.server.threads.get(this.threadId) === this.handlers) this.server.threads.delete(this.threadId);
  }

  async history(): Promise<ChatItem[]> {
    const { thread } = await this.server.request<{ thread: { turns: Json[] } }>("thread/read", {
      threadId: this.threadId,
      includeTurns: true,
    });
    return mapCodexTurns(thread.turns);
  }

  /** Resume the thread once; concurrent calls share the request. */
  private ensureResumed(): Promise<void> {
    if (this.resumed) return Promise.resolve();
    this.resuming ??= this.resume().finally(() => {
      this.resuming = null;
    });
    return this.resuming;
  }

  private async resume(): Promise<void> {
    try {
      await this.server.request("thread/resume", { threadId: this.threadId, excludeTurns: true });
    } catch (error) {
      const message = errorMessage(error);
      throw new Error(
        /already has an active writer/i.test(message)
          ? "This chat is open in another Codex client. Close it there to continue it here."
          : message,
      );
    }
    this.resumed = true;
  }

  async send(value: string): Promise<void> {
    if (this.disposed) throw new Error("This chat was closed; open it again to continue");
    this.closeWhenIdle = false;
    await this.ensureResumed();
    // A send while a turn starts steers that turn once it has an id.
    while (this.starting !== null) await this.starting.catch(() => undefined);
    this.session.upsert([pendingUserItem(value)]);
    if (this.activeTurnId !== null) {
      await this.server.request("turn/steer", { threadId: this.threadId, input: userInput(value), expectedTurnId: this.activeTurnId });
      return;
    }
    const starting = this.startTurn(value);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
      // The view closed while the turn started, and no turn runs (it failed, or already ended).
      if (this.closeWhenIdle && this.activeTurnId === null) this.close();
    }
  }

  private async startTurn(value: string): Promise<void> {
    this.session.setStatus("running");
    try {
      const { turn } = await this.server.request<{ turn: { id: string } }>("turn/start", { threadId: this.threadId, input: userInput(value) });
      if (turn.id !== this.completedTurnId) this.activeTurnId = turn.id;
    } catch (error) {
      this.activeTurnId = null;
      this.session.setStatus("error", errorMessage(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.session.cancelRequests(declineAnswer);
    if (this.activeTurnId !== null) {
      await this.server.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
    }
  }

  /** The host worker stops: end the running turn. */
  async shutdown(): Promise<void> {
    await withTimeout(this.stop(), 2000, "interrupt timed out").catch(() => undefined);
  }

  /** The view closed: release the thread now, or once the running turn ends. */
  close(): void {
    if (this.activeTurnId !== null || this.starting !== null) {
      this.closeWhenIdle = true;
      return;
    }
    this.closeWhenIdle = false;
    if (this.resumed) {
      this.resumed = false;
      void this.server.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => undefined);
    }
    this.onReleased?.();
  }

  private assertIdle(): void {
    if (this.activeTurnId !== null || this.starting !== null) {
      throw new Error("Wait for the current turn to finish, or stop it, before editing or forking");
    }
  }

  async previewEdit(): Promise<EditPreview> {
    this.assertIdle();
    return { files: [], note: "Codex does not undo file changes made after this message.", startsNewChat: false };
  }

  /** Rewrite the conversation from the turn of `turnId` with `value`. */
  async edit(turnId: string, value: string): Promise<void> {
    this.assertIdle();
    await this.ensureResumed();
    await this.server.request("thread/revert", { threadId: this.threadId, beforeTurnId: turnId });
    this.session.reset();
    await this.send(value);
  }

  /** Fork through the turn of `turnId` (inclusive); returns the new thread id. */
  async fork(turnId: string): Promise<string> {
    this.assertIdle();
    const { thread } = await this.server.request<{ thread: { id: string } }>("thread/fork", {
      threadId: this.threadId,
      lastTurnId: turnId,
      excludeTurns: true,
    });
    return thread.id;
  }

  private onNotification(method: string, params: Json): void {
    const turnId = text(params.turnId) || null;
    if (method === "item/started" || method === "item/completed") {
      const item = mapCodexItem(params.item as Json, turnId);
      if (item === null) return;
      this.live.set(item.id, item);
      this.session.upsert([item]);
    } else if (method === "item/agentMessage/delta") {
      const id = text(params.itemId);
      const item = this.live.get(id) ?? { id, kind: "assistant" as const, turnId, text: "", tool: null, patches: null, editable: false };
      item.text = `${item.text ?? ""}${text(params.delta)}`;
      this.live.set(id, item);
      this.session.upsert([item]);
    } else if (method === "turn/completed") {
      const turn = (params.turn ?? {}) as Json;
      this.completedTurnId = text(turn.id) || null;
      this.activeTurnId = null;
      this.live.clear();
      const failed = turn.status === "failed" ? JSON.stringify(turn.error ?? "Turn failed") : null;
      this.session.setStatus(failed === null ? "idle" : "error", failed);
      this.session.reset();
      if (this.closeWhenIdle) this.close();
    } else if (method === "turn/started") {
      const turn = (params.turn ?? {}) as Json;
      this.activeTurnId = text(turn.id) || this.activeTurnId;
    }
  }

  private async onRequest(method: string, params: Json): Promise<unknown> {
    const requestId = `${method}:${text(params.itemId) || Date.now()}:${text(params.approvalId)}`;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const command = method.includes("commandExecution");
      const decision = await this.session.ask(
        {
          id: requestId,
          title: command ? "Run this command?" : "Apply these file changes?",
          detail: clip(text(params.command) || text(params.reason) || JSON.stringify(params, null, 2), 4000),
          options: [
            { id: "accept", label: "Allow" },
            { id: "acceptForSession", label: "Allow for this chat" },
            { id: "decline", label: "Deny" },
          ],
        },
        "decline",
      );
      return { decision };
    }
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? (params.questions as Json[]) : [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of questions) {
        const options = Array.isArray(question.options) ? (question.options as Json[]) : [];
        if (options.length === 0) continue;
        const choice = await this.session.ask(
          {
            id: `${requestId}:${text(question.id)}`,
            title: text(question.header) || "Codex asks",
            detail: text(question.question),
            options: options.map((o, i) => ({ id: String(i), label: text(o.label) || String(i + 1) })),
          },
          "0",
        );
        answers[text(question.id)] = { answers: [text(options[Number(choice)]?.label)] };
      }
      return { answers };
    }
    if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
    throw new Error(`${method} is not supported in the bb chat view`);
  }
}

/**
 * Start a new Codex thread in `cwd` whose first turn sends `value`. The thread
 * is tagged as the user's (`threadSource` "user"), like those Codex's own
 * clients start. The returned driver runs that turn and keeps the thread.
 */
export async function startNewCodexChat(
  cwd: string,
  value: string,
  { server = appServer }: { server?: AppServer } = {},
): Promise<{ id: string; chat: CodexChat }> {
  const { thread } = await server.request<{ thread: { id: string } }>("thread/start", { cwd, threadSource: "user" });
  const chat = new CodexChat(new ChatSession("codex", thread.id), thread.id, server);
  chat.markStarted();
  await chat.send(value);
  return { id: thread.id, chat };
}
