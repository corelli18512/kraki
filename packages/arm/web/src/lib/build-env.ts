const LOCAL_RELAY_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

export function isLocalRelayUrl(url: string | undefined): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    return LOCAL_RELAY_HOSTS.has(parsed.hostname);
  } catch {
    return /(?:^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/.test(url);
  }
}

export function assertSafeProductionRelayUrl(command: string, mode: string, relayUrl: string | undefined): void {
  if (command !== 'build' || mode !== 'production') return;
  if (!isLocalRelayUrl(relayUrl)) return;

  throw new Error(
    [
      `Refusing to build production web app with local VITE_WS_URL=${relayUrl}.`,
      'Move local overrides to packages/arm/web/.env.development.local or set VITE_WS_URL to your real hosted relay.',
    ].join(' '),
  );
}
