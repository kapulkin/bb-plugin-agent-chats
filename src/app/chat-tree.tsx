// The chat list: a foldable tree of project folders, each with its Claude Code
// and Codex chats and their forks. A row click opens the chat the way the
// "Open … chats in" setting says; hover actions (or a long press) pick a way.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders,
  useBbContext,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useOpenChatView, useOpenNewChatView } from "./routes";
import { PROJECTLESS_KEY, type Chat, type ChatClient, type OpenVia, type Project } from "../shared/contract";
import { IconAction } from "./icon-action";
import { threadOnScreen, useShowOpenedTerminal, type OpenStatus } from "./terminal-opening";
import { errorMessage } from "../shared/text";
import { useChats, useExpanded, useRevealRequest } from "./use-chats";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const CLIENTS: { client: ChatClient; label: string; providerId: string }[] = [
  { client: "claude", label: "Claude Code", providerId: "claude-code" },
  { client: "codex", label: "Codex", providerId: "codex" },
];
const PAGE = 15;

/** A project's client groups that have chats, the group with the newest chat first. */
export function clientGroupsByActivity(chats: Chat[]): { client: ChatClient; label: string; providerId: string; chats: Chat[] }[] {
  return CLIENTS.map((group) => ({ ...group, chats: chats.filter((chat) => chat.client === group.client) }))
    .filter((group) => group.chats.length > 0)
    .map((group) => ({ group, latest: Math.max(...group.chats.map((chat) => chat.updatedAt)) }))
    .sort((a, b) => b.latest - a.latest)
    .map(({ group }) => group);
}

/** Hover actions per chat row; `hint` is the tooltip's second line. */
const OPENERS: Record<ChatClient, { via: OpenVia; icon: string; label: string; hint: string }[]> = {
  claude: [
    { via: "bb", icon: "PanelBottom", label: "Open in bb terminal", hint: "claude --resume in a bb terminal tab" },
    { via: "app", icon: "AppWindow", label: "Open in Claude app", hint: "Claude desktop app" },
  ],
  codex: [
    { via: "bb", icon: "PanelBottom", label: "Open in bb terminal", hint: "codex resume in a bb terminal tab" },
    { via: "app", icon: "AppWindow", label: "Open in Codex app", hint: "Codex desktop app" },
  ],
};

function relativeTime(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(ms).toLocaleDateString();
}

function matches(query: string, ...values: string[]): boolean {
  return values.some((value) => value.toLowerCase().includes(query));
}

function filterProjects(projects: Project[], query: string): Project[] {
  if (query === "") return projects;
  return projects.flatMap((project) => {
    if (matches(query, project.name, project.path)) return [project];
    const chats = project.chats.filter((chat) => matches(query, chat.title, chat.id));
    return chats.length === 0 ? [] : [{ ...project, chats }];
  });
}

function TreeRow({
  depth,
  open,
  onToggle,
  icon,
  label,
  title,
  count,
  actions,
}: {
  depth: number;
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  title?: string;
  count: number;
  /** Buttons after the count. Siblings of the fold toggle, so a click on the row never reaches them. */
  actions?: ReactNode;
}) {
  return (
    <div className="flex w-full items-center rounded-md pr-1 hover:bg-accent">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left text-sm"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{count}</span>
      </button>
      {actions}
    </div>
  );
}

/** How a new chat opens: its chat view, the client's CLI in a bb terminal, or the client's desktop app. */
type NewChatVia = "view" | "bb" | "app";

/**
 * The split "New chat" button of a client folder: the button starts a new
 * chat in its chat view; the arrow, a right-click, or a long press on touch
 * screens opens the menu of ways to start one (`onMenu`).
 */
function NewChatButton({
  clientLabel,
  where,
  busy,
  menuOpen,
  onNew,
  onMenu,
}: {
  clientLabel: string;
  where: string;
  busy: boolean;
  menuOpen: boolean;
  onNew: () => void;
  onMenu: (open: boolean) => void;
}) {
  const longPress = useLongPress(() => onMenu(true));
  return (
    <span className="flex shrink-0 items-center" {...longPress.handlers}>
      <IconAction
        icon="MessageSquarePlus"
        label={`New ${clientLabel} chat`}
        hint={`Chat view, ${where}`}
        disabled={busy}
        className="size-6 text-muted-foreground hover:text-foreground"
        iconClassName="size-3.5"
        onClick={() => {
          if (!longPress.consume()) onNew();
        }}
      />
      <IconAction
        icon="ChevronDown"
        label={`More ways to start a ${clientLabel} chat`}
        hint="Chat view, bb terminal, or the desktop app"
        disabled={busy}
        className={cn("h-6 w-4 text-muted-foreground hover:text-foreground", menuOpen && "text-foreground")}
        iconClassName="size-3"
        onClick={() => onMenu(!menuOpen)}
      />
    </span>
  );
}

