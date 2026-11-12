// App entry: the Agent chats page (the chat list, or one chat's chat view),
// the chat list in the sidebar, and the chat view as a side-panel tab.
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp, experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import {
  CHAT_SUBPATH,
  CHAT_TAB_ID,
  CHAT_TABS,
  chatSubPath,
  NEW_CHAT_SUBPATH,
  PANEL_PATH,
  useOpenChatView,
} from "./app/routes";
import { ChatTree } from "./app/chat-tree";
import { ChatView, NewChatView } from "./app/chat-view";
import { clientSchema, type ChatClient } from "./shared/contract";
import { useTerminalFromSubPath, useTerminalPage, useThreadTerminalOpener } from "./app/terminal-opening";
import { requestReveal, useChatTitle } from "./app/use-chats";

/** Manifest-declared glyph (bb.branding.experimental_icons). */
const PLUGIN_ICON = "agent-chats/agent-chats";
const chatTabParamsSchema = z.object({ client: clientSchema, id: z.string(), title: z.string().optional() });
const newChatTabParamsSchema = z.object({ client: clientSchema, new: z.literal(true), cwd: z.string(), project: z.string() });

/** A folder's name, for a new chat's header. */
const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;

function AgentChatsPage({ subPath }: PluginNavPanelProps) {
  const terminalFailed = useTerminalFromSubPath(subPath);
  const navigate = useBbNavigate();
  useTerminalPage();
  // Hooks run on every sub-path: a new chat's view turns into the chat's view in place.
  const viewed = CHAT_SUBPATH.exec(subPath);
  const viewedClient = (viewed?.[1]?.toLowerCase() ?? "claude") as ChatClient;
  const viewedId = viewed?.[2]?.toLowerCase() ?? null;
  const title = useChatTitle(viewedClient, viewedId);
  const started = NEW_CHAT_SUBPATH.exec(subPath);
  if (started !== null) {
    const client = started[1]!.toLowerCase() as ChatClient;
    const cwd = decodeURIComponent(started[2]!);
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="mx-auto box-border flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pb-4 pt-3 md:px-5 md:pt-4">
          <NewChatView
            key={subPath}
            client={client}
            cwd={cwd}
            project={folderName(cwd)}
            onBack={() => navigate.toPluginPanel(PANEL_PATH)}
            onStarted={(nextClient, id) => {
              requestReveal(nextClient, id);
              navigate.toPluginPanel(PANEL_PATH, { subPath: chatSubPath(nextClient, id), replace: true });
            }}
          />
        </div>
      </div>
    );
  }
  if (viewedId !== null) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="mx-auto box-border flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pb-4 pt-3 md:px-5 md:pt-4">
          <ChatView
            key={`${viewedClient}:${viewedId}`}
            client={viewedClient}
            id={viewedId}
            title={title ?? viewedId}
            onBack={() => navigate.toPluginPanel(PANEL_PATH)}
            onOpenChat={(client, id) => navigate.toPluginPanel(PANEL_PATH, { subPath: chatSubPath(client, id) })}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="mx-auto box-border flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {terminalFailed ? (
          <p role="alert" className="mb-2 text-sm text-destructive">
            The bb terminal started but bb did not show it; open it from the Terminal tab of this page's panel.
          </p>
        ) : null}
        <ChatTree className="flex-1" />
      </div>
    </div>
  );
}

function SidebarChats() {
  // The host wraps disclosures in `max-h-80 overflow-auto`; filling exactly
  // that height keeps the host from scrolling, so only the chat list scrolls.
  return (
    <div className="box-border flex h-80 flex-col overflow-hidden p-2">
      <ChatTree className="flex-1" />
    </div>
  );
}

/** A side-panel tab: the chat named by its params, or the chat list without them. */
function ChatTab({ params }: { params: unknown }) {
  const started = newChatTabParamsSchema.safeParse(params);
  return started.success ? <NewChatTab {...started.data} /> : <OpenChatTab params={params} />;
}

/** A side-panel tab with a new chat's view; once the chat starts, its own tab replaces this one. */
function NewChatTab({ client, cwd, project }: z.infer<typeof newChatTabParamsSchema>) {
  const openChatView = useOpenChatView();
  const panel = experimental_useAppPanel();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
      <NewChatView
        client={client}
        cwd={cwd}
        project={project}
        onStarted={(nextClient, id) => {
          // This tab is the one whose params name this folder: the user may have
          // selected another tab while the chat started.
          const self = panel.getTabs().tabs.find((tab) => {
            if (tab.detail.kind !== "plugin" || tab.detail.pluginId !== "agent-chats" || tab.detail.tab.id !== CHAT_TAB_ID) return false;
            const params = newChatTabParamsSchema.safeParse(tab.detail.params);
            return params.success && params.data.client === client && params.data.cwd === cwd;
          });
          requestReveal(nextClient, id);
          openChatView(nextClient, id);
          // Closed only once the chat's own tab took over, so the panel never loses the conversation.
          if (self !== undefined && panel.getTabs().selectedKey !== self.key) panel.closeTab(self.key);
        }}
      />
    </div>
  );
}

function OpenChatTab({ params }: { params: unknown }) {
  const parsed = chatTabParamsSchema.safeParse(params);
  const openChatView = useOpenChatView();
  // Tabs opened from the list carry the title; one opened after an edit or a fork does not.
  const fetchedTitle = useChatTitle(parsed.success ? parsed.data.client : "claude", parsed.success && parsed.data.title === undefined ? parsed.data.id : null);
  if (!parsed.success) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
        <ChatTree className="flex-1" />
      </div>
    );
  }
  const { client, id, title } = parsed.data;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
      <ChatView
        key={`${client}:${id}`}
        client={client}
        id={id}
        title={title ?? fetchedTitle ?? id}
        onOpenChat={(nextClient, nextId) => openChatView(nextClient, nextId)}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  // Never shown: its visibility hook gives each open thread page a terminal opener.
  app.slots.experimental_threadContextSegment({
    id: "terminal-opener",
    title: "Agent chats terminal opener",
    group: "9_agentChats",
    summary: () => null,
    useVisible: useThreadTerminalOpener,
  });
  for (const tab of CHAT_TABS) {
    app.slots.experimental_tab({
      ...tab,
      title: "Agent chat",
      icon: PLUGIN_ICON,
      tooltip: "A Claude Code or Codex chat",
      layout: "flush",
      component: ChatTab,
    });
  }
  // The New thread screen resolves the thread-context tab through this action.
  app.slots.experimental_newThreadPanelAction({
    id: CHAT_TAB_ID,
    title: "Agent chat",
    icon: PLUGIN_ICON,
    layout: "flush",
    component: ChatTab,
  });
  app.slots.navPanel({
    id: "agent-chats",
    title: "Agent chats",
    icon: PLUGIN_ICON,
    path: PANEL_PATH,
    component: AgentChatsPage,
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "agent-chats",
    label: "Claude Code & Codex chats",
    icon: PLUGIN_ICON,
    component: SidebarChats,
  });
});
