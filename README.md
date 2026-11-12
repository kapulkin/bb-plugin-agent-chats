# Agent Chats (bb-plugin-agent-chats)

A bb plugin that lists the Claude Code and Codex chats on the machine running
bb, grouped by project folder, and opens any of them in a chat view inside bb
(send, edit in place, fork, approve tool use), in a bb terminal tab, or in the
client's desktop app.

## Install

```sh
bb plugin install git:<repository-url>
```

The plugin is distributed only as a Git repository, never as a prebuilt npm
package. bb installs its npm dependencies and builds it on your machine at
install time. A local checkout installs with `bb plugin install <path>`.

## Surfaces

- **Agent chats** nav page (`/plugins/agent-chats/chats`): the chat list, or
  one chat's chat view where bb offers no side panel for it.
- **Claude Code & Codex chats**: a sidebar-footer disclosure with the same list.
- **Agent chat**: a side-panel tab holding one chat's chat view, available on
  thread pages, the New thread screen, and the Agent chats page.

The list is a foldable tree: project folder → Claude Code / Codex → chats,
newest first, the first 15 per group with "Show more" for the rest. Forks are nested under the chat
they came from, at most two levels deep (deeper forks are lifted to the second
level). Chats the Claude and Codex desktop apps started without a project
share one "Chats without a project" folder. A Claude app chat appears once,
under the title the app shows, even when the app ran it on several Claude Code
sessions (read from the app's records, verified on Windows). A filter matches project names, paths, and chat titles; a rescan
button rereads both stores. The list updates live while either store changes.

## Opening a chat

A row click opens the target chosen in Settings (default: chat view). Hover
actions offer all three targets; a long press (touch) or right-click offers the
chat view and the bb terminal.

| Client      | `view` (default)                   | `bb`                                    | `app`                          |
|-------------|------------------------------------|-----------------------------------------|--------------------------------|
| Claude Code | chat view in the page's side panel | `claude --resume <id>` in a bb terminal | `claude://resume?session=<id>` |
| Codex       | chat view in the page's side panel | `codex resume <id>` in a bb terminal    | `codex://threads/<id>`         |

- **Chat view.** Opens in the side panel of the page on screen; where bb has no
  side panel for it, on the Agent chats page. It shows the conversation with
  bb's components (markdown, diffs, tool rows), and lets you send, stop, answer
  approvals and questions, edit any of your messages in place, and fork from
  any message. Local file links in messages (`src/a.ts`, `./a.ts#L12`,
  `file:///…`, `C:\a.ts:12`) open in bb's file preview, resolved against the
  chat's folder.
  - **Claude Code edit:** before the edit, the view lists the files that will
    be restored to their state before the edited message (files changed by
    Claude's file tools; shell-command changes are not undone). Editing the
    first message starts a new chat, because Claude Code cannot rewrite it in
    place.
  - **Codex edit:** reverts the thread's history from that turn; Codex does not
    undo file changes.
  - Edit and fork are refused while a turn runs; wait for it or stop it.
- **bb terminal.** Runs the resume command in the chat's folder. On a thread
  page the terminal belongs to that thread (unless the thread runs on another
  machine) and opens in its side panel; elsewhere it is a host terminal shown
  in the page's side panel or on the Agent chats page.
- **Desktop app.** Opens the deep link above through the OS URL handler.

## Starting a new chat

Each Claude Code and Codex folder of a project has a "New chat" button. It
opens an empty chat view; your first message starts the chat in the project's
folder, and the list then opens the folders down to the new chat and
highlights it. The button's arrow, a right-click, or a long press offers the
other targets instead: `claude` / `codex` in a bb terminal tab in that folder,
or the client's desktop app on its new-chat screen
(`claude://code/new?folder=…`, `codex://threads/new?path=…`), where you send
the first message. New chats start only in folders the list already shows.

In "Chats without a project", the button opens the desktop app's new-chat
screen without a folder, so the app makes the chat's folder as it does for
its own chats. It is hidden on phones.

## Settings

- `claudeOpener` — `view` | `bb` | `app` (default `view`): what a click on a
  Claude Code chat opens.
- `codexOpener` — `view` | `bb` | `app` (default `view`): the same for Codex.
- `includeBbChats` — also list chats bb itself started (default off): Codex
  threads whose originator is bb, and chats whose folder is inside bb's data
  folder.

## Requirements

- bb with the Plugin SDK the plugin was built against (see `engines` in
  `package.json`). The host entry runs in bb's own Node runtime, not the
  system Node.
- The Codex list reads `state_<n>.sqlite` through `node:sqlite` (Node 22.5 or
  later); fork origins of compressed Codex rollouts (`.zst`) need zstd support
  in `node:zlib` (Node 22.15+ / 23.8+). Without `node:sqlite` the Codex list
  shows a warning instead; without zstd those chats are listed without their
  fork origin.
- Claude Code: the `claude` CLI installed and signed in. The plugin looks for
  `claude` (`claude.exe` on Windows) on PATH, then in `~/.local/bin` and
  `~/.claude/local`; npm's `.cmd`/`.ps1` shims are not used.
- Codex: the `codex` CLI on PATH, signed in, with `codex app-server`. The chat
  view opts in to the app-server's experimental API (`thread/revert`,
  `thread/fork`, and others); a Codex version without them cannot drive the
  chat view.
- Desktop apps: only for the `app` target.
- Messages sent from the chat view run under your Claude Code or Codex account
  and count against its plan and limits.
- Tested on Windows only. macOS and Linux code paths exist but are untested.

## Privacy

- Listing reads metadata only: for Claude Code, the first and last 256 KB of
  each `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<uuid>.jsonl` (folder,
  title, first prompt, fork origin), reading on past the first 256 KB only
  while the folder or first prompt is still missing; on Windows, the Claude
  app's chat records under `%LOCALAPPDATA%/Claude-Data` (title, folder, fork
  origin, current session); for Codex, the `threads` table of
  `<CODEX_HOME or ~/.codex>/state_<n>.sqlite`, opened read-only (archived and
  subagent threads are skipped), and the first line of each rollout file for
  its fork origin.
