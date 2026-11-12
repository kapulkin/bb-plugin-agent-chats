// Claude Code chats in the chat view, through the Claude Agent SDK: history
// from the session file, sending, stopping, editing in place (files rewound
// first), forking, and tool approvals.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  forkSession,
  getSessionMessages,
  query,
  type Options,
  type Query,
  type SDKUserMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ChatSession, clip, noticeItem, pendingUserItem, withTimeout } from "./hub";
import type { ChatItem, EditPreview } from "../shared/contract";
import { outputText, presentClaudeTool } from "./tools";
import { errorMessage } from "../shared/text";

type Block = Record<string, unknown>;

// ---------------------------------------------------------------- history

function blocks(message: unknown): Block[] | string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
}

/** A user prompt, as opposed to a record that only carries tool results. */
function isUserPrompt(message: SessionMessage): boolean {
  if (message.type !== "user" || message.parent_tool_use_id !== null) return false;
  const content = blocks(message.message);
  if (typeof content === "string") return content.trim() !== "";
  return content.some((b) => b.type === "text") && !content.some((b) => b.type === "tool_result");
}

function promptText(message: SessionMessage): string {
  const content = blocks(message.message);
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : "")).join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

/** A unified patch for one Edit/Write call, so the view can show it as a diff. */
function patchFor(name: string, input: Record<string, unknown>): { path: string; diff: string } | null {
  const file = typeof input.file_path === "string" ? input.file_path : null;
  if (file === null) return null;
  const lines = (text: unknown) => (typeof text === "string" ? text.split("\n") : []);
  const hunk = (before: string[], after: string[]) =>
    [`@@ -1,${before.length} +1,${after.length} @@`, ...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`)].join("\n");
  const header = (body: string) => `--- a/${file}\n+++ b/${file}\n${body}\n`;
  if (name === "Write") return { path: file, diff: header(hunk([], lines(input.content))) };
  if (name === "Edit") return { path: file, diff: header(hunk(lines(input.old_string), lines(input.new_string))) };
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const body = input.edits
      .map((e) => (e && typeof e === "object" ? hunk(lines((e as Block).old_string), lines((e as Block).new_string)) : ""))
      .join("\n");
    return { path: file, diff: header(body) };
  }
  return null;
}

/** Map a session's messages to chat items; tool results fill their tool item. */
export function mapClaudeMessages(messages: SessionMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ChatItem>();
  for (const message of messages) {
    if (message.parent_tool_use_id !== null) continue;
    if (message.type === "user") {
      if (isUserPrompt(message)) {
        items.push({
          id: message.uuid,
          kind: "user",
          turnId: null,
          text: promptText(message),
          tool: null,
          patches: null,
          editable: true,
        });
        continue;
      }
      const content = blocks(message.message);
      if (typeof content === "string") continue;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const tool = tools.get(String(block.tool_use_id));
        if (tool?.tool) {
          tool.tool.output = outputText(toolResultText(block.content));
          tool.tool.status = block.is_error === true ? "failed" : "completed";
        }
      }
      continue;
    }
    if (message.type !== "assistant") continue;
    const content = blocks(message.message);
    if (typeof content === "string") {
      items.push({ id: message.uuid, kind: "assistant", turnId: null, text: content, tool: null, patches: null, editable: false });
      continue;
    }
    content.forEach((block, index) => {
      if (block.type === "text" && String(block.text ?? "").trim() !== "") {
        items.push({
          id: `${message.uuid}#${index}`,
          kind: "assistant",
          turnId: null,
          text: String(block.text),
          tool: null,
          patches: null,
          editable: false,
        });
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "tool");
        const input = (block.input ?? {}) as Record<string, unknown>;
        const patch = patchFor(name, input);
        const item: ChatItem = {
          id: String(block.id ?? `${message.uuid}#${index}`),
          kind: "tool",
          turnId: null,
          text: null,
          tool: {
            name,
            ...presentClaudeTool(name, input),
            input: clip(JSON.stringify(input, null, 2)),
            output: null,
            status: "running",
          },
          patches: patch === null ? null : [patch],
          editable: false,
        };
        tools.set(item.id, item);
        items.push(item);
      }
    });
  }
  return items;
}

/** Where an in-place edit of `uuid` resumes, and whether it is the first or the last prompt. */
export function editPlan(
  messages: SessionMessage[],
  uuid: string,
): { kept: string | null; dropsTurn: string | null; first: boolean } {
  const index = messages.findIndex((m) => m.uuid === uuid);
  if (index === -1 || !isUserPrompt(messages[index]!)) throw new Error("The message to edit is no longer in this chat");
  const promptIndexes = messages.flatMap((m, i) => (isUserPrompt(m) ? [i] : []));
  const isLast = promptIndexes.at(-1) === index;
  return {
    kept: index === 0 ? null : messages[index - 1]!.uuid,
    // The CLI validates a single dropped turn; editing an earlier prompt drops several.
    dropsTurn: isLast ? uuid : null,
    first: promptIndexes[0] === index,
  };
}

