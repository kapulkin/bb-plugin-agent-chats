// Text helpers shared by the host, the chat drivers, and the app.

/** `text` on one line with runs of whitespace collapsed, cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** The message of a thrown value, for showing to the user. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Whether a message text block is only a system reminder. The Claude app puts
 * one before the first message of a chat without a project to brief the
 * model; the chat view shows the user's own text only.
 */
export function isSystemReminder(text: string): boolean {
  return /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(text);
}
