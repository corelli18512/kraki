/**
 * arm-prod-log — drive the PROD arm web (app.kraki.chat) with Playwright and
 * pull browser-side logs WITHOUT depending on the pulse transport to ship them.
 *
 * Why this exists: we are debugging pulse itself. The arm's normal log path
 * (`client_log`) ships logs back to the tentacle OVER pulse — useless when
 * pulse is the thing that's broken. This script captures logs entirely inside
 * the browser and drains them out-of-band via Playwright's evaluate/expose.
 *
 * Two capture channels, both transport-independent:
 *
 *   1. `window._pulseTrace` — the app's own in-memory ring buffer, gated by
 *      `localStorage['kraki_pulse_trace']='1'`. Already in the deployed prod
 *      bundle (added in the pulse PR). Emits PULSE-SEND/TX/RX/DELIVER/ACKED,
 *      WS-RX, APP-DECRYPT, APP-AGENT-MESSAGE, USER-SEND-INPUT, etc. with
 *      performance.now() + Date.now() timestamps.
 *
 *   2. `window._wsTrace` — a WebSocket constructor wrapper installed by
 *      addInitScript BEFORE the app's JS runs. Captures the WS lifecycle the
 *      deployed app does NOT trace: open(url), close(code,reason), error,
 *      send(len), message(len, type, hasPulse). This is the missing half for
 *      pulse debugging (the connection dropping / not opening is exactly what
 *      we can't see today).
 *
 * Auth: prod arm uses GitHub OAuth / challenge auth. We use a PERSISTENT
 * browser profile (userDataDir) so you log in ONCE (headed, manually); after
 * that the device key + relay URL persist in localStorage and the script can
 * reconnect headlessly with zero interaction — exactly like a returning tab.
 *
 * Usage (run from repo root):
 *   pnpm exec tsx scripts/arm-prod-log.ts                 # headless, 60s capture
 *   pnpm exec tsx scripts/arm-prod-log.ts --headed        # visible browser
 *   pnpm exec tsx scripts/arm-prod-log.ts --duration 0    # run forever (Ctrl-C)
 *   pnpm exec tsx scripts/arm-prod-log.ts --dump         # just pull the ring + exit
 *   pnpm exec tsx scripts/arm-prod-log.ts --send "hi"   # type into the active session
 *
 * Output:
 *   .tmp/arm-prod-log.jsonl   — every event, one JSON object per line
 *   stdout                     — live colored stream + final summary
 *
 * NOTE on the first run: if the profile isn't paired yet, the app shows the
 * login screen. Run with --headed and complete GitHub sign-in once; the
 * profile persists at .tmp/arm-pw-profile and subsequent runs are headless.
 */

import { createRequire } from 'node:module';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Evt = { t: number; wallMs: number; comp: string; evt: string; [k: string]: unknown };

const REPO = resolve(import.meta.dirname ?? __dirname, '..');
// playwright lives in the arm/web workspace, not at repo root.
const pwRequire = createRequire(join(REPO, 'packages', 'arm', 'web', 'package.json'));
const { chromium } = pwRequire('playwright') as typeof import('playwright');
type BrowserContext = import('playwright').BrowserContext;
type Page = import('playwright').Page;

const PROFILE_DIR = join(REPO, '.tmp', 'arm-pw-profile');
const OUT_FILE = join(REPO, '.tmp', 'arm-prod-log.jsonl');

// prod web + force the cn region relay (matches the user's tentacle).
const APP_URL = 'https://app.kraki.chat';
const RELAY = 'wss://cn.relay.kraki.chat';

const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const DUMP_ONLY = args.includes('--dump');
const DURATION = (() => {
  const i = args.indexOf('--duration');
  return i >= 0 ? Number(args[i + 1]) : 60;
})();
const SEND = (() => {
  const i = args.indexOf('--send');
  return i >= 0 ? args[i + 1] : undefined;
})();
const TOKEN = (() => {
  const i = args.indexOf('--token');
  return i >= 0 ? args[i + 1] : undefined;
})();