- The chat view reads the open chat's full conversation: Claude Code through
  the Claude Agent SDK, Codex through `codex app-server`.
- Sending, editing, and forking run your own `claude` (through the Claude Agent
  SDK) and `codex app-server`. They talk to Anthropic and OpenAI as those
  tools always do and write the results to their own stores.
- Editing a Claude Code message restores files on disk (see above).
- The plugin writes `fork-origins.json` in its plugin data folder. It sends
  nothing anywhere else.

## Project settings in the Claude Code chat view

The chat view starts Claude Code through the Claude Agent SDK with
`settingSources: ["user", "project", "local"]` and the chat's folder as `cwd`.
So the same files apply as in a terminal session there: `~/.claude/settings.json`,
the project's `.claude/settings.json` and `.claude/settings.local.json`,
including their permission rules and hooks. A tool call those rules do not
settle is asked in the chat view (Allow / Deny). File checkpointing is enabled
so that edits can restore files.

Codex approvals in the chat view offer Allow, Allow for this chat, and Deny;
Codex questions with options are asked there too. MCP elicitation requests are
declined.

## Architecture

Three entries: the app (`src/app.tsx`) in bb's UI, the server (`src/server.ts`) in the
bb daemon, and the host entry (`src/host.ts`) on bb's primary host, which holds
both chat stores. The server forwards the app's calls to the host and relays
its signals over realtime channels.

Entries (`src/`):

- `src/app.tsx` — app entry: nav page, sidebar-footer list, Agent chat tab, thread-page terminal opener.
- `src/server.ts` — server entry: settings, listing refresh and deltas, store watch service, bb terminals, new chats.
- `src/host.ts` — host entry: scan, watch, locate, open in app, new chats, chat drivers per open chat.

`src/shared/` — used by more than one entry:

- `contract.ts` — RPC contracts (app ↔ server, server ↔ host), host signals, chat view types.
- `listing.ts` — listing versions and deltas shared by the server and the app.
- `text.ts` — text helpers.

`src/host/` — the chat list, read on the primary host:

- `chat-index.ts` — chat index: scan and watch the stores, project grouping, fork tree, fork cache.
- `claude-store.ts` — Claude Code session files: metadata and fork origin.
- `claude-desktop.ts` — Claude app chat records: one row per app chat, with the app's title.
- `codex-store.ts` — Codex thread index (`node:sqlite`) and rollout fork origins.
- `scanned-chat.ts` — scanned-chat record and path helpers.
- `launch.ts` — desktop app deep links (open a chat, new chat) and the folder check.

`src/chat/` — chat view drivers, run by the host entry:

- `hub.ts` — per-chat view state: status, pending requests, numbered events.
- `claude.ts` — Claude Code driver (Claude Agent SDK): history, send, stop, edit with file restore, fork, approvals.
- `codex.ts` — Codex driver (`codex app-server` JSON-RPC): history, send, stop, edit by revert, fork, approvals.
- `tools.ts` — tool-call presentation: icon, summary, links, output.

`src/app/` — the UI:

- `chat-tree.tsx` — the chat list: filter, project / client / fork tree, row actions, New chat buttons, status line.
- `chat-view.tsx` — the chat view and a new chat's view: conversation, composer, edit / fork, approvals, file links.
- `use-chats.ts` — app hooks: live listing (deltas over realtime), fold state, chat title, revealing a new chat.
- `routes.ts` — Agent chats page path and sub-paths; opens a chat view or a new chat's view in the side panel.
- `terminal-opening.ts` — shows a started bb terminal on the thread page or the Agent chats page.
- `file-links.ts` — resolves local file links in messages against the chat's folder.
- `icon-action.tsx` — icon button with a two-line tooltip.

Other:

- `src/components/ui/`, `src/lib/` — local UI primitives (button, input, tooltip, context menu, icon) and helpers, imported as `@/…`.
- `icons/agent-chats.svg` — plugin icon.
- `*.test.ts`, `*.test.tsx` — Vitest tests, next to the code they test.

## Development

```sh
npm install
npm run typecheck     # tsc -p .
npx vitest run        # or: npm test
bb plugin install .   # once
bb plugin dev         # rebuild and reload on save
bb plugin build       # dist/app.js, dist/server.js, dist/host.js
```

## Third-party notice

The chat view uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
This repository does not contain it: it is a declared dependency that npm
fetches when bb installs the plugin, and `bb plugin build` bundles it into
`dist/host.js` on your machine (`dist/` is not committed). The SDK is not open
source. Its license reads:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
> outlined here: https://code.claude.com/docs/en/legal-and-compliance.

Its optional platform package (for example
`@anthropic-ai/claude-agent-sdk-win32-x64`, a native `claude` binary) is under
the same terms. bb's git installs omit optional dependencies, and the plugin
looks for the `claude` CLI you installed first.

## License

MIT; see [LICENSE](LICENSE). The license covers this repository's code only,
not the Claude Agent SDK or other dependencies, which keep their own terms.
