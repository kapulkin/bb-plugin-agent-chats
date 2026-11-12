// The chat view: a Claude Code or Codex conversation drawn with bb's building
// blocks, where the user sends messages, edits a message in place, forks a
// branch, and answers approvals. The host drives the session; this view keeps
// a copy of its state current from numbered `chat-events`.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Markdown,
  UrlLink,
  experimental_Diff as Diff,
  experimental_ProviderIcon as ProviderIcon,
  experimental_SourceCode as SourceCode,
  experimental_VoiceInputTextarea as VoiceInputTextarea,
  experimental_useProviders,
  useBbNavigate,
  useRealtime,
  useRpc,
  experimental_copyToClipboard as copyToClipboard,
} from "@get-bb/plugin-sdk/app";
import {
  CHAT_EVENTS,
  chatEventSchema,
  type ChatClient,
  type ChatEvent,
  type ChatItem,
  type ChatState,
  type EditPreview,
} from "../shared/contract";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { IconAction } from "./icon-action";
import { errorMessage } from "../shared/text";
import { resolveFileLink } from "./file-links";

const PROVIDER_ID: Record<ChatClient, string> = { claude: "claude-code", codex: "codex" };
const CLIENT_LABEL: Record<ChatClient, string> = { claude: "Claude Code", codex: "Codex" };

/**
 * Text for bb's code viewer. It counts lines in two places and fails with
 * "Line doesnt exist" when they disagree, which happens on a lone CR or the
 * Unicode line separators, so every line break becomes LF.
 */
export function codeText(value: string): string {
  return value.replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n");
}

/**
 * A distinct file name per block: bb's code viewer shares rendered results
 * between viewers of the same file, so equal names mixed different contents.
 */
export function codePath(owner: string, name: string): string {
  return `${owner.replace(/[^A-Za-z0-9_-]/g, "_")}/${name}`;
}

/**
 * Apply one event on top of `state`: `state` itself for an event it already
 * holds, null when a reload is needed (a reset, or a gap ahead of it).
 */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState | null {
  if (event.reset) return null;
  if (event.seq <= state.seq) return state;
  if (event.seq !== state.seq + 1) return null;
  let items = state.items;
  if (event.upsert) {
    items = [...items];
    for (const item of event.upsert) {
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) items.push(item);
      else items[index] = item;
    }
  }
  return {
    ...state,
    items,
    status: event.status ?? state.status,
    error: event.error === undefined ? state.error : event.error,
    requests: event.requests ?? state.requests,
    seq: event.seq,
  };
}

/** A tool call: one readable line, expanding to its links, output, and diffs. */
function ToolItem({ item }: { item: ChatItem }) {
  const tool = item.tool!;
  const failed = tool.status === "failed" || tool.status === "declined";
  return (
    <details className="group/tool text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        <Icon name={tool.icon} fallback="Toolbox" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={tool.summary}>
          {tool.summary}
        </span>
        {failed ? <Icon name="AlertCircle" className="size-3.5 shrink-0 text-destructive" aria-label={tool.status ?? undefined} /> : null}
        {tool.status === "inProgress" || tool.status === "running" ? (
          <span className="shrink-0 text-xs">running…</span>
        ) : null}
      </summary>
      <div className="ml-5 mt-1 space-y-2 border-l border-border pl-3">
        {tool.links.length > 0 ? (
          <ul className="space-y-0.5">
            {tool.links.slice(0, 10).map((link) => (
              <li key={link.url} className="flex min-w-0 items-center gap-1.5">
                <Icon name="ExternalLink" className="size-3 shrink-0 text-muted-foreground" />
                <UrlLink href={link.url} className="truncate">
                  {link.title}
                </UrlLink>
              </li>
            ))}
          </ul>
        ) : null}
        {item.patches?.map((patch) => (
          <Diff key={patch.path} patch={codeText(patch.diff)} path={patch.path} />
        ))}
        {tool.output === null || tool.output.trim() === "" ? null : (
          <SourceCode content={codeText(tool.output)} path={codePath(item.id, "output.txt")} overflow="wrap" />
        )}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Raw input · {tool.name}</summary>
          <SourceCode content={codeText(tool.input)} path={codePath(item.id, "input.json")} overflow="wrap" />
        </details>
      </div>
    </details>
  );
}