mkdirSync(join(REPO, '.tmp'), { recursive: true });
mkdirSync(PROFILE_DIR, { recursive: true });
if (!DUMP_ONLY) appendFileSync(OUT_FILE, ''); // touch

// ── colors ────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', gray: '\x1b[90m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m',
  bold: '\x1b[1m',
};
const EVT_COLOR: Record<string, string> = {
  'WS-OPEN': C.green, 'WS-CLOSE': C.red, 'WS-ERROR': C.red,
  'WS-SEND': C.blue, 'WS-RX': C.cyan, 'WS-MESSAGE': C.cyan,
  'PULSE-SEND': C.magenta, 'PULSE-TX': C.magenta, 'PULSE-RX': C.cyan,
  'PULSE-DELIVER': C.green, 'PULSE-ACKED': C.dim, 'PULSE-CONNECTED': C.green,
  'PULSE-DISCONNECTED': C.yellow, 'PULSE-RESET-INBOUND': C.red,
  'CONSOLE': C.gray, 'PAGEERROR': C.bold + C.red, 'NAV': C.gray,
};

let count = 0;
const byEvt = new Map<string, number>();
let firstWall = 0;

function ts(wallMs: number): string {
  const d = new Date(wallMs);
  return d.toISOString().slice(11, 23);
}

