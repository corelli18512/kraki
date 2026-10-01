/**
 * Clickable terminal links (OSC 8) only where they work: a TTY, and on Windows
 * only in Windows Terminal / VS Code — the classic console has no hyperlinks.
 * Elsewhere the URL is printed so it can still be copied.
 */
export function supportsLinks(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.platform === 'win32') return Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === 'vscode';
  return true;
}

export function termLink(text: string, url: string): string {
  if (!supportsLinks()) return text === url || url.endsWith(`//${text}`) ? text : `${text}: ${url}`;
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}