/** What an in-place edit does for each client, shown in the Edit button's tooltip. */
const EDIT_HINT: Record<ChatClient, string> = {
  claude: "Rewrite the chat from this message: later messages are replaced, and file changes made after it are undone.",
  codex: "Rewrite the chat from this message: later messages are replaced. Codex does not undo file changes.",
};
const FORK_HINT = "Start a new chat with the conversation up to this message. This chat stays unchanged.";

/** Sizes of a message's Edit and Fork buttons; their hints are long, so the tooltip is narrower. */
const MESSAGE_ACTION = { className: "size-6", iconClassName: "size-3.5", tooltipClassName: "max-w-64" };

function UserItem({
  item,
  client,
  busy,
  onEdit,
  onFork,
}: {
  item: ChatItem;
  client: ChatClient;
  busy: boolean;
  onEdit: (text: string) => Promise<void>;
  onFork: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text ?? "");
  if (editing) {
    return (
      <div className="ml-8 space-y-2 rounded-lg border border-border bg-card p-2">
        <VoiceInputTextarea
          value={draft}
          onValueChange={setDraft}
          aria-label="Edited message"
          className="min-h-20 w-full resize-y bg-transparent text-sm outline-none"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || draft.trim() === ""}
            onClick={() => {
              void onEdit(draft.trim()).then(() => setEditing(false));
            }}
          >
            Save and resend
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="group/msg ml-8 flex items-start justify-end gap-1">
      {item.editable ? (
        <span className="mt-1 hidden shrink-0 gap-0.5 group-hover/msg:flex">
          <IconAction icon="Edit" label="Edit message" hint={EDIT_HINT[client]} disabled={busy} {...MESSAGE_ACTION} onClick={() => setEditing(true)} />
          <IconAction icon="Fork" label="Fork from here" hint={FORK_HINT} disabled={busy} {...MESSAGE_ACTION} onClick={onFork} />
        </span>
      ) : null}
      <div className="min-w-0 rounded-lg bg-accent px-3 py-2 text-sm">
        <Markdown content={item.text ?? ""} />
      </div>
    </div>
  );
}

