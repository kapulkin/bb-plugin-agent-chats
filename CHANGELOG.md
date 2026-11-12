# Changelog

## 0.1.0 (unreleased)

First release.

### Features

- Lists Claude Code and Codex chats from the machine running bb, grouped by project folder and client, with a filter over projects and chats; each client group shows its newest 15 chats and loads more on request.
- Nests forked chats under the chat they were forked from, up to two fork levels.
- Groups chats that the Codex and Claude apps started without a project under one "Chats without a project" folder.
- Lists each Claude app chat once, under the title the app shows (renames included), in the app's project and fork tree (detached chats at the top level), instead of one row per session the app ran it on.
- Shows Claude app side chats in a foldable "Side chats" folder under the chat they were opened from.
- Keeps the list current while bb runs: the chat stores are watched and only changed rows are sent to open lists.
- Shows the list on its own Agent chats page and in a sidebar-footer panel, with the clients' official logos.
- Opens a chat in a chat view by default, as a tab in the side panel of the current page, or on the Agent chats page where no side panel is available.
- The chat view sends messages, edits any message in place, forks at a message, answers approvals and questions, shows tool calls as readable rows, and opens local file links in bb's file preview. Editing a Claude Code message first undoes the file changes made after it; Codex edits change the conversation only.
- Opens a chat in a bb terminal tab with `claude --resume` or `codex resume`; on a thread page the terminal belongs to that thread.
- Opens a chat in the Claude or Codex desktop app.
- Long press on touch screens, or right-click, shows a chat's actions.
- Settings: `claudeOpener` and `codexOpener` (`view`, `bb`, `app`; default `view`), and `includeBbChats` (default off).

### Development history

- Removed the VS Code targets for both clients.
- Removed the external terminal window target; the bb terminal tab covers it.
- Changed the default opener to the chat view.
- Attached the bb terminal to the thread on screen, so it opens in that thread's side panel.
- Read compressed Codex rollouts (`.jsonl.zst`) when resolving fork origins.
- Sent listing updates as incremental, versioned deltas instead of full listings.
- Opened the chat view in the side panel of the current page.
- Opened local file links from chat messages in bb's file preview.
- Added long-press and right-click actions on chat rows.
