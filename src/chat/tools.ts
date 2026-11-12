// How a tool call reads in the chat view: an icon, a one-line summary, the
// links it touched, and its output as text. bb's plugin kit has no tool-call
// component, so the view builds rows from these with bb's building blocks.
import { clip } from "./hub";
import { oneLine } from "../shared/text";

type Json = Record<string, unknown>;

interface ToolLink {
  title: string;
  url: string;
}

export interface ToolPresentation {
  icon: string;
  summary: string;
  links: ToolLink[];
}

const SUMMARY_MAX = 160;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const brief = (value: string): string => oneLine(value, SUMMARY_MAX);
const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);
const fileName = (value: string): string => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;

/**
 * The command a shell wrapper runs: Codex records PowerShell calls as
 * `"…pwsh.exe" -Command '<script>'`, and bash calls as `bash -lc '<script>'`.
 */
export function innerCommand(command: string): string {
  const wrapped = /^\s*(?:"[^"]*(?:pwsh|powershell)(?:\.exe)?"|\S*(?:pwsh|powershell)(?:\.exe)?)\s+(?:-NoProfile\s+)?-Command\s+'([\s\S]*)'\s*$/i.exec(command)
    ?? /^\s*\S*(?:bash|sh|zsh)\s+-l?c\s+'([\s\S]*)'\s*$/.exec(command);
  return wrapped ? wrapped[1]!.replaceAll("''", "'") : command;
}

/** The text an MCP or tool result carries, rather than its JSON envelope. */
export function resultText(result: unknown): string | null {
  if (result === null || result === undefined) return null;
  if (typeof result === "string") return result;
  const content = Array.isArray(result) ? result : (result as Json).content;
  if (Array.isArray(content)) {
    const texts = content.flatMap((part) => (part && typeof part === "object" && typeof (part as Json).text === "string" ? [(part as Json).text as string] : []));
    if (texts.length > 0) return texts.join("\n\n");
  }
  const error = (result as Json).message;
  if (typeof error === "string") return error;
  return JSON.stringify(result, null, 2);
}

/** Codex `webSearch` item: a search, an opened page, or a find in a page. */
export function presentCodexWebSearch(item: Json): ToolPresentation {
  const action = (item.action ?? {}) as Json;
  const query = str(item.query);
  const url = str(action.url) || (isUrl(query) ? query : "");
  const results = Array.isArray(item.results) ? (item.results as Json[]) : [];
  const links = results
    .filter((r) => isUrl(str(r.url)))
    .map((r) => ({ title: str(r.title) || str(r.domain) || str(r.url), url: str(r.url) }));
  if (url !== "" && !links.some((link) => link.url === url)) links.unshift({ title: url, url });
  switch (action.type) {
    case "openPage":
      return { icon: "Globe", summary: `Opened ${brief(url || query)}`, links };
    case "findInPage":
    case "find":
      return { icon: "Search", summary: `Searched ${brief(url)} for “${brief(str(action.pattern) || query)}”`, links };
    default: {
      const searched = brief(query || str(action.query));
      if (searched !== "") return { icon: "Search", summary: `Searched: ${searched}`, links };
      // No query recorded (for example a failed lookup): name what came back.
      const titles = results.map((r) => str(r.title)).filter((t) => t !== "");
      return { icon: "Search", summary: titles.length > 0 ? `Web lookup: ${brief(titles.join(", "))}` : "Web lookup", links };
    }
  }
}

export function presentCommand(command: string): ToolPresentation {
  return { icon: "Terminal", summary: `Ran: ${brief(innerCommand(command))}`, links: [] };
}

export function presentFileChange(paths: string[]): ToolPresentation {
  const names = paths.map(fileName);
  const summary = names.length === 1 ? `Edited ${names[0]}` : `Edited ${names.length} files: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`;
  return { icon: "EditFile", summary, links: [] };
}

/** An MCP or dynamic tool: its name and its first meaningful argument. */
export function presentNamedTool(name: string, args: unknown): ToolPresentation {
  const input = (args && typeof args === "object" ? args : {}) as Json;
  const first = Object.values(input).find((value) => typeof value === "string" && value.trim() !== "") as string | undefined;
  const url = Object.values(input).find((value) => typeof value === "string" && isUrl(value)) as string | undefined;
  return {
    icon: "Plug02",
    summary: first === undefined ? name : `${name}: ${brief(first)}`,
    links: url === undefined ? [] : [{ title: url, url }],
  };
}

/** Claude Code tools by name; others fall back to the name and first argument. */
export function presentClaudeTool(name: string, input: Json): ToolPresentation {
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path);
  switch (name) {
    case "Read":
      return { icon: "FileText", summary: `Read ${path}`, links: [] };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { icon: "EditFile", summary: `${name === "Write" ? "Wrote" : "Edited"} ${path}`, links: [] };
    case "Bash":
    case "PowerShell":
      return { icon: "Terminal", summary: `Ran: ${brief(str(input.command))}`, links: [] };
    case "Grep":
      return { icon: "Search", summary: `Searched for “${brief(str(input.pattern))}”${path ? ` in ${path}` : ""}`, links: [] };
    case "Glob":
      return { icon: "Search", summary: `Found files: ${brief(str(input.pattern))}`, links: [] };
    case "WebSearch":
      return { icon: "Search", summary: `Searched: ${brief(str(input.query))}`, links: [] };
    case "WebFetch": {
      const url = str(input.url);
      return { icon: "Globe", summary: `Fetched ${brief(url)}`, links: isUrl(url) ? [{ title: url, url }] : [] };
    }
    case "Task":
    case "Agent":
      return { icon: "Bot", summary: `Agent: ${brief(str(input.description) || str(input.prompt))}`, links: [] };
    case "Skill":
      return { icon: "Toolbox", summary: `Skill: ${brief(str(input.skill) || str(input.name))}`, links: [] };
    case "TodoWrite":
      return { icon: "ListTodo", summary: "Updated the to-do list", links: [] };
    default:
      return presentNamedTool(name, input);
  }
}

/** Bounded output text for the view. */
export const outputText = (value: unknown): string | null => {
  const textValue = resultText(value);
  return textValue === null ? null : clip(textValue);
};