/** Confirmation shown before an edit rewinds files or starts a new chat. */
function EditConfirm({ preview, onConfirm, onCancel }: { preview: EditPreview; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
      <p className="font-medium">Rewrite the conversation from this message?</p>
      <p className="text-muted-foreground">The messages after it are removed from the conversation.</p>
      {preview.files.length > 0 ? (
        <div>
          <p>These files return to their state before the message:</p>
          <ul className="ml-4 list-disc font-mono text-xs">
            {preview.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.note === null ? null : <p className="text-muted-foreground">{preview.note}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onConfirm}>
          {preview.startsNewChat ? "Start a new chat" : "Rewrite"}
        </Button>
      </div>
    </div>
  );
}

export function ChatView({
  client,
  id,
  title,
  onBack,
  onOpenChat,
}: {
  client: ChatClient;
  id: string;
  title: string;
  /** Omitted in a side-panel tab, which bb closes with its own tab controls. */
  onBack?: () => void;
  onOpenChat: (client: ChatClient, id: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const provider = experimental_useProviders().providers.find((p) => p.id === PROVIDER_ID[client]) ?? { id: PROVIDER_ID[client] };
  const [state, setState] = useState<ChatState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const [pendingEdit, setPendingEdit] = useState<{ messageId: string; text: string; preview: EditPreview } | null>(null);
  const [acting, setActing] = useState(false);
  const stateRef = useRef<ChatState | null>(null);
  stateRef.current = state;
  const scroller = useRef<HTMLDivElement | null>(null);
  // Header context menu (right-click, or long press on touch): copy the chat name.
  const [copied, setCopied] = useState(false);
  const copyName = async () => {
    if (await copyToClipboard({ text: title })) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setFailure("Could not copy the chat name");
    }
  };

  // Only the latest load applies; events that arrive before it answers wait
  // in `buffered` and apply on top of it.
  const loadRequest = useRef(0);
  const loading = useRef(false);
  const buffered = useRef<ChatEvent[]>([]);

  const load = useCallback(
    (attach = false) => {
      const request = ++loadRequest.current;
      loading.current = true;
      rpc.call("chat_load", { client, id, ...(attach ? { attach } : {}) }).then(
        (loaded) => {
          if (request !== loadRequest.current) return;
          loading.current = false;
          let next: ChatState = loaded;
          let reload = false;
          for (const event of buffered.current.sort((a, b) => a.seq - b.seq)) {
            // Events the load already includes are skipped.
            if (event.seq <= next.seq) continue;
            const applied = applyChatEvent(next, event);
            if (applied === null) {
              reload = true;
              break;
            }
            next = applied;
          }
          buffered.current = [];
          stateRef.current = next;
          setState(next);
          setFailure(null);
          if (reload) load();
        },
        (cause: unknown) => {
          if (request !== loadRequest.current) return;
          loading.current = false;
          buffered.current = [];
          setFailure(errorMessage(cause));
        },
      );
    },
    [rpc, client, id],
  );

  useEffect(() => {
    stateRef.current = null;
    buffered.current = [];
    setState(null);
    load(true);
    return () => {
      // Answers of loads for the chat this view leaves are ignored.
      loadRequest.current += 1;
      void rpc.call("chat_close", { client, id }).catch(() => undefined);
    };
  }, [load, rpc, client, id]);

  useRealtime(CHAT_EVENTS, (payload) => {
    const event = chatEventSchema.safeParse(payload);
    if (!event.success || event.data.client !== client || event.data.id !== id) return;
    if (loading.current) {
      buffered.current.push(event.data);
      return;
    }
    // No state after a failed first load: events do not retry it, which could repeat the failure.
    const base = stateRef.current;
    if (base === null) return;
    const next = applyChatEvent(base, event.data);
    if (next === null) {
      load();
      return;
    }
    if (next === base) return;
    stateRef.current = next;
    setState(next);
  });

  // Follow the end of the conversation: a chat opens scrolled to its newest
  // message, and stays there while the user has not scrolled up. Markdown,
  // code, and diffs can grow after the first paint, so size changes re-pin too.
  const followEnd = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const pin = () => {
      if (followEnd.current) element.scrollTop = element.scrollHeight;
    };
    pin();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [state?.items]);

  // `acting` as a ref: a second Enter before the next render must see the first send.
  const actingRef = useRef(false);
  const act = async (work: () => Promise<unknown>) => {
    actingRef.current = true;
    setActing(true);
    try {
      await work();
      setFailure(null);
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      actingRef.current = false;
      setActing(false);
    }
  };

  const running = state?.status === "running";
  const send = () => {
    const text = draft.trim();
    if (text === "" || voiceActive || actingRef.current) return;
    setDraft("");
    void act(() => rpc.call("chat_send", { client, id, text }));
  };
  const startEdit = async (messageId: string, text: string) => {
    await act(async () => {
      const preview = await rpc.call("chat_edit_preview", { client, id, messageId });
      setPendingEdit({ messageId, text, preview });
    });
  };
  const confirmEdit = () => {
    const edit = pendingEdit;
    if (edit === null) return;
    setPendingEdit(null);
    void act(async () => {
      const next = await rpc.call("chat_edit", { client, id, messageId: edit.messageId, text: edit.text });
      if (next.id !== id) onOpenChat(next.client, next.id);
    });
  };
  const fork = (messageId: string) =>
    void act(async () => {
      const next = await rpc.call("chat_fork", { client, id, messageId });
      onOpenChat(next.client, next.id);
    });

  return (
    <TooltipProvider
      delayDuration={300}
      // Tooltips hold no controls: closing one as the pointer leaves lets the next button's open at once.
      disableHoverableContent
    >
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <ContextMenu>
        <ContextMenuTrigger asChild>
      <div className="flex shrink-0 items-center gap-2" aria-label="Chat header">
        {onBack === undefined ? null : (
          <Button variant="ghost" size="icon" className="size-7" aria-label="Back to chats" onClick={onBack}>
            <Icon name="ArrowLeft" className="size-4" />
          </Button>
        )}
        <ProviderIcon providerKind="agent" provider={provider} fallback="Bot" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={`${CLIENT_LABEL[client]} · ${id}`}>
          {title}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{copied ? "Copied" : (state?.status ?? "loading")}</span>
      </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void copyName()}>
            <Icon name="Copy" className="size-4" />
            Copy chat name
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div ref={scroller}
        onClickCapture={(event) => {
          // Local file links in messages open in bb's file preview, not as app routes.
          const anchor = (event.target as HTMLElement).closest?.("a");
          const href = anchor?.getAttribute("href");
          if (!anchor || href == null || state === null) return;
          const file = resolveFileLink(href, state.cwd);
          if (file === null) return;
          event.preventDefault();
          event.stopPropagation();
          const opened =
            state.hostId != null &&
            navigate.experimental_openFilePreview({
              target: { kind: "host", hostId: state.hostId, path: file.path },
              location: file.line === null ? null : { kind: "line", line: file.line, column: null },
            });
          if (!opened) setFailure(`Could not open ${file.path}`);
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          followEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {state === null ? <p className="text-sm text-muted-foreground">Loading conversation…</p> : null}
        {state?.items.map((item) =>
          item.kind === "user" ? (
            <UserItem
              key={item.id}
              item={item}
              client={client}
              busy={running || acting}
              onEdit={(text) => startEdit(item.id, text)}
              onFork={() => fork(item.id)}
            />
          ) : item.kind === "tool" ? (
            <ToolItem key={item.id} item={item} />
          ) : item.kind === "notice" ? (
            <p key={item.id} className="text-center text-xs text-muted-foreground">
              {item.text}
            </p>
          ) : (
            <div key={item.id} className="text-sm">
              <Markdown content={item.text ?? ""} />
            </div>
          ),
        )}
        {state?.requests.map((request) => (
          <div key={request.id} role="alertdialog" className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
            <p className="font-medium">{request.title}</p>
            <SourceCode content={codeText(request.detail)} path={codePath(request.id, "request.txt")} overflow="wrap" />
            <div className="flex flex-wrap justify-end gap-2">
              {request.options.map((option) => (
                <Button
                  key={option.id}
                  size="sm"
                  variant={option.id === "deny" || option.id === "decline" ? "ghost" : "default"}
                  onClick={() => void act(() => rpc.call("chat_answer", { client, id, requestId: request.id, optionId: option.id }))}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
        {pendingEdit === null ? null : (
          <EditConfirm preview={pendingEdit.preview} onConfirm={confirmEdit} onCancel={() => setPendingEdit(null)} />
        )}
      </div>

      {failure ?? state?.error ? (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          {failure ?? state?.error}
        </p>
      ) : null}
      <div className="flex shrink-0 items-end gap-2 rounded-lg border border-border bg-card p-2">
        <VoiceInputTextarea
          value={draft}
          onValueChange={setDraft}
          onVoiceInputActiveChange={setVoiceActive}
          aria-label="Message"
          placeholder={`Message ${CLIENT_LABEL[client]}`}
          className="max-h-48 min-h-10 w-full resize-none bg-transparent text-sm outline-none"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {running ? (
          <Button variant="ghost" size="icon" className={cn("size-8 shrink-0")} aria-label="Stop" onClick={() => void act(() => rpc.call("chat_stop", { client, id }))}>
            <Icon name="Square" className="size-4" />
          </Button>
        ) : null}
        <Button size="icon" className="size-8 shrink-0" aria-label="Send" disabled={draft.trim() === "" || acting} onClick={send}>
          <Icon name="ArrowUp" className="size-4" />
        </Button>
      </div>
    </div>
    </TooltipProvider>
  );
}
