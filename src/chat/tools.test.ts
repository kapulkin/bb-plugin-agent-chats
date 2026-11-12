import { describe, expect, it } from "vitest";
import { innerCommand, presentClaudeTool, presentCodexWebSearch, presentFileChange, presentNamedTool, resultText } from "./tools";

describe("tool rows", () => {
  it("summarizes Codex web searches and keeps their links", () => {
    const opened = presentCodexWebSearch({
      query: "https://example.com/docs/vault",
      action: { type: "openPage", url: "https://example.com/docs/vault" },
      results: [{ type: "text_result", domain: "example.com", url: "https://example.com/docs/vault", snippet: "…" }],
    });
    expect(opened).toEqual({
      icon: "Globe",
      summary: "Opened https://example.com/docs/vault",
      links: [{ title: "example.com", url: "https://example.com/docs/vault" }],
    });
    expect(presentCodexWebSearch({ query: "PCI DSS 4.0.1 vault", action: { type: "search" } }).summary).toBe("Searched: PCI DSS 4.0.1 vault");
  });

  it("unwraps shell wrappers to the command that ran", () => {
    expect(innerCommand(`"C:\\x\\pwsh.exe" -Command 'Get-Content AGENTS.md; git status'`)).toBe("Get-Content AGENTS.md; git status");
    expect(innerCommand("/bin/bash -lc 'ls -la'")).toBe("ls -la");
    expect(innerCommand("npm test")).toBe("npm test");
  });

  it("names files, Claude tools, and MCP tools", () => {
    expect(presentFileChange(["C:\\a\\x.md", "/b/y.json"]).summary).toBe("Edited 2 files: x.md, y.json");
    expect(presentClaudeTool("Read", { file_path: "a.txt" }).summary).toBe("Read a.txt");
    expect(presentClaudeTool("WebFetch", { url: "https://example.com" })).toMatchObject({ icon: "Globe", links: [{ url: "https://example.com" }] });
    expect(presentNamedTool("codex_app.open_in_codex", { target: { path: "x" } }).summary).toBe("codex_app.open_in_codex");
  });

  it("shows the text of MCP results instead of their JSON envelope", () => {
    expect(resultText({ content: [{ type: "text", text: "Done." }], structuredContent: null })).toBe("Done.");
    expect(resultText("plain")).toBe("plain");
  });
});
