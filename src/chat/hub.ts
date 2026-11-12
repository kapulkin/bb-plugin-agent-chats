// Per-chat view state shared by the Claude Code and Codex drivers: status,
// pending approvals, and the numbered events sent to open chat views.
import type { ChatClient, ChatEvent, ChatItem, ChatRequest } from "../shared/contract";

type Emit = (event: ChatEvent) => Promise<void>;

let emit: Emit | null = null;

/** Where chat events go; set from the host entry's signal context. */
export function setChatEmitter(next: Emit): void {
  emit = next;
}

/** An unanswered request is answered with its fallback option after this long. */
const REQUEST_TIMEOUT_MS = 30 * 60_000;

interface PendingRequest {
  request: ChatRequest;
  resolve: (optionId: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ChatSession {
  seq = 0;
  status: "idle" | "running" | "error" = "idle";
  error: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    readonly client: ChatClient,
    readonly id: string,
  ) {}

  /** Number and send one event; a view that sees a gap reloads. */
  private send(change: Omit<ChatEvent, "client" | "id" | "seq">): void {
    this.seq += 1;
    void emit?.({ client: this.client, id: this.id, seq: this.seq, ...change }).catch(() => undefined);
  }

  upsert(items: ChatItem[]): void {
    if (items.length > 0) this.send({ upsert: items });
  }

  setStatus(status: "idle" | "running" | "error", error: string | null = null): void {
    this.status = status;
    this.error = error;
    this.send({ status, error });
  }

  /** The history changed (a turn ended, an edit, a revert): views reload it. */
  reset(): void {
    this.send({ reset: true });
  }

  requests(): ChatRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /** Ask the user; resolves with the chosen option id, or `fallback` on timeout. */
  ask(request: ChatRequest, fallback: string): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(request.id, fallback), REQUEST_TIMEOUT_MS);
      this.pending.set(request.id, { request, resolve, timer });
      this.send({ requests: this.requests() });
    });
  }

  /** The user's answer; false when the request is no longer pending. Unknown options are rejected. */
  answer(requestId: string, optionId: string): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    if (!entry.request.options.some((option) => option.id === optionId)) {
      throw new Error(`"${optionId}" is not an answer to this request`);
    }
    return this.settle(requestId, optionId);
  }

  private settle(requestId: string, optionId: string): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(optionId);
    this.send({ requests: this.requests() });
    return true;
  }

  /** Answer every pending request with its fallback (the turn was stopped). */
  cancelRequests(fallback: (request: ChatRequest) => string): void {
    for (const entry of [...this.pending.values()]) this.settle(entry.request.id, fallback(entry.request));
  }
}

let pendingItems = 0;

/** A provisional item for a message the user just sent, replaced on reset. */
export function pendingUserItem(text: string): ChatItem {
  pendingItems += 1;
  return {
    // The counter keeps two sends in the same millisecond apart.
    id: `pending-${Date.now()}-${pendingItems}`,
    kind: "user",
    turnId: null,
    text,
    tool: null,
    patches: null,
    editable: false,
  };
}

export function noticeItem(id: string, text: string): ChatItem {
  return { id, kind: "notice", turnId: null, text, tool: null, patches: null, editable: false };
}

/** `promise`, or a rejection with `message` when it has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Bounded text for tool inputs and outputs shown in the view. */
export function clip(text: string, max = 20_000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}