function handle(evt: Evt): void {
  if (!firstWall) firstWall = evt.wallMs;
  count++;
  byEvt.set(evt.evt, (byEvt.get(evt.evt) ?? 0) + 1);
  appendFileSync(OUT_FILE, JSON.stringify(evt) + '\n');
  const col = EVT_COLOR[evt.evt] ?? C.reset;
  const rel = (evt.wallMs - firstWall).toString().padStart(7);
  const core = `${C.gray}${ts(evt.wallMs)}${C.reset} ${C.dim}+${rel}ms${C.reset} ${col}${evt.evt.padEnd(20)}${C.reset}`;
  const rest: string[] = [];
  for (const [k, v] of Object.entries(evt)) {
    if (['t', 'wallMs', 'comp', 'evt'].includes(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    const sv = typeof v === 'string' ? v : JSON.stringify(v);
    if (sv.length > 120) rest.push(`${C.dim}${k}${C.reset}=${sv.slice(0, 117)}...`);
    else rest.push(`${C.dim}${k}${C.reset}=${sv}`);
  }
  process.stdout.write(`${core} ${rest.join(' ')}\n`);
}

// ── in-page instrumentation (runs before app JS on every navigation) ──────
const INIT_SCRIPT = `
(() => {
  try { localStorage.setItem('kraki_pulse_trace', '1'); } catch {}
  // optional: make the app's console visible too (it's silent in prod builds)
  try { localStorage.setItem('kraki_debug_logging', '0'); } catch {}

  const cap = 20000;
  const wsTrace = [];
  window._wsTrace = wsTrace;

  function push(e){ wsTrace.push(e); if (wsTrace.length > cap) wsTrace.splice(0, wsTrace.length - cap);
    if (typeof window.__pwTrace === 'function') { try { window.__pwTrace(e); } catch {} }
  }
  function now(){ return { t: performance.now(), wallMs: Date.now() }; }

  const OrigWS = window.WebSocket;
  const Wrapped = function(url, protocols){
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    const base = { comp:'arm', url: String(url), ...now() };
    push({ ...base, evt:'WS-OPEN' });
    ws.addEventListener('open', () => push({ comp:'arm', evt:'WS-OPEN', url:String(url), ...now() }));
    ws.addEventListener('close', (ev) => push({ comp:'arm', evt:'WS-CLOSE', url:String(url),
      code: ev.code, reason: ev.reason || '', wasClean: ev.wasClean, ...now() }));
    ws.addEventListener('error', () => push({ comp:'arm', evt:'WS-ERROR', url:String(url),
      readyState: ws.readyState, ...now() }));
    ws.addEventListener('message', (ev) => {
      let len=0, type=null, hasPulse=false;
      try {
        const s = typeof ev.data === 'string' ? ev.data : '';
        len = s.length;
        if (s && s.charCodeAt(0) === 123) { const j = JSON.parse(s);
          type = j.type ?? null; hasPulse = typeof j.pulse === 'string';
          if (j.closeCode !== undefined) { /* keep */ }
        }
      } catch {}
      push({ comp:'arm', evt:'WS-MESSAGE', url:String(url), len, type, hasPulse, ...now() });
    });
    const origSend = ws.send.bind(ws);
    ws.send = function(data){
      let len = typeof data === 'string' ? data.length : (data && data.byteLength) || 0;
      push({ comp:'arm', evt:'WS-SEND', url:String(url), len, ...now() });
      return origSend(data);
    };
    return ws;
  };
  Wrapped.prototype = OrigWS.prototype;
  Wrapped.CONNECTING = OrigWS.CONNECTING;
  Wrapped.OPEN = OrigWS.OPEN;
  Wrapped.CLOSING = OrigWS.CLOSING;
  Wrapped.CLOSED = OrigWS.CLOSED;
  window.WebSocket = Wrapped;

  // console mirror (catches native errors + anything the app logs directly)
  for (const m of ['log','info','warn','error','debug']) {
    const orig = console[m].bind(console);
    console[m] = function(...a){
      try { push({ comp:'arm', evt:'CONSOLE', level:m,
        msg: a.map(x => typeof x==='string'?x:JSON.stringify(x)).join(' ').slice(0,500), ...now() }); } catch {}
      orig(...a);
    };
  }
  window.addEventListener('error', (e) => push({ comp:'arm', evt:'PAGEERROR',
    msg: (e.error && e.error.message) || e.message || '', filename: e.filename, line: e.lineno, ...now() }));
  window.addEventListener('unhandledrejection', (e) => push({ comp:'arm', evt:'PAGEERROR',
    msg: 'unhandledrejection ' + (e.reason && e.reason.message || String(e.reason)).slice(0,300), ...now() }));
})();
`;

async function main(): Promise<void> {
  console.log(`${C.bold}arm-prod-log${C.reset}  ${C.gray}profile=${PROFILE_DIR}${C.reset}`);
  console.log(`${C.gray}app=${APP_URL}  relay=${RELAY}${C.reset}`);
  console.log(`${C.gray}out=${OUT_FILE}${C.reset}\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    // System proxy settings (hysteria SOCKS) make headless Chromium fail with
    // ERR_PROXY_CONNECTION_FAILED. Explicitly route through the local proxy so
    // both app.kraki.chat and the GitHub OAuth flow work.
    proxy: { server: 'socks5://127.0.0.1:1080' },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // out-of-band event drain — survives navigations, independent of pulse.
  await ctx.exposeFunction('__pwTrace', (evt: Evt) => handle(evt));
  await ctx.addInitScript(INIT_SCRIPT);

let consoleBuf: string[] = [];
  consoleBuf = [];
  ctx.on('page', (page) => {
    page.on('console', (m) => {
      const e: Evt = { t: 0, wallMs: Date.now(), comp: 'arm', evt: 'CONSOLE',
        level: m.type(), msg: m.text().slice(0, 500) };
      handle(e); consoleBuf.push(m.text());
    });
    page.on('pageerror', (err) => {
      handle({ t: 0, wallMs: Date.now(), comp: 'arm', evt: 'PAGEERROR', msg: err.message });
    });
  });

  let page = ctx.pages()[0] ?? (await ctx.newPage());
  const tokenPart = TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '';
  const target = `${APP_URL}?relay=${encodeURIComponent(RELAY)}${tokenPart}`;
  console.log(`${C.dim}navigating → ${target}${C.reset}`);
  await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Did we land on a login screen? Detect by whether a WS opens within 8s.
  const opened = await new Promise<boolean>((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      page.evaluate(() => (window as any)._wsTrace?.length ?? 0)
        .then((n) => {
          if (n > 0) { clearInterval(iv); resolve(true); }
          else if (Date.now() - start > 8000) { clearInterval(iv); resolve(false); }
        })
        .catch(() => { if (Date.now() - start > 8000) { clearInterval(iv); resolve(false); } });
    }, 300);
  });

  if (!opened) {
    // Check whether a login affordance is present.
    const loginHint = await page.evaluate(() => {
      const txt = document.body?.innerText?.slice(0, 400) ?? '';
      const hasGithub = /sign in|github|log ?in|continue with/i.test(txt);
      const hasInput = !!document.querySelector('input');
      return { hasGithub, hasInput, txt: txt.slice(0, 200) };
    }).catch(() => ({ hasGithub: false, hasInput: false, txt: '' }));

    if (loginHint.hasGithub || loginHint.hasInput) {
      console.log(`\n${C.yellow}⚠  No WebSocket opened — the app is on the login screen.${C.reset}`);
      console.log(`${C.gray}This profile isn't paired yet. With --headed, complete GitHub sign-in now;${C.reset}`);
      console.log(`${C.gray}the profile persists at .tmp/arm-pw-profile and future runs reconnect headlessly.${C.reset}`);
      if (!HEADED) {
        console.log(`${C.bold}Re-run with --headed to log in, then re-run normally.${C.reset}`);
      }
    } else {
      console.log(`${C.yellow}⚠  No WS opened and no obvious login UI. Page text:${C.reset}\n${C.gray}${loginHint.txt}${C.reset}`);
    }
  } else {
    console.log(`${C.green}✓ WebSocket opened — arm is connected to the relay.${C.reset}`);
  }

  // Optional: type into the active session composer to generate traffic.
  if (SEND) {
    try {
      await page.waitForSelector('textarea', { timeout: 5000 });
      await page.fill('textarea', SEND);
      await page.keyboard.press('Enter');
      console.log(`${C.green}→ sent message: "${SEND}"${C.reset}`);
    } catch {
      console.log(`${C.yellow}(could not find a composer to type into)${C.reset}`);
    }
  }

  if (DUMP_ONLY) {
    await dumpRing(page);
    await ctx.close();
    return;
  }

  if (DURATION <= 0) {
    console.log(`\n${C.gray}capturing forever — Ctrl-C to stop.${C.reset}\n`);
    await new Promise(() => {});
  } else {
    console.log(`\n${C.gray}capturing for ${DURATION}s …  Ctrl-C to stop early.${C.reset}\n`);
    await new Promise((r) => setTimeout(r, DURATION * 1000));
  }

  await dumpRing(page);
  printSummary();
  await ctx.close();
}

async function dumpRing(page: Page): Promise<void> {
  try {
    const ring = await page.evaluate(() => {
      const arr = (window as any)._pulseTrace ?? [];
      return arr.map((e: any) => ({ ...e, source: 'ring' }));
    });
    if (ring.length) {
      console.log(`\n${C.bold}── app ring buffer: ${ring.length} events ──${C.reset}`);
      // print only events not already seen via the live stream (heuristic: ring
      // has performance.now() `t`; we just append the unique ones to the file).
      let n = 0;
      for (const e of ring) { appendFileSync(OUT_FILE, JSON.stringify(e) + '\n'); n++; }
      console.log(`${C.gray}appended ${n} ring events to ${OUT_FILE}${C.reset}`);
    } else {
      console.log(`${C.yellow}(app ring buffer empty — kraki_pulse_trace may not have been enabled before the app loaded)${C.reset}`);
    }
  } catch (err) {
    console.log(`${C.red}dump failed: ${(err as Error).message}${C.reset}`);
  }
}

function printSummary(): void {
  console.log(`\n${C.bold}── summary: ${count} events ──${C.reset}`);
  const sorted = [...byEvt.entries()].sort((a, b) => b[1] - a[1]);
  for (const [evt, n] of sorted) {
    const col = EVT_COLOR[evt] ?? C.reset;
    console.log(`  ${col}${evt.padEnd(22)}${C.reset} ${String(n).padStart(6)}`);
  }
  console.log(`${C.gray}full log: ${OUT_FILE}${C.reset}`);
}

main().catch((err) => {
  console.error(`${C.red}fatal:${C.reset}`, err);
  process.exit(1);
});