/**
 * "New chat" for "Chats without a project": only the desktop app starts such a
 * chat (it makes the folder and briefs the model), so there is no menu. Hidden
 * on phones (small touch screens), where the desktop app is not at hand.
 */
function NewAppChatButton({
  client,
  clientLabel,
  busy,
  onNew,
}: {
  client: ChatClient;
  clientLabel: string;
  busy: boolean;
  onNew: () => void;
}) {
  const app = client === "claude" ? "Claude" : "Codex";
  return (
    <span className="flex shrink-0 items-center max-md:pointer-coarse:hidden" data-testid="new-app-chat">
      <IconAction
        icon="MessageSquarePlus"
        label={`New ${clientLabel} chat in ${app} app`}
        hint={`${app} makes its folder for a chat without a project; send the first message there`}
        disabled={busy}
        className="size-6 text-muted-foreground hover:text-foreground"
        iconClassName="size-3.5"
        onClick={onNew}
      />
    </span>
  );
}

/** The ways to start a new chat, shown under the client folder row. */
function NewChatMenu({
  clientLabel,
  cli,
  depth,
  busy,
  onChoose,
  onClose,
}: {
  clientLabel: string;
  cli: string;
  depth: number;
  busy: boolean;
  onChoose: (via: NewChatVia) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="menu"
      aria-label={`Start a new ${clientLabel} chat`}
      className="mb-1 mr-1 flex flex-col gap-0.5 rounded-md border border-border bg-card p-1"
      style={{ marginLeft: `${depth * 14 + 22}px` }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <Button role="menuitem" variant="ghost" className="h-10 justify-start gap-2" disabled={busy} onClick={() => onChoose("view")}>
        <Icon name="MessageSquare" className="size-4" />
        New chat view
      </Button>
      <Button role="menuitem" variant="ghost" className="h-10 justify-start gap-2" disabled={busy} onClick={() => onChoose("bb")}>
        <Icon name="PanelBottom" className="size-4" />
        New chat in bb terminal ({cli})
      </Button>
      <Button role="menuitem" variant="ghost" className="h-10 justify-start gap-2" disabled={busy} onClick={() => onChoose("app")}>
        <Icon name="AppWindow" className="size-4" />
        New chat in {cli === "claude" ? "Claude" : "Codex"} app
      </Button>
      <Button role="menuitem" variant="ghost" className="h-10 justify-start gap-2 text-muted-foreground" onClick={onClose}>
        <Icon name="X" className="size-4" />
        Cancel
      </Button>
    </div>
  );
}

/** A chat with the forks and side chats shown under it (see `parentId`). */
interface ChatNode {
  chat: Chat;
  forks: ChatNode[];
  /** Claude app side chats, shown in a "Side chats" folder after the forks. */
  sideChats: ChatNode[];
  /** Newest activity in the chat or anything under it. */
  latest: number;
}

/** Nest chats under their `parentId`; a chat whose parent is not listed is top-level. */
function buildForkTree(chats: Chat[]): ChatNode[] {
  const nodes = new Map(chats.map((chat) => [chat.id, { chat, forks: [], sideChats: [], latest: chat.updatedAt } as ChatNode]));
  const roots: ChatNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.chat.parentId === null ? undefined : nodes.get(node.chat.parentId);
    if (parent === undefined) roots.push(node);
    else (node.chat.sideChat ? parent.sideChats : parent.forks).push(node);
  }
  const settle = (node: ChatNode): number => {
    for (const child of [...node.forks, ...node.sideChats]) node.latest = Math.max(node.latest, settle(child));
    node.forks.sort((a, b) => b.latest - a.latest);
    node.sideChats.sort((a, b) => b.latest - a.latest);
    return node.latest;
  };
  for (const root of roots) settle(root);
  return roots.sort((a, b) => b.latest - a.latest);
}

