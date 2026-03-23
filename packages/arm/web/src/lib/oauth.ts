export function getOAuthClientId(githubClientId: string | null | undefined): string | undefined {
  const envClientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined;
  return githubClientId || envClientId;
}

export function supportsOAuthLogin(githubClientId: string | null | undefined): boolean {
  return Boolean(getOAuthClientId(githubClientId));
}
