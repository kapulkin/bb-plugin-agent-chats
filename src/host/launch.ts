// Opening a chat outside bb: its client's desktop app through the app's URL
// scheme, and the folder check before a bb terminal resumes it there.
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { ChatClient } from "../shared/contract";
import { isWindows, type ScannedChat } from "./scanned-chat";

function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // On Windows a detached console child gets its own console window.
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function openUrl(url: string): Promise<void> {
  if (isWindows) return launchDetached("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  return launchDetached(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

/** Open the chat in its client's desktop app; returns the status line. */
export async function openInApp(chat: ScannedChat): Promise<string> {
  const url = chat.client === "claude" ? `claude://resume?session=${chat.id}` : `codex://threads/${chat.id}`;
  await openUrl(url);
  return `Opened in the ${chat.client === "claude" ? "Claude" : "Codex"} app`;
}

/**
 * The desktop app's link to a new chat in `folder`, or without a project when
 * null; the apps make the folder and brief the model themselves then. The
 * links only open the app's new-chat screen: the user sends from there.
 * Claude: `claude://code/new[?folder=…]`; Codex: `codex://threads/new[?path=…]`
 * (read from the apps' URL handlers, Claude 5.1231 and Codex 26.1106).
 */
export function newChatAppUrl(client: ChatClient, folder: string | null): string {
  if (client === "claude") return folder === null ? "claude://code/new" : `claude://code/new?folder=${encodeURIComponent(folder)}`;
  return folder === null ? "codex://threads/new" : `codex://threads/new?path=${encodeURIComponent(folder)}`;
}

/** Open the desktop app's new-chat screen; returns the status line. */
export async function openNewChatInApp(client: ChatClient, folder: string | null): Promise<string> {
  await openUrl(newChatAppUrl(client, folder));
  return `Opened a new chat in the ${client === "claude" ? "Claude" : "Codex"} app; send your first message there`;
}

export async function requireFolder(cwd: string): Promise<void> {
  try {
    if ((await stat(cwd)).isDirectory()) return;
  } catch {
    // Reported below.
  }
  throw new Error(`The chat's folder no longer exists: ${cwd}`);
}