/** What a chat's fold toggle shows or hides, e.g. "2 forks and 3 side chats". */
function childrenLabel(item: ChatNode): string {
  const parts: string[] = [];
  if (item.forks.length > 0) parts.push(`${item.forks.length} ${item.forks.length === 1 ? "fork" : "forks"}`);
  if (item.sideChats.length > 0) parts.push(`${item.sideChats.length} ${item.sideChats.length === 1 ? "side chat" : "side chats"}`);
  return parts.join(" and ");
}

/** How long a touch must stay down, without moving, to open a row's actions. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/**
 * Long press on touch screens (no hover there, so a row's action buttons
 * never show) and right-click with a mouse both call `onLongPress`. `consume`
 * tells the click that ends a long press not to open the chat as well.
 */
function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => cancel, []);
  return {
    consume: () => {
      const wasLongPress = fired.current;
      fired.current = false;
      return wasLongPress;
    },
    handlers: {
      onPointerDown: (event: ReactPointerEvent) => {
        if (event.pointerType === "mouse") return;
        fired.current = false;
        origin.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(() => {
          timer.current = null;
          fired.current = true;
          onLongPress();
        }, LONG_PRESS_MS);
      },
      onPointerMove: (event: ReactPointerEvent) => {
        const start = origin.current;
        if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: (event: { preventDefault(): void }) => {
        // Mobile browsers also raise this on a long press; the menu just stays open.
        event.preventDefault();
        cancel();
        onLongPress();
      },
    },
  };
}