/** The last entry of the turn containing `itemId` (a prompt or a reply), for forking. */
export function forkPoint(messages: SessionMessage[], itemId: string): string {
  const uuid = itemId.split("#")[0]!;
  const index = messages.findIndex((m) => m.uuid === uuid);
  if (index === -1) throw new Error("The message to fork from is no longer in this chat");
  const nextPrompt = messages.findIndex((m, i) => i > index && isUserPrompt(m));
  return messages[(nextPrompt === -1 ? messages.length : nextPrompt) - 1]!.uuid;
}

// ---------------------------------------------------------------- driver

/**
 * The installed `claude` executable, so the SDK runs the user's own Claude
 * Code; undefined lets the SDK resolve its own. The SDK spawns it without a
 * shell, so Windows takes only `claude.exe`, never npm's `.cmd`/`.ps1` shims.
 * The installer's folders are tried after PATH, which apps started from the
 * macOS GUI get without them.
 */
export function claudeExecutable(
  pathVariable = process.env.PATH ?? "",
  home = homedir(),
  windows = process.platform === "win32",
): string | undefined {
  const name = windows ? "claude.exe" : "claude";
  const dirs = [
    ...pathVariable.split(windows ? ";" : ":").filter((dir) => dir !== ""),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** How long a files-only resume may take before it is closed. */
const REWIND_TIMEOUT_MS = 15_000;

/** Read `q` to its end, closing it when that takes longer than `ms`. */
export async function drainQuery(q: AsyncIterable<unknown> & { close(): void }, ms: number): Promise<void> {
  const drained = (async () => {
    for await (const _ of q) {
      // Drain until the CLI exits.
    }
  })().catch(() => undefined);
  await withTimeout(drained, ms, "timed out").catch(() => q.close());
}

/** Streaming prompt input: the query stays open for more messages until closed. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    this.queued.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.queued.length > 0) yield this.queued.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

export class ClaudeChat {
  private live: { query: Query; input: PromptQueue } | null = null;
  private running = false;
  private closeWhenIdle = false;
  private readonly tools = new Map<string, ChatItem>();
  /** Called when the view closed and the query ended, so the host can drop this driver. */
  onReleased: (() => void) | null = null;

  /** `fresh`: no session file exists yet, so the first send starts the session under `sessionId`. */
  constructor(
    readonly session: ChatSession,
    private readonly sessionId: string,
    private readonly cwd: string,
    private fresh = false,
  ) {}

  private baseOptions(): Options {
    return {
      cwd: this.cwd,
      pathToClaudeCodeExecutable: claudeExecutable(),
      enableFileCheckpointing: true,
      settingSources: ["user", "project", "local"],
    };
  }

  private messages(): Promise<SessionMessage[]> {
    return getSessionMessages(this.sessionId, { dir: this.cwd });
  }

  async history(): Promise<ChatItem[]> {
    return mapClaudeMessages(await this.messages());
  }

  /** Start a live query; `extra` carries the resume point, or the id of a fresh session. */
  private start(extra: Partial<Options>): { query: Query; input: PromptQueue } {
    const input = new PromptQueue();
    const live = {
      input,
      query: query({
        prompt: input,
        options: {
          ...this.baseOptions(),
          ...extra,
          canUseTool: async (toolName, toolInput, { toolUseID }) => {
            const choice = await this.session.ask(
              {
                id: toolUseID,
                title: `Allow ${toolName}?`,
                detail: clip(JSON.stringify(toolInput, null, 2), 4000),
                options: [
                  { id: "allow", label: "Allow" },
                  { id: "deny", label: "Deny" },
                ],
              },
              "deny",
            );
            return choice === "allow"
              ? { behavior: "allow", updatedInput: toolInput }
              : { behavior: "deny", message: "Denied in the bb chat view" };
          },
        },
      }),
    };
    this.live = live;
    void this.pump(live);
    return live;
  }

  /** Forward the query's messages to open views until it ends. */
  private async pump(live: { query: Query; input: PromptQueue }): Promise<void> {
    try {
      for await (const message of live.query) {
        // The CLI is running the session, so a later query resumes it.
        this.fresh = false;
        if (message.type === "assistant") {
          const items = mapClaudeMessages([message as unknown as SessionMessage]);
          for (const item of items) if (item.kind === "tool") this.tools.set(item.id, item);
          this.session.upsert(items);
        } else if (message.type === "user") {
          const content = blocks((message as { message?: unknown }).message);
          if (typeof content === "string") continue;
          const updated: ChatItem[] = [];
          for (const block of content) {
            const tool = block.type === "tool_result" ? this.tools.get(String(block.tool_use_id)) : undefined;
            if (tool?.tool) {
              tool.tool.output = outputText(toolResultText(block.content));
              tool.tool.status = block.is_error === true ? "failed" : "completed";
              updated.push(tool);
            }
          }
          this.session.upsert(updated);
        } else if (message.type === "result") {
          this.running = false;
          this.tools.clear();
          const failed = message.is_error ? String((message as { result?: unknown }).result ?? message.subtype) : null;
          this.session.setStatus(failed === null ? "idle" : "error", failed);
          this.session.reset();
          if (this.closeWhenIdle) this.close();
        }
      }
    } catch (error) {
      this.session.setStatus("error", errorMessage(error));
    } finally {
      if (this.live === live) this.live = null;
      this.running = false;
      // The query ended without a result (it failed or was closed): finish a pending close.
      if (this.closeWhenIdle) this.close();
    }
  }

  async send(text: string): Promise<void> {
    const live = this.live ?? this.start(this.fresh ? { sessionId: this.sessionId } : { resume: this.sessionId });
    this.closeWhenIdle = false;
    this.running = true;
    this.session.setStatus("running");
    this.session.upsert([pendingUserItem(text)]);
    live.input.push(text);
  }

  async stop(): Promise<void> {
    this.session.cancelRequests(() => "deny");
    await this.live?.query.interrupt().catch(() => undefined);
  }

  /** The host worker stops: interrupt the running turn and end the query. */
  async shutdown(): Promise<void> {
    this.session.cancelRequests(() => "deny");
    const live = this.live;
    this.live = null;
    if (live === null) return;
    if (this.running) await withTimeout(live.query.interrupt(), 2000, "interrupt timed out").catch(() => undefined);
    live.input.close();
    live.query.close();
  }

  /** The view closed: end the query now, or after the running turn. */
  close(): void {
    if (this.running) {
      this.closeWhenIdle = true;
      return;
    }
    this.closeWhenIdle = false;
    this.endQuery();
    this.onReleased?.();
  }

  /** End the live query; the next send starts another. */
  private endQuery(): void {
    this.live?.input.close();
    this.live = null;
  }

  private assertIdle(): void {
    if (this.running) throw new Error("Wait for the current turn to finish, or stop it, before editing or forking");
  }

  /** Rewind files to their state before `uuid` in a full-chain resume that sends nothing. */
  private async rewindFiles(uuid: string, dryRun: boolean): Promise<{ files: string[]; error: string | null }> {
    const input = new PromptQueue();
    const q = query({ prompt: input, options: { ...this.baseOptions(), resume: this.sessionId } });
    try {
      const result = await withTimeout(q.rewindFiles(uuid, { dryRun }), REWIND_TIMEOUT_MS, "Claude Code did not answer in time");
      return { files: result.filesChanged ?? [], error: result.canRewind ? null : (result.error ?? "Files cannot be rewound") };
    } finally {
      input.close();
      await drainQuery(q, REWIND_TIMEOUT_MS);
    }
  }

  async previewEdit(uuid: string): Promise<EditPreview> {
    this.assertIdle();
    const plan = editPlan(await this.messages(), uuid);
    this.endQuery();
    const { files, error } = await this.rewindFiles(uuid, true).catch((cause: unknown) => ({
      files: [] as string[],
      error: errorMessage(cause),
    }));
    const notes = ["Changes made by shell commands are not undone; only Claude's file tools are tracked."];
    if (error !== null) notes.unshift(`Files cannot be restored: ${error.replace(/\.$/, "")}.`);
    if (plan.first) notes.unshift("Claude Code cannot rewrite the first message in place, so the edit starts a new chat.");
    return { files, note: notes.join(" "), startsNewChat: plan.first };
  }

  /** Rewrite the conversation from `uuid` with `text`; returns the chat that continues. */
  async edit(uuid: string, text: string): Promise<{ id: string; newChat: ClaudeChat | null }> {
    this.assertIdle();
    const plan = editPlan(await this.messages(), uuid);
    this.endQuery();
    // The preview already said when files cannot be restored; the edit goes on without them.
    await this.rewindFiles(uuid, false).catch(() => undefined);
    if (plan.first || plan.kept === null) {
      const created = await startNewClaudeChat(this.cwd, text);
      return { id: created.id, newChat: created.chat };
    }
    this.start({
      resume: this.sessionId,
      resumeSessionAt: plan.kept,
      ...(plan.dropsTurn === null ? {} : { resumeDropsTurn: plan.dropsTurn }),
    });
    this.session.reset();
    await this.send(text);
    return { id: this.sessionId, newChat: null };
  }

  async fork(itemId: string): Promise<string> {
    this.assertIdle();
    const point = forkPoint(await this.messages(), itemId);
    const { sessionId } = await forkSession(this.sessionId, { dir: this.cwd, upToMessageId: point });
    return sessionId;
  }
}

/**
 * Start a new Claude Code session in `cwd` whose first turn sends `text`. The
 * returned chat drives that turn (status, events, approvals) and keeps its
 * query for later sends.
 */
async function startNewClaudeChat(cwd: string, text: string): Promise<{ id: string; chat: ClaudeChat }> {
  const id = randomUUID();
  const chat = new ClaudeChat(new ChatSession("claude", id), id, cwd, true);
  chat.session.upsert([noticeItem(`new-${id}`, "Started from an edited first message.")]);
  await chat.send(text);
  return { id, chat };
}
