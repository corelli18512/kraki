/**
 * arm-prod-chat — drive the PROD arm to chat with a real session and capture
 * the full pulse round-trip across all three hops.
 *
 * Connects to app.kraki.chat with the persistent Playwright profile (already
 * paired), navigates to the latest session, sends a message, and waits for the
 * agent's response — while capturing every WS lifecycle event + pulse ring
 * event, entirely browser-side (no dependency on pulse to ship logs).
 *
 * Usage: pnpm exec tsx scripts/arm-prod-chat.ts [--message "..."] [--duration 120]
 */

import { createRequire } from 'node:module';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Evt = { t: number; wallMs: number; comp: string; evt: string; [k: string]: unknown };

const REPO = resolve(__dirname, '..');
const pwReq = createRequire(join(REPO, 'packages', 'arm', 'web', 'package.json'));
const { chromium } = pwReq('playwright') as typeof import('playwright');
type Page = import('playwright').Page;

const PROFILE_DIR = join(REPO, '.tmp', 'arm-pw-profile');
const OUT_FILE = join(REPO, '.tmp', 'arm-prod-chat.jsonl');
const APP_URL = 'https://app.kraki.chat';
const RELAY = 'wss://cn.relay.kraki.chat';

const args = process.argv.slice(2);
const MESSAGE = (() => { const i = args.indexOf('--message'); return i >= 0 ? args[i + 1] : 'hi, can you confirm you received this? just say OK'; })();
const DURATION = (() => { const i = args.indexOf('--duration'); return i >= 0 ? Number(args[i + 1]) : 120; })();

