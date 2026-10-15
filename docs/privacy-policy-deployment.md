# Public privacy policy deployment

Canonical URL: <https://app.kraki.chat/privacy/>. The landing-site `/privacy` redirect also leads here. Source: `packages/arm/web/public/privacy/index.html` (standalone bilingual HTML, no app login or scripts).

After fresh CI passes on the intended merged main SHA, deploy with the production target of `.github/workflows/deploy-web.yml`. Confirm the run's SHA and target; an automatic beta deployment is not production delivery. Publishing this page does not complete App Store privacy labels or turn on daily account reporting in older clients/servers.

## SPA routing matters

The existing Caddy SPA fallback (`try_files {path} /index.html`) can return the app shell for `/privacy/` even when `privacy/index.html` exists. In the `app.kraki.chat` site, before the beta-cookie handler and general SPA handler, keep a dedicated static route:

```caddyfile
# Site root remains /var/www/kraki.
@kraki_privacy path /privacy /privacy/ /privacy/index.html
handle @kraki_privacy {
    file_server
}
```

This lets `file_server` canonicalize the no-slash URL and serve the directory index. It is intentionally independent of app state and channel cookies.

Before any proxy change, make a private backup, validate a candidate with `caddy validate --adapter caddyfile`, and check that the source configuration has not changed concurrently. Reload, not restart, the proxy. Verify the route and existing relay readiness; restore the backup and reload if checks fail. The server can bind an explicit private interface rather than `127.0.0.1`: discover the actual listener before choosing a local HTTPS probe. A relay process restart is not needed.

## Verify delivery, not just build success

- Fetch `/privacy/`, `/privacy` and `/privacy/index.html` without cookies or authentication; each must resolve to the policy, not the SPA HTML.
- Verify the landing-site `/privacy` redirect.
- Compare final response bytes/hash with the reviewed source; inspect both languages on desktop and phone-sized viewports.
- Check there are no automatic third-party requests, horizontal overflow or login requirements, and that the ordinary app and relay remain healthy.
- Retain proxy backup and deployment-run references privately. Do not put environment files, credentials or raw account/diagnostic records into reports.
