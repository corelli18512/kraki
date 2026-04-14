# Self-Hosting Kraki

Run your own relay instead of using the hosted one at `kraki.corelli.cloud`.

## Start the relay

```bash
npx @kraki/head

# or
npm i -g @kraki/head
kraki-relay
```

By default the relay listens on `ws://localhost:4000`. It stores only user and device data — no messages, no sessions.

Then run kraki on the coding machine and point it at your relay URL instead of the hosted default.

## Enable GitHub Login for the web app

By default, users connect the web app via QR code pairing from the terminal. You can also enable "Sign in with GitHub":

1. Create a GitHub OAuth App at **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set the **Authorization callback URL** to your web app URL (e.g., `https://your-domain.com` or `http://localhost:3000`)
3. Set the environment variables on your relay server:

```bash
GITHUB_CLIENT_ID=your_client_id \
GITHUB_CLIENT_SECRET=your_client_secret \
kraki-relay --auth github
```

The web app will automatically show a "Sign in with GitHub" button when the relay has OAuth configured. QR pairing continues to work alongside GitHub login.

## Enable push notifications

The relay can send push notifications to offline browsers when agents need attention (permissions, questions, turn completions). Notifications are end-to-end encrypted — the relay forwards an opaque blob, and the browser's service worker decrypts it locally.

1. Generate VAPID keys (one-time):

```bash
npx web-push generate-vapid-keys
```

2. Set the environment variables on your relay server:

```bash
VAPID_PUBLIC_KEY=your_public_key \
VAPID_PRIVATE_KEY=your_private_key \
VAPID_EMAIL=mailto:you@example.com \
kraki-relay --push web_push
```

The web app will automatically show a "Push notifications" toggle in Settings when the relay has VAPID configured.

## Local web development

For local web development, put browser-only overrides like `VITE_WS_URL=ws://localhost:4000` in `packages/arm/web/.env.development.local`, not `packages/arm/web/.env`. Vite loads `.env` during production builds too, so using the dev-only filename avoids accidentally baking localhost into a deploy.
