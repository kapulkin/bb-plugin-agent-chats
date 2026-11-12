// Showing a bb terminal that resumes a chat. bb opens a terminal only from
// inside a page, and a thread page only its own thread's terminals, so the
// chat list (often in the sidebar, outside any page) hands each terminal to a
// page that can show it: the thread page on screen, or the Agent chats page.
import { useEffect, useState } from "react";
import { experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { PANEL_PATH } from "./routes";

/** Agent chats page sub-path that asks the page to show one bb terminal. */
const TERMINAL_SUBPATH = /^terminal\/(term_[A-Za-z0-9]+)$/;
/** How long to look for a new terminal's tab in the page's side panel: 25 x 200 ms. */
const TERMINAL_TAB_ATTEMPTS = 25;
const TERMINAL_TAB_WAIT_MS = 200;

/**
 * Pages of this plugin that can show a terminal in their own side panel. bb
 * accepts a terminal only from inside a page, so the sidebar list asks the
 * mounted Agent chats page to open it instead of navigating there.
 */
const terminalPages = new Set<(terminalId: string) => Promise<boolean>>();

/**
 * Thread pages on screen, by thread id, each able to show its own thread's
 * terminals the way bb's terminal opener does: select the tab, add it when
 * needed, and reveal the panel. Registered from inside the thread page (see
 * `useThreadTerminalOpener`), because bb accepts a thread's terminal only from
 * its own page.
 */
const threadPages = new Map<string, (terminalId: string) => Promise<boolean>>();

/**
 * Registers the thread page's terminal opener. Runs as the `useVisible` hook of
 * a context segment, which bb calls inside each open thread page; it returns
 * false so the segment never shows.
 */
export function useThreadTerminalOpener({ threadId }: { threadId: string }): boolean {
  const navigate = useBbNavigate();
  useEffect(() => {
    const show = (terminalId: string) => navigate.experimental_openTerminal({ terminalId });
    threadPages.set(threadId, show);
    return () => {
      if (threadPages.get(threadId) === show) threadPages.delete(threadId);
    };
  }, [threadId, navigate]);
  return false;
}

/** Lets the Agent chats page show terminals the sidebar list starts while it is on screen. */
export function useTerminalPage(): void {
  const navigate = useBbNavigate();
  useEffect(() => {
    const show = (terminalId: string) => navigate.experimental_openTerminal({ terminalId });
    terminalPages.add(show);
    return () => {
      terminalPages.delete(show);
    };
  }, [navigate]);
}

async function showOnPluginPage(terminalId: string): Promise<boolean> {
  for (const show of terminalPages) if (await show(terminalId)) return true;
  return false;
}

/**
 * The thread on screen. bb's context has no thread on
 * `/projects/proj_personal/threads/<id>` pages, so the page address is read
 * too; both thread routes end in `/threads/<id>`.
 */
export function threadOnScreen(fromContext: string | null): string | null {
  if (fromContext !== null) return fromContext;
  for (const where of [window.location.pathname, window.location.hash]) {
    const match = /\/threads\/([A-Za-z0-9_-]+)/.exec(where);
    if (match) return match[1]!;
  }
  return null;
}

/** The chat list's status line. */
export interface OpenStatus {
  text: string;
  failed: boolean;
  action?: { label: string; run: () => void };
}

/**
 * Shows the bb terminal a `chat_open` call started and resolves to the status
 * line. A terminal outside any thread opens in the side panel of the page on
 * screen, else on a mounted Agent chats page; where neither can show it (for
 * example the New thread screen) the main area stays and the status line
 * offers the Agent chats page. A terminal of the thread on screen opens on
 * that thread's page.
 */
export function useShowOpenedTerminal() {
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();

  // A thread's own terminal gets a tab in its thread's side panel. bb's terminal
  // opener works only from inside a page (the sidebar list is outside it), so
  // also look for that tab and select it through the panel controller. The
  // terminal never leaves its thread page: when its tab cannot be selected from
  // here, the returned note says where it is.
  const showThreadTerminal = async (terminalId: string): Promise<string | null> => {
    if (await navigate.experimental_openTerminal({ terminalId })) return null;
    for (let attempt = 0; attempt < TERMINAL_TAB_ATTEMPTS; attempt += 1) {
      const tab = panel.getTabs().tabs.find((t) => t.detail.kind === "terminal" && t.detail.terminalId === terminalId);
      if (tab !== undefined && panel.selectTab(tab.key)) return null;
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_TAB_WAIT_MS));
    }
    return "The terminal is a tab in this thread's side panel.";
  };

  return async (
    result: { message: string; terminalId: string | null; inThread: boolean },
    threadId: string | null,
  ): Promise<OpenStatus> => {
    if (result.terminalId === null) return { text: result.message, failed: false };
    const terminalId = result.terminalId;
    if (!result.inThread) {
      const shown = (await navigate.experimental_openTerminal({ terminalId })) || (await showOnPluginPage(terminalId));
      if (shown) return { text: result.message, failed: false };
      return {
        text: `${result.message}. This page cannot show it.`,
        failed: false,
        action: {
          label: "Show on Agent chats page",
          run: () => navigate.toPluginPanel(PANEL_PATH, { subPath: `terminal/${terminalId}` }),
        },
      };
    }
    // The thread page opens its own terminal like bb does, which focuses its tab.
    const threadPage = threadId === null ? undefined : threadPages.get(threadId);
    if (threadPage !== undefined && (await threadPage(terminalId))) return { text: result.message, failed: false };
    const note = await showThreadTerminal(terminalId);
    return { text: note === null ? result.message : `${result.message}. ${note}`, failed: false };
  };
}

/**
 * Shows the bb terminal named by a `terminal/<id>` sub-path in this page's
 * right-side panel, then returns the page to its root route.
 */
export function useTerminalFromSubPath(subPath: string) {
  const navigate = useBbNavigate();
  const [failed, setFailed] = useState(false);
  const terminalId = TERMINAL_SUBPATH.exec(subPath)?.[1] ?? null;
  useEffect(() => {
    if (terminalId === null) return;
    let cancelled = false;
    void (async () => {
      // The page's panel can mount a moment after the route changes.
      for (let attempt = 0; attempt < 10 && !cancelled; attempt += 1) {
        if (await navigate.experimental_openTerminal({ terminalId })) break;
        if (attempt === 9) setFailed(true);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!cancelled) navigate.toPluginPanel(PANEL_PATH, { replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [terminalId, navigate]);
  return failed;
}