function ChatRow({
  chat,
  depth,
  busy,
  onOpen,
  onView,
  forks,
  highlighted = false,
}: {
  chat: Chat;
  depth: number;
  busy: boolean;
  onOpen: (via?: OpenVia) => void;
  onView: () => void;
  /** A chat just started from a "New chat" button, revealed in the tree. */
  highlighted?: boolean;
  /** Present when the chat has forks or side chats: what is under it and its fold state. */
  forks?: { count: number; label: string; open: boolean; onToggle: () => void };
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useLongPress(() => setMenuOpen(true));
  const choose = (open: () => void) => {
    setMenuOpen(false);
    open();
  };
  return (
    <>
      {/* A named group: bb's sidebar is itself a `group`, so a bare `group-hover`
          would reveal every row's actions while the sidebar is hovered. */}
      <div
        {...longPress.handlers}
        data-chat-row={`${chat.client}:${chat.id}`}
        className={cn(
          "group/chat flex select-none items-center gap-1 rounded-md pr-1 [-webkit-touch-callout:none] hover:bg-accent",
          highlighted && "bg-accent ring-1 ring-ring",
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {forks === undefined ? (
          <span className="size-3.5 shrink-0" />
        ) : (
          <button
            type="button"
            onClick={forks.onToggle}
            aria-expanded={forks.open}
            aria-label={`${forks.open ? "Hide" : "Show"} ${forks.label}`}
            className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <Icon name={forks.open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!longPress.consume()) onOpen();
          }}
          title={`${chat.title}\n${chat.id}`}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm disabled:opacity-60"
        >
          <span className="min-w-0 flex-1 truncate">{chat.title}</span>
          {forks === undefined ? null : (
            <span className="shrink-0 text-xs text-muted-foreground">{forks.count}</span>
          )}
          <span className="shrink-0 text-xs text-muted-foreground group-hover/chat:hidden">
            {relativeTime(chat.updatedAt)}
          </span>
        </button>
        <span className="hidden shrink-0 items-center group-hover/chat:flex">
          <IconAction
            icon="MessageSquare"
            label="Open chat view"
            hint="Send, edit, and fork in bb"
            disabled={busy}
            className="size-6 text-muted-foreground hover:text-foreground"
            iconClassName="size-3.5"
            onClick={onView}
          />
          {OPENERS[chat.client].map((opener) => (
            <IconAction
              key={opener.via}
              icon={opener.icon}
              label={opener.label}
              hint={opener.hint}
              disabled={busy}
              className="size-6 text-muted-foreground hover:text-foreground"
              iconClassName="size-3.5"
              onClick={() => onOpen(opener.via)}
            />
          ))}
        </span>
      </div>
      {menuOpen ? (
        <div
          role="menu"
          aria-label={`Open ${chat.title}`}
          className="mb-1 mr-1 flex flex-col gap-0.5 rounded-md border border-border bg-card p-1"
          style={{ marginLeft: `${depth * 14 + 22}px` }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setMenuOpen(false);
          }}
        >
          <Button role="menuitem" variant="ghost" className="h-10 justify-start gap-2" disabled={busy} onClick={() => choose(onView)}>
            <Icon name="MessageSquare" className="size-4" />
            Open chat view
          </Button>
          <Button role="menuitem" variant="ghost" className="h-10 justify-start gap-2" disabled={busy} onClick={() => choose(() => onOpen("bb"))}>
            <Icon name="PanelBottom" className="size-4" />
            Open in bb terminal
          </Button>
          <Button role="menuitem" variant="ghost" className="h-10 justify-start gap-2 text-muted-foreground" onClick={() => setMenuOpen(false)}>
            <Icon name="X" className="size-4" />
            Cancel
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ClientGroup({
  project,
  client,
  label,
  providerId,
  chats,
  forceOpen,
  expanded,
  toggle,
  busyId,
  onOpen,
  onView,
  onNewChat,
  highlighted,
}: {
  project: Project;
  client: ChatClient;
  label: string;
  providerId: string;
  chats: Chat[];
  forceOpen: boolean;
  expanded: Set<string>;
  toggle: (node: string) => void;
  busyId: string | null;
  onOpen: (chat: Chat, via?: OpenVia) => void;
  onView: (chat: Chat) => void;
  onNewChat: (via: NewChatVia) => void;
  /** `client:id` of the chat being revealed, or null. */
  highlighted: string | null;
}) {
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const busyNew = busyId === newChatBusyKey(project.key, client);
  // bb's provider record carries the official logo (OpenAI for Codex, Claude for Claude Code).
  const provider = experimental_useProviders().providers.find((p) => p.id === providerId) ?? { id: providerId };
  const node = `${project.key}|${client}`;
  // Client groups start open; the stored set records the ones folded shut.
  const open = forceOpen || !expanded.has(`${node}|closed`);
  const [limit, setLimit] = useState(PAGE);
  const roots = useMemo(() => buildForkTree(chats), [chats]);

  // Fork lists and "Side chats" folders start folded; while filtering they open so matches stay visible.
  const renderChat = (item: ChatNode, depth: number): ReactNode => {
    const forksNode = `${node}|forks|${item.chat.id}`;
    const forksOpen = forceOpen || expanded.has(forksNode);
    const sideNode = `${node}|side|${item.chat.id}`;
    const sideOpen = forceOpen || expanded.has(sideNode);
    const children = item.forks.length + (item.sideChats.length > 0 ? 1 : 0);
    return (
      <div key={item.chat.id}>
        <ChatRow
          chat={item.chat}
          depth={depth}
          busy={busyId === item.chat.id}
          onOpen={(via) => onOpen(item.chat, via)}
          onView={() => onView(item.chat)}
          highlighted={highlighted === `${item.chat.client}:${item.chat.id}`}
          {...(children === 0
            ? {}
            : { forks: { count: children, label: childrenLabel(item), open: forksOpen, onToggle: () => toggle(forksNode) } })}
        />
        {forksOpen ? item.forks.map((fork) => renderChat(fork, depth + 1)) : null}
        {forksOpen && item.sideChats.length > 0 ? (
          <>
            <TreeRow
              depth={depth + 1}
              open={sideOpen}
              onToggle={() => toggle(sideNode)}
              icon={<Icon name={sideOpen ? "FolderOpen" : "Folder"} className="size-3.5 shrink-0 text-muted-foreground" />}
              label="Side chats"
              title="Side chats opened from this chat in the Claude app"
              count={item.sideChats.length}
            />
            {sideOpen ? item.sideChats.map((side) => renderChat(side, depth + 2)) : null}
          </>
        ) : null}
      </div>
    );
  };
  return (
    <div>
      <TreeRow
        depth={1}
        open={open}
        onToggle={() => toggle(`${node}|closed`)}
        icon={
          <ProviderIcon
            providerKind="agent"
            provider={provider}
            fallback="Bot"
            className="size-3.5 shrink-0"
          />
        }
        label={label}
        count={chats.length}
        actions={
          project.key === PROJECTLESS_KEY ? (
            // Codex's new-chat link cannot ask for "no project" (it keeps the project
            // selected in Codex), so only Claude starts a chat without a project here.
            client === "claude" ? (
              <NewAppChatButton client={client} clientLabel={label} busy={busyNew} onNew={() => onNewChat("app")} />
            ) : null
          ) : (
            <NewChatButton
              clientLabel={label}
              where={`in ${project.name}`}
              busy={busyNew}
              menuOpen={newMenuOpen}
              onNew={() => onNewChat("view")}
              onMenu={setNewMenuOpen}
            />
          )
        }
      />
      {newMenuOpen ? (
        <NewChatMenu
          clientLabel={label}
          cli={client}
          depth={1}
          busy={busyNew}
          onChoose={(via) => {
            setNewMenuOpen(false);
            onNewChat(via);
          }}
          onClose={() => setNewMenuOpen(false)}
        />
      ) : null}
      {open ? (
        <>
          {roots.slice(0, limit).map((root) => renderChat(root, 1))}
          {roots.length > limit ? (
            <button
              type="button"
              onClick={() => setLimit(limit + PAGE * 2)}
              className="w-full py-1 text-left text-xs text-muted-foreground hover:text-foreground"
              style={{ paddingLeft: `${14 + 22}px` }}
            >
              Show {Math.min(roots.length - limit, PAGE * 2)} more of {roots.length - limit}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** `busyId` while a new chat of `client` in the project starts in a bb terminal. */
const newChatBusyKey = (projectKey: string, client: ChatClient) => `new:${projectKey}|${client}`;

/**
 * The fold-state changes that show `chat` of `project`: its project, its
 * client folder, and every fork list and "Side chats" folder above it.
 */
export function revealNodes(project: Project, client: ChatClient, id: string): { add: string[]; remove: string[] } {
  const node = `${project.key}|${client}`;
  const byId = new Map(project.chats.filter((chat) => chat.client === client).map((chat) => [chat.id, chat]));
  const add = [project.key];
  const seen = new Set<string>();
  for (let chat = byId.get(id); chat?.parentId != null && !seen.has(chat.id); chat = byId.get(chat.parentId)) {
    seen.add(chat.id);
    add.push(`${node}|forks|${chat.parentId}`);
    if (chat.sideChat) add.push(`${node}|side|${chat.parentId}`);
  }
  return { add, remove: [`${node}|closed`] };
}

export function ChatTree({ className }: { className?: string }) {
  const { rpc, data, loading, error, refresh } = useChats();
  const openChatView = useOpenChatView();
  const showOpenedTerminal = useShowOpenedTerminal();
  const { expanded, toggle, update } = useExpanded();
  const openNewChatView = useOpenNewChatView();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<OpenStatus | null>(null);

  // A chat just started from a "New chat" button: once it is listed, open the
  // folders down to it, scroll to it, and highlight it for a moment.
  const reveal = useRevealRequest();
  const revealed = useRef(0);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (reveal === null || data === null || reveal.seq <= revealed.current) return;
    const project = data.projects.find((p) => p.chats.some((chat) => chat.client === reveal.client && chat.id === reveal.id));
    // Not listed yet: the listing's next delta brings it.
    if (project === undefined) return;
    revealed.current = reveal.seq;
    const { add, remove } = revealNodes(project, reveal.client, reveal.id);
    update(add, remove);
    setHighlighted(`${reveal.client}:${reveal.id}`);
  }, [reveal, data, update]);
  useEffect(() => {
    if (highlighted === null) return;
    treeRef.current?.querySelector(`[data-chat-row="${highlighted}"]`)?.scrollIntoView?.({ block: "nearest" });
    const timer = setTimeout(() => setHighlighted(null), 2500);
    return () => clearTimeout(timer);
  }, [highlighted]);

  const normalizedQuery = query.trim().toLowerCase();
  const projects = useMemo(
    () => filterProjects(data?.projects ?? [], normalizedQuery),
    [data, normalizedQuery],
  );
  const chatCount = useMemo(() => projects.reduce((sum, p) => sum + p.chats.length, 0), [projects]);

  // The thread on screen, if any: a bb terminal opened from its page belongs to it.
  const { threadId: contextThreadId } = useBbContext();
  const { values: settings } = useSettings();
  const openChat = (chat: Chat, via?: OpenVia) => {
    // A row click follows the "Open … chats in" setting; the chat view opens here in the app.
    const target = via ?? settings?.[chat.client === "claude" ? "claudeOpener" : "codexOpener"] ?? "view";
    if (target === "view") {
      openChatView(chat.client, chat.id, chat.title);
      return;
    }
    setBusyId(chat.id);
    const threadId = threadOnScreen(contextThreadId);
    rpc
      .call("chat_open", {
        client: chat.client,
        id: chat.id,
        via: target === "app" ? "app" : "bb",
        ...(target !== "app" && threadId !== null ? { threadId } : {}),
      })
      .then(
        async (result) => setStatus(await showOpenedTerminal(result, threadId)),
        (cause: unknown) => setStatus({ text: errorMessage(cause), failed: true }),
      )
      .finally(() => setBusyId(null));
  };

  /**
   * Start a new chat of `client` in `project`'s folder. The scratch group has
   * no folder: its chats start in the desktop app, which makes one.
   */
  const startNewChat = (project: Project, client: ChatClient, via: NewChatVia) => {
    const projectless = project.key === PROJECTLESS_KEY;
    if (projectless && via !== "app") return;
    const cwd = project.path;
    if (via === "view") {
      openNewChatView({ client, cwd, project: project.name });
      return;
    }
    const busyKey = newChatBusyKey(project.key, client);
    setBusyId(busyKey);
    if (via === "app") {
      rpc
        .call("chat_new_app", { client, cwd: projectless ? null : cwd })
        .then(
          (result) => setStatus({ text: result.message, failed: false }),
          (cause: unknown) => setStatus({ text: errorMessage(cause), failed: true }),
        )
        .finally(() => setBusyId((current) => (current === busyKey ? null : current)));
      return;
    }
    const threadId = threadOnScreen(contextThreadId);
    rpc
      .call("chat_new_terminal", { client, cwd, ...(threadId === null ? {} : { threadId }) })
      .then(
        async (result) => setStatus(await showOpenedTerminal(result, threadId)),
        (cause: unknown) => setStatus({ text: errorMessage(cause), failed: true }),
      )
      .finally(() => setBusyId((current) => (current === busyKey ? null : current)));
  };

  return (
    <TooltipProvider
      delayDuration={300}
      // Tooltips hold no controls: closing one as the pointer leaves lets the next button's open at once.
      disableHoverableContent
    >
      <div className={cn("flex min-h-0 flex-col gap-2", className)}>
        <div className="flex items-center gap-1.5">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter projects and chats"
            aria-label="Filter projects and chats"
            className="h-8"
          />
          <IconAction
            icon="ArrowReloadHorizontal"
            label="Rescan chats"
            disabled={loading}
            className="size-8 shrink-0"
            iconClassName={cn("size-4", loading && "animate-spin")}
            onClick={refresh}
          />
        </div>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        ) : null}
        {status !== null ? (
          <p role="status" className={cn("text-xs", status.failed ? "text-destructive" : "text-muted-foreground")}>
            {status.text}
            {status.action === undefined ? null : (
              <>
                {" "}
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => {
                    status.action?.run();
                    setStatus(null);
                  }}
                >
                  {status.action.label}
                </button>
              </>
            )}
          </p>
        ) : null}
        {data?.warnings.map((warning) => (
          <p key={warning} className="text-xs text-muted-foreground">{warning}</p>
        ))}
        <div ref={treeRef} className="min-h-0 flex-1 overflow-y-auto">
          {data === null ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">{loading ? "Scanning chats…" : null}</p>
          ) : projects.length === 0 ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">
              {normalizedQuery === "" ? "No Claude Code or Codex chats found." : "Nothing matches."}
            </p>
          ) : (
            projects.map((project) => {
              const open = normalizedQuery !== "" || expanded.has(project.key);
              return (
                <div key={project.key}>
                  <TreeRow
                    depth={0}
                    open={open}
                    onToggle={() => toggle(project.key)}
                    icon={<Icon name={open ? "FolderOpen" : "Folder"} className="size-4 shrink-0 text-muted-foreground" />}
                    label={project.name}
                    title={project.path}
                    count={project.chats.length}
                  />
                  {open
                    ? clientGroupsByActivity(project.chats).map(({ client, label, providerId, chats }) => {
                        return (
                          <ClientGroup
                            key={client}
                            project={project}
                            client={client}
                            label={label}
                            providerId={providerId}
                            chats={chats}
                            forceOpen={normalizedQuery !== ""}
                            expanded={expanded}
                            toggle={toggle}
                            busyId={busyId}
                            onOpen={openChat}
                            onView={(chat) => openChatView(chat.client, chat.id, chat.title)}
                            onNewChat={(via) => startNewChat(project, client, via)}
                            highlighted={highlighted}
                          />
                        );
                      })
                    : null}
                </div>
              );
            })
          )}
        </div>
        {data !== null ? (
          <p className="text-xs text-muted-foreground">
            {chatCount} chats in {projects.length} projects
          </p>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
