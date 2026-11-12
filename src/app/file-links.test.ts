import { describe, expect, it } from "vitest";
import { resolveFileLink } from "./file-links";

const win = String.raw`C:\Users\me\repo`;

describe("resolveFileLink", () => {
  it("resolves relative links against the chat folder", () => {
    expect(resolveFileLink("bundled/tool/parser/a.md", win)).toEqual({ path: String.raw`C:\Users\me\repo\bundled\tool\parser\a.md`, line: null });
    expect(resolveFileLink("./src/a.ts#L12", win)).toEqual({ path: String.raw`C:\Users\me\repo\src\a.ts`, line: 12 });
    expect(resolveFileLink("../other/b.ts:40", win)).toEqual({ path: String.raw`C:\Users\me\other\b.ts`, line: 40 });
    expect(resolveFileLink("docs/My%20File.md", "/home/me/repo")).toEqual({ path: "/home/me/repo/docs/My File.md", line: null });
  });

  it("accepts absolute paths and file URLs", () => {
    expect(resolveFileLink("file:///C:/Users/me/repo/specs/a.md", win)).toEqual({ path: String.raw`C:\Users\me\repo\specs\a.md`, line: null });
    expect(resolveFileLink(String.raw`C:\Users\me\x.ts:7`, win)).toEqual({ path: String.raw`C:\Users\me\x.ts`, line: 7 });
    expect(resolveFileLink("/c/Users/me/x.ts", win)).toEqual({ path: String.raw`C:\Users\me\x.ts`, line: null });
    expect(resolveFileLink("file:///home/me/a.md", "/home/me")).toEqual({ path: "/home/me/a.md", line: null });
  });

  it("leaves web links, anchors and unknown folders to the browser", () => {
    expect(resolveFileLink("https://example.com/a.md", win)).toBeNull();
    expect(resolveFileLink("mailto:a@b.c", win)).toBeNull();
    expect(resolveFileLink("#section", win)).toBeNull();
    expect(resolveFileLink("src/a.ts", null)).toBeNull();
  });
});