mkdirSync(join(REPO, '.tmp'), { recursive: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const C = { reset: '\x1b[0m', dim: '\x1b[2m', gray: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m', bold: '\x1b[1m' };
const EVT_COLOR: Record<string, string> = {
  'WS-OPEN': C.green, 'WS-CLOSE': C.red, 'WS-ERROR': C.red, 'WS-SEND': C.blue, 'WS-MESSAGE': C.cyan,
  'PULSE-SEND': C.magenta, 'PULSE-TX': C.magenta, 'PULSE-RX': C.cyan, 'PULSE-DELIVER': C.green,
  'PULSE-ACKED': C.dim, 'PULSE-CONNECTED': C.green, 'PULSE-DISCONNECTED': C.yellow,
  'APP-DECRYPT': C.green, 'APP-AGENT-MESSAGE': C.green, 'APP-SEND-ENCRYPTED': C.magenta,
  'CONSOLE': C.gray, 'PAGEERROR': C.bold + C.red,
};

let count = 0;
const byEvt = new Map<string, number>();
let firstWall = 0;

function ts(w: number): string { return new Date(w).toISOString().slice(11, 23); }

function handle(e: Evt): void {
  if (!firstWall) firstWall = e.wallMs;
  count++;
  byEvt.set(e.evt, (byEvt.get(e.evt) ?? 0) + 1);
  appendFileSync(OUT_FILE, JSON.stringify(e) + '\n');
  const col = EVT_COLOR[e.evt] ?? C.reset;
  const rel = (e.wallMs - firstWall).toString().padStart(7);
  const core = `${C.gray}${ts(e.wallMs)}${C.reset} ${C.dim}+${rel}ms${C.reset} ${col}${e.evt.padEnd(20)}${C.reset}`;
  const rest: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (['t', 'wallMs', 'comp', 'evt'].includes(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    const sv = typeof v === 'string' ? v : JSON.stringify(v);
    rest.push(`${C.dim}${k}${C.reset}=${sv.length > 100 ? sv.slice(0, 97) + '...' : sv}`);
  }
  process.stdout.write(`${core} ${rest.join(' ')}\n`);
}

const INIT_SCRIPT = `
(() => {
  try { localStorage.setItem('kraki_pulse_trace', '1'); } catch {}
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
    push({ comp:'arm', evt:'WS-OPEN', url:String(url), ...now() });
    ws.addEventListener('open', () => push({ comp:'arm', evt:'WS-OPEN', url:String(url), ...now() }));
    ws.addEventListener('close', (ev) => push({ comp:'arm', evt:'WS-CLOSE', url:String(url), code: ev.code, reason: ev.reason || '', wasClean: ev.wasClean, ...now() }));
    ws.addEventListener('error', () => push({ comp:'arm', evt:'WS-ERROR', url:String(url), readyState: ws.readyState, ...now() }));
    ws.addEventListener('message', (ev) => {
      let len=0, type=null, hasPulse=false;
      try { const s = typeof ev.data === 'string' ? ev.data : ''; len = s.length;
        if (s && s.charCodeAt(0) === 123) { const j = JSON.parse(s); type = j.type ?? null; hasPulse = typeof j.pulse === 'string'; }
      } catch {}
      push({ comp:'arm', evt:'WS-MESSAGE', url:String(url), len, type, hasPulse, ...now() });
    });
    const origSend = ws.send.bind(ws);
    ws.send = function(data){
      push({ comp:'arm', evt:'WS-SEND', url:String(url), len: typeof data==='string'?data.length:(data&&data.byteLength)||0, ...now() });
      return origSend(data);
    };
    return ws;
  };
  Wrapped.prototype = OrigWS.prototype;
  Wrapped.CONNECTING = OrigWS.CONNECTING; Wrapped.OPEN = OrigWS.OPEN;
  Wrapped.CLOSING = OrigWS.CLOSING; Wrapped.CLOSED = OrigWS.CLOSED;
  window.WebSocket = Wrapped;
  for (const m of ['log','info','warn','error','debug']) {
    const orig = console[m].bind(console);
    console[m] = function(...a){
      try { push({ comp:'arm', evt:'CONSOLE', level:m, msg: a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ').slice(0,300), ...now() }); } catch {}
      orig(...a);
    };
  }
  window.addEventListener('error', (e) => push({ comp:'arm', evt:'PAGEERROR', msg: (e.error&&e.error.message)||e.message||'', ...now() }));
  window.addEventListener('unhandledrejection', (e) => push({ comp:'arm', evt:'PAGEERROR', msg: 'unhandledrejection ' + (e.reason&&e.reason.message||String(e.reason)).slice(0,200), ...now() }));
})();
`;

async function main(): Promise<void> {
  console.log(`${C.bold}arm-prod-chat${C.reset}  ${C.gray}message="${MESSAGE}"${C.reset}`);
  console.log(`${C.gray}app=${APP_URL}  relay=${RELAY}  duration=${DURATION}s${C.reset}\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    proxy: { server: 'socks5://127.0.0.1:1080' },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  await ctx.exposeFunction('__pwTrace', (e: Evt) => handle(e));
  await ctx.addInitScript(INIT_SCRIPT);

  ctx.on('page', (page) => {
    page.on('console', (m) => handle({ t: 0, wallMs: Date.now(), comp: 'arm', evt: 'CONSOLE', level: m.type(), msg: m.text().slice(0, 300) }));
    page.on('pageerror', (err) => handle({ t: 0, wallMs: Date.now(), comp: 'arm', evt: 'PAGEERROR', msg: err.message }));
  });

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${APP_URL}?relay=${encodeURIComponent(RELAY)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Wait for auth + session list
  console.log(`${C.dim}waiting for auth + session list...${C.reset}`);
  await page.waitForTimeout(4000);

  // Navigate directly to the latest session — session cards in the sidebar are
  // plain <button> elements with onClick handlers (no href/data attrs), so
  // direct URL navigation is more reliable than trying to click them.
  const SESSION_ID = process.env.KRAKI_SESSION_ID || 'mrbdurdy-gkmhch33';
  console.log(`${C.green}navigating to session ${SESSION_ID}${C.reset}`);
  await page.goto(`${APP_URL}/session/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Type and send message
  console.log(`${C.dim}looking for composer textarea...${C.reset}`);
  try {
    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 8000 });
    console.log(`${C.green}found composer — typing message...${C.reset}`);
    await textarea.fill(MESSAGE);
    await page.keyboard.press('Enter');
    console.log(`${C.green}✓ message sent${C.reset}\n`);
  } catch (err) {
    console.log(`${C.yellow}could not find/type into composer: ${(err as Error).message}${C.reset}`);
    // Take a screenshot to debug
    await page.screenshot({ path: join(REPO, '.tmp', 'arm-chat-debug.png') }).catch(() => {});
    console.log(`${C.gray}screenshot → .tmp/arm-chat-debug.png${C.reset}`);
  }

  // Wait for response + capture
  console.log(`\n${C.gray}capturing for ${DURATION}s (waiting for agent response)...${C.reset}\n`);
  await page.waitForTimeout(DURATION * 1000);

  // Dump ring
  try {
    const ring = await page.evaluate(() => (window as any)._pulseTrace ?? []);
    if (ring.length) {
      console.log(`\n${C.bold}── app ring: ${ring.length} events ──${C.reset}`);
      for (const e of ring) appendFileSync(OUT_FILE, JSON.stringify({ ...e, source: 'ring' }) + '\n');
    }
  } catch { /* ignore */ }

  // Summary
  console.log(`\n${C.bold}── summary: ${count} events ──${C.reset}`);
  for (const [evt, n] of [...byEvt.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(EVT_COLOR[evt] ?? C.reset)}${evt.padEnd(22)}${C.reset} ${String(n).padStart(6)}`);
  }
  console.log(`${C.gray}full log: ${OUT_FILE}${C.reset}`);

  await ctx.close();
}

main().catch((err) => { console.error(`${C.red}fatal:${C.reset}`, err); process.exit(1); });
