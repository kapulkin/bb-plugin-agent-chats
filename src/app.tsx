// App entry: the Agent chats page (the chat list, or one chat's chat view),
// the chat list in the sidebar, and the chat view as a side-panel tab.
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { CHAT_SUBPATH, CHAT_TAB_ID, CHAT_TABS, chatSubPath, PANEL_PATH, useOpenChatView } from "./app/routes";
import { ChatTree } from "./app/chat-tree";
import { ChatView } from "./app/chat-view";
import { clientSchema, type ChatClient } from "./shared/contract";
import { useTerminalFromSubPath, useTerminalPage, useThreadTerminalOpener } from "./app/terminal-opening";
import { useChatTitle } from "./app/use-chats";

/** Manifest-declared glyph (bb.branding.experimental_icons). */
const PLUGIN_ICON = "agent-chats/agent-chats";
const chatTabParamsSchema = z.object({ client: clientSchema, id: z.string(), title: z.string().optional() });

function AgentChatsPage({ subPath }: PluginNavPanelProps) {
  const terminalFailed = useTerminalFromSubPath(subPath);
  const navigate = useBbNavigate();
  useTerminalPage();
  const viewed = CHAT_SUBPATH.exec(subPath);
  const viewedClient = (viewed?.[1]?.toLowerCase() ?? "claude") as ChatClient;
  const viewedId = viewed?.[2]?.toLowerCase() ?? null;
  const title = useChatTitle(viewedClient, viewedId);
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
