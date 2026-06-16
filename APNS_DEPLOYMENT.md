# APNs Deployment Guide

Steps to enable Apple Push Notifications on a Kraki relay.

## 1. Get an APNs Auth Key

1. Apple Developer → **Certificates, Identifiers & Profiles** → **Keys** → **+**
2. Name: `Kraki APNs`
3. Check **Apple Push Notifications service (APNs)**
4. Continue → Register → **Download the `.p8` file** (you can only download once)
5. Note:
   - **Key ID** (10-char string shown after registration, e.g. `ABC123DEFG`)
   - **Team ID** (Apple Developer → Membership)
   - **Bundle ID**: `cloud.corelli.kraki`

## 2. Upload the key to the relay

```bash
scp AuthKey_ABC123DEFG.p8 corelli-tecent-cloud-small-0:/var/lib/kraki/apns-key.p8
ssh corelli-tecent-cloud-small-0 "chmod 600 /var/lib/kraki/apns-key.p8 && chown root:root /var/lib/kraki/apns-key.p8"
```

## 3. Update the systemd service

Edit `/etc/systemd/system/kraki-relay.service`:

```ini
[Service]
Environment=HOME=/root
Environment=NPM_CONFIG_UPDATE_NOTIFIER=false
Environment=APNS_KEY_PATH=/var/lib/kraki/apns-key.p8
Environment=APNS_KEY_ID=ABC123DEFG
Environment=APNS_TEAM_ID=XXXXXXXXXX
Environment=APNS_BUNDLE_ID=cloud.corelli.kraki
Environment=APNS_ENVIRONMENT=production
WorkingDirectory=/var/lib/kraki
ExecStart=/usr/local/bin/kraki-relay --port 4000 --db /var/lib/kraki/kraki-relay.db --push web_push,apns
```

The CLI flag `--push web_push,apns` enables both providers. APNs config is read from env.

## 4. Restart the service

```bash
ssh corelli-tecent-cloud-small-0 "systemctl daemon-reload && systemctl restart kraki-relay && systemctl status kraki-relay --no-pager"
```

## 5. Verify

Tail the log on connect — should see:
```
APNs push provider configured {"bundleId":"cloud.corelli.kraki","environment":"production"}
```

When the iOS app first registers a token:
```
Push token registered {"deviceId":"dev_...","provider":"apns"}
```

When the app is offline and an event arrives:
```
APNs push sent {"tokenSuffix":"...","status":200}
```

## Notes

- **Sandbox vs production**: the iOS app sends `environment` per-token in the
  `register_push_token` payload. Debug builds send `"sandbox"`, release builds
  read it from the embedded mobileprovision (default `"production"`). The relay
  routes accordingly. So both can coexist on one relay — the app picks correctly.
- **Stale tokens**: when APNs returns `410 Gone` the relay deletes the token
  automatically. No manual cleanup required.
- **Push never fires when device is online**: the relay only pushes to devices
  not currently in the WebSocket-connected set for the user. Force-quit the app
  to test.
