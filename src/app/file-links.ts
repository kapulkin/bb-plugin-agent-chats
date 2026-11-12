// Local file links in agent messages (`src/a.ts`, `./a.ts#L12`, `file:///C:/a.ts`,
// `C:\a.ts:12`): resolved against the chat's folder so the chat view can open
// them in bb's file preview instead of letting the browser navigate.

interface FileLink {
  /** Absolute path in the chat folder's own style (backslashes on Windows). */
  path: string;
  /** One-based line to reveal, when the link names one. */
  line: number | null;
}

/** Schemes the browser keeps handling (web pages, mail, the app's own routes). */
const OTHER_SCHEME = /^(?!file:)[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i;

function splitLine(raw: string): { path: string; line: number | null } {
  // `#L12`, `#L12-L20`, `#L12C3` (GitHub style) or a trailing `:12` / `:12:3`.
  const fragment = /#L(\d+)(?:[-C].*)?$/i.exec(raw);
  if (fragment) return { path: raw.slice(0, fragment.index), line: Number(fragment[1]) };
  const hashIndex = raw.indexOf("#");
  const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const suffix = /:(\d+)(?::\d+)?$/.exec(withoutHash);
  if (suffix && !/^[a-z]$/i.test(withoutHash.slice(0, suffix.index))) {
    return { path: withoutHash.slice(0, suffix.index), line: Number(suffix[1]) };
  }
  return { path: withoutHash, line: null };
}

/** Join and normalize `.` and `..` segments in the folder's separator style. */
function join(base: string, relative: string): string {
  // A drive letter (`C:`) or a backslash marks a Windows folder.
  const separator = base.includes("\\") || /^[a-z]:/i.test(base) ? "\\" : "/";
  const parts = `${base}/${relative}`.split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join(separator);
  return separator === "/" ? `/${joined}` : joined;
}

/** The file a link in a message points to, or null for links the browser should handle. */
export function resolveFileLink(href: string, cwd: string | null): FileLink | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (OTHER_SCHEME.test(raw) && !WINDOWS_ABSOLUTE.test(raw)) return null;

  let decoded: string;
  try {
    decoded = decodeURI(raw);
  } catch {
    decoded = raw;
  }
  if (/^file:/i.test(decoded)) {
    // file:///C:/x, file:///home/x
    decoded = decoded.replace(/^file:\/*/i, "");
    if (!WINDOWS_ABSOLUTE.test(decoded)) decoded = `/${decoded}`;
  }
  const { path, line } = splitLine(decoded);
  if (path === "") return null;
  if (WINDOWS_ABSOLUTE.test(path)) return { path: join(path.slice(0, 2), path.slice(3)), line };
  if (path.startsWith("/")) {
    // `/c/Users/...` (Git Bash style) on a Windows chat folder.
    const drive = /^\/([a-z])\/(.*)$/i.exec(path);
    if (drive && cwd !== null && WINDOWS_ABSOLUTE.test(cwd)) return { path: join(`${drive[1]!.toUpperCase()}:`, drive[2]!), line };
    return { path: join("", path), line };
  }
  if (cwd === null) return null;
  return { path: join(cwd, path), line };
}
