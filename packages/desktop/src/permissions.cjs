'use strict';
// Web permissions for the app's own pages (app://kraki). Everything else, and
// any other permission, is refused.
//
// - media (audio only): voice input.
// - clipboard-sanitized-write: the Copy buttons (pairing link, sign-in code,
//   messages, tables, diagnostics). Reading the clipboard stays refused.

const ALLOWED = new Set(['media', 'clipboard-sanitized-write']);

function isAppUrl(url, appOrigin) {
  return typeof url === 'string' && (url === appOrigin || url.startsWith(`${appOrigin}/`));
}

/** session.setPermissionRequestHandler */
function allowRequest(permission, details, url, appOrigin) {
  if (!ALLOWED.has(permission) || !isAppUrl(url, appOrigin)) return false;
  if (permission === 'media') return (details?.mediaTypes ?? []).every((t) => t === 'audio');
  return true;
}

/** session.setPermissionCheckHandler (origin has no trailing slash) */
function allowCheck(permission, origin, appOrigin) {
  return ALLOWED.has(permission) && origin === appOrigin;
}

module.exports = { allowRequest, allowCheck };
