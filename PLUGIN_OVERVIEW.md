Every Claude Code and Codex conversation on your machine, in one tree next to
your bb threads.

## What you get

- An **Agent chats** page and a sidebar panel: project folder → Claude Code /
  Codex → chats, forks nested under their origin, kept current as you work.
- A click opens the chat in the side panel of the page you are on. Send
  messages, allow or deny tool use, edit any earlier message in place, or fork
  from it. File links open in bb's file preview.
- Editing a Claude Code message restores the files Claude changed after it.
  Editing a Codex message rewrites only the history.
- Hover actions also open a chat in a bb terminal (`claude --resume` or
  `codex resume` in its folder) or in the Claude or Codex desktop app.

## How it works

The list comes from Claude Code's session files and Codex's local thread
index on bb's primary host. The chat view drives your installed tools: Claude
Code through the Claude Agent SDK, with your user and project settings, and
Codex through `codex app-server`.

## Requirements

- Claude Code and/or the Codex CLI, installed and signed in. `claude` on PATH
  or in `~/.local/bin`; `codex` on PATH, with `codex app-server` and its
  experimental API.
- Messages count against your Anthropic or OpenAI account and its limits.
- The desktop apps are optional.
- Tested on Windows only; macOS and Linux are untested.

## Privacy

The plugin reads chat metadata (folders, titles, first prompts) and, in the
chat view, full conversations from the local stores. Sending, editing, and
forking run your own `claude` and `codex`, which talk to Anthropic and OpenAI
as they always do. Editing a Claude Code message restores files on disk. The
plugin writes only a small fork-origin cache in its data folder and sends
nothing anywhere else.
