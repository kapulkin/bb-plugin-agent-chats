// Where the app shows things: the Agent chats page and its sub-paths, and the
// chat view as a side-panel tab.
import { useCallback } from "react";
import { experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ChatClient } from "../shared/contract";

/** The Agent chats page. */
export const PANEL_PATH = "chats";
/** Agent chats page sub-path of one chat's chat view. */
export const CHAT_SUBPATH = /^chat\/(claude|codex)\/([0-9a-f-]{36})$/i;
export const chatSubPath = (client: ChatClient, id: string) => `chat/${client}/${id}`;

export const CHAT_TAB_ID = "chat";
/**
 * The chat view as a side-panel tab. bb accepts a thread-context tab on thread
 * pages and, through the matching New thread action, on the New thread screen;
 * the nav-panel tab serves the Agent chats page itself.
 */
export const CHAT_TABS = [
  { id: CHAT_TAB_ID, context: { kind: "thread" }, availability: "action" },
  { id: CHAT_TAB_ID, context: { kind: "nav-panel", panelId: "agent-chats" }, availability: "action" },
] as const;

/**
 * Open a chat's view in the side panel of the page on screen; only where bb
 * offers no side panel for it, switch to the Agent chats page instead.
 */
export function useOpenChatView() {
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  return useCallback(
    (client: ChatClient, id: string, title?: string) => {
      const params = { client, id, ...(title === undefined ? {} : { title }) };
      for (const tab of CHAT_TABS) {
        if (panel.openTab({ tab, params, title: title ?? "Agent chat" })) return;
      }
      navigate.toPluginPanel(PANEL_PATH, { subPath: chatSubPath(client, id) });
    },
    [panel, navigate],
  );
}
