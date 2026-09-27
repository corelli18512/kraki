# Kraki desktop (prototype)

The Kraki Web client in an Electron shell, for Windows (and Linux). The app is
the same build as the Web (`packages/arm/web`), served from `app://kraki`.

What the shell adds over a browser tab:
- Keeps running in the tray when the window is closed, so the relay
  connection stays up and replies / questions / approvals notify natively
  (`lib/desktop.ts` in the Web client; browsers keep using Web Push).
- Taskbar unread badge, single instance, remembered window size, links open
  in the default browser, spell-check menu, Ctrl +/−/0 zoom.
- GitHub sign-in inside the window: the Web's registered callback
  (`https://app.kraki.chat/auth/callback`) is intercepted and handed to the app.

Kept out of the pnpm workspace (Electron is a large download).

```bash
cd packages/desktop
npm install
node scripts/prepare-web.mjs   # build the Web client into app/
npm start                      # run
npm run dist:win               # NSIS installer (run on Windows)
```

China mirrors: `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`,
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

Local testing only: `KRAKI_DESKTOP_DEBUG_PORT` (remote debugging),
`KRAKI_DESKTOP_QUERY` (e.g. `relay=ws://<lan-ip>:4470&token=<pairing>`),
`KRAKI_DESKTOP_ALLOW_INSECURE=1` (plain ws:// relay), `KRAKI_DESKTOP_LOG_NOTIFY=1`.

Not done yet: code signing (SmartScreen warns on unsigned installers),
auto-update (electron-updater + GitHub Releases), CI build, real GitHub OAuth
check.
