/**
 * Clickable terminal links (OSC 8) only in terminals known to render them.
 * A terminal without OSC 8 support (Linux console, xterm, older
 * Terminal.app, tmux/ssh without passthrough…) prints only the link text, so
 * "how to install" showed no URL at all (K-269). Elsewhere the URL is printed
 * so it can still be copied.
 */
export function supportsLinks(env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout.isTTY)): boolean {
  if (env.FORCE_HYPERLINK !== undefined) return env.FORCE_HYPERLINK !== '0';
  if (!isTTY) return false;
  if (env.WT_SESSION) return true; // Windows Terminal
  const program = env.TERM_PROGRAM;
  if (program === 'vscode' || program === 'iTerm.app' || program === 'WezTerm'
    || program === 'Hyper' || program === 'ghostty' || program === 'Tabby') return true;
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty' || env.TERM === 'xterm-ghostty') return true;
  if (env.KONSOLE_VERSION) return true;
  // GNOME Terminal, Tilix and other VTE terminals since VTE 0.50.
  const vte = Number.parseInt(env.VTE_VERSION ?? '', 10);
  return Number.isFinite(vte) && vte >= 5000;
}

export function termLink(text: string, url: string): string {
  if (!supportsLinks()) return text === url || url.endsWith(`//${text}`) ? text : `${text}: ${url}`;
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}
