'use strict';
// Where pages may go. The main window shows app pages only; GitHub sign-in
// runs in a sign-in window of its own (no preload, separate session).
const { isAppUrl } = require('./ipc-guard.cjs');

function parse(url) {
  try { return new URL(url); } catch { return null; }
}

/** The Web client's GitHub sign-in (lib/transport.ts startOAuthFlow). */
function isGitHubAuthorize(url) {
  const u = parse(url);
  return !!u && u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname === '/login/oauth/authorize';
}

/** Links the default browser may open from a page of ours. */
function isWebUrl(url) {
  const u = parse(url);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:');
}

/** Links the default browser may open from the GitHub sign-in window. */
function isHttpsUrl(url) {
  return parse(url)?.protocol === 'https:';
}

/**
 * A main-window navigation: 'app' (allowed in place), 'signin' (GitHub sign-in
 * window), 'external' (default browser) or 'block'.
 */
function mainWindowNavigation(url, appOrigin) {
  if (isAppUrl(url, appOrigin)) return 'app';
  if (isGitHubAuthorize(url)) return 'signin';
  if (isWebUrl(url)) return 'external';
  return 'block';
}

/** GitHub's redirect to the Web's registered callback, as the app's own callback page. */
function webOAuthCallbackToApp(url, redirectOrigin, callbackPath, appOrigin) {
  if (typeof url !== 'string' || !url.startsWith(redirectOrigin + callbackPath)) return null;
  return `${appOrigin}${callbackPath}${new URL(url).search}`;
}

/** The built-in Kraki's sign-in callback (…/auth/callback/desktop or kraki://), as kraki://auth/callback?… */
function builtInOAuthCallback(url) {
  const u = parse(url);
  if (!u) return null;
  if (u.pathname !== '/auth/callback/desktop' && u.protocol !== 'kraki:') return null;
  return `kraki://auth/callback${u.search}`;
}

module.exports = {
  isGitHubAuthorize, isWebUrl, isHttpsUrl, mainWindowNavigation, webOAuthCallbackToApp, builtInOAuthCallback,
};
