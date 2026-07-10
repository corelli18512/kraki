/**
 * arm-prod-newsession — create a NEW DeepSeek flash session via the prod arm UI,
 * send a prompt, and capture the full pulse trace.
 *
 * Usage: pnpm exec tsx scripts/arm-prod-newsession.ts
 */
import { createRequire } from 'node:module';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Evt = { t: number; wallMs: number; comp: string; evt: string; [k: string]: unknown };
const REPO = resolve(__dirname, '..');
const pwReq = createRequire(join(REPO, 'packages', 'arm', 'web', 'package.json'));
const { chromium } = pwReq('playwright') as typeof import('playwright');

const PROFILE_DIR = join(REPO, '.tmp', 'arm-pw-profile');
const OUT_FILE = join(REPO, '.tmp', 'arm-newsession.jsonl');
const APP_URL = 'https://app.kraki.chat';
const RELAY = 'wss://cn.relay.kraki.chat';
const PROMPT = 'What is 7 multiplied by 13? Reply with just the number.';

mkdirSync(join(REPO, '.tmp'), { recursive: true });

const C = { reset: '\x1b[0m', dim: '\x1b[2m', gray: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31f', magenta: '\x1b[35m', blue: '\x1b[34m', bold: '\x1b[1m' };
C.red = '\x1b[31m';
const EVT_COLOR: Record<string, string> = {
  'WS-OPEN': C.green, 'WS-CLOSE': C.red, 'WS-ERROR': C.red, 'WS-SEND': C.blue, 'WS-MESSAGE': C.cyan,
  'PULSE-SEND': C.magenta, 'PULSE-TX': C.magenta, 'PULSE-RX': C.cyan, 'PULSE-DELIVER': C.green,
  'APP-DECRYPT': C.green, 'APP-AGENT-MESSAGE': C.green + C.bold, 'APP-USER-MESSAGE-ECHO': C.cyan,
  'CONSOLE': C.gray, 'PAGEERROR': C.bold + C.red,
};
let count = 0, firstWall = 0;
const byEvt = new Map<string, number>();
function ts(w: number) { return new Date(w).toISOString().slice(11, 23); }
function handle(e: Evt) {
  if (!firstWall) firstWall = e.wallMs;
  count++; byEvt.set(e.evt, (byEvt.get(e.evt) ?? 0) + 1);
  appendFileSync(OUT_FILE, JSON.stringify(e) + '\n');
  const col = EVT_COLOR[e.evt] ?? C.reset;
  const rel = (e.wallMs - firstWall).toString().padStart(7);
  const core = `${C.gray}${ts(e.wallMs)}${C.reset} ${C.dim}+${rel}ms${C.reset} ${col}${e.evt.padEnd(20)}${C.reset}`;
  const rest: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (['t', 'wallMs', 'comp', 'evt'].includes(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    const sv = typeof v === 'string' ? v : JSON.stringify(v);
    rest.push(`${C.dim}${k}${C.reset}=${sv.length > 90 ? sv.slice(0, 87) + '...' : sv}`);
  }
  process.stdout.write(`${core} ${rest.join(' ')}\n`);
}
const INIT = `(()=>{try{localStorage.setItem('kraki_pulse_trace','1')}catch{}
const cap=20000;window._wsTrace=[];function push(e){window._wsTrace.push(e);if(window._wsTrace.length>cap)window._wsTrace.splice(0,cap);if(typeof window.__pwTrace==='function')try{window.__pwTrace(e)}catch{}}
function now(){return{t:performance.now(),wallMs:Date.now()}}const O=window.WebSocket;
const W=function(u,p){const w=p!==undefined?new O(u,p):new O(u);push({comp:'arm',evt:'WS-OPEN',url:String(u),...now()});
w.addEventListener('open',()=>push({comp:'arm',evt:'WS-OPEN',url:String(u),...now()}));
w.addEventListener('close',ev=>push({comp:'arm',evt:'WS-CLOSE',url:String(u),code:ev.code,reason:ev.reason||'',...now()}));
w.addEventListener('error',()=>push({comp:'arm',evt:'WS-ERROR',url:String(u),readyState:w.readyState,...now()}));
w.addEventListener('message',ev=>{let len=0,type=null,hp=false;try{const s=typeof ev.data==='string'?ev.data:'';len=s.length;if(s&&s.charCodeAt(0)===123){const j=JSON.parse(s);type=j.type??null;hp=typeof j.pulse==='string'}}catch{}push({comp:'arm',evt:'WS-MESSAGE',url:String(u),len,type,hasPulse:hp,...now()})});
const os=w.send.bind(w);w.send=function(d){push({comp:'arm',evt:'WS-SEND',url:String(u),len:typeof d==='string'?d.length:0,...now()});return os(d)};return w};
W.prototype=O.prototype;W.CONNECTING=O.CONNECTING;W.OPEN=O.OPEN;W.CLOSING=O.CLOSING;W.CLOSED=O.CLOSED;window.WebSocket=W;})();`;

async function main() {
  console.log(`${C.bold}arm-prod-newsession${C.reset}  ${C.gray}prompt="${PROMPT}"${C.reset}\n`);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, viewport: { width: 1280, height: 900 }, proxy: { server: 'socks5://127.0.0.1:1080' }, args: ['--disable-blink-features=AutomationControlled'] });
  await ctx.exposeFunction('__pwTrace', (e: Evt) => handle(e));
  await ctx.addInitScript(INIT);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${APP_URL}?relay=${encodeURIComponent(RELAY)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log(`${C.dim}waiting for auth + sessions...${C.reset}`);
  await page.waitForTimeout(5000);

  // Click "New Session" button
  console.log(`${C.dim}opening new session dialog...${C.reset}`);
  const newBtn = page.getByRole('button', { name: /new session|new chat/i }).first();
  await newBtn.waitFor({ timeout: 8000 }).catch(() => {});
  await newBtn.click().catch(() => {});
  await page.waitForTimeout(1000);

  // Work inside the dialog
  const dialog = page.locator('[role="dialog"]');

  // Select pi agent (button text is the agent id)
  const piBtn = dialog.getByText('pi', { exact: true });
  if (await piBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await piBtn.click();
    console.log(`${C.green}selected pi agent${C.reset}`);
    await page.waitForTimeout(500);
  }

  // Select deepseek-v4-flash model
  console.log(`${C.dim}selecting model...${C.reset}`);
  const flashBtn = dialog.getByText(/deepseek.*flash/i).first();
  if (await flashBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await flashBtn.click();
    console.log(`${C.green}selected deepseek-v4-flash${C.reset}`);
  } else {
    console.log(`${C.yellow}flash model not visible, listing available models...${C.reset}`);
    const texts = await dialog.locator('button').allTextContents().catch(() => []);
    console.log(`${C.gray}dialog buttons: ${texts.join(', ')}${C.reset}`);
  }

  // Click Create/Start button in the dialog
  const createBtn = dialog.getByRole('button', { name: /create|start/i }).last();
  await createBtn.waitFor({ timeout: 3000 }).catch(() => {});
  await createBtn.click().catch(() => {});
  console.log(`${C.green}✓ session create submitted${C.reset}`);
  await page.waitForTimeout(3000);

  // Now type the prompt into the chat composer
  try {
    const ta = page.locator('textarea').first();
    await ta.waitFor({ state: 'visible', timeout: 8000 });
    console.log(`${C.green}typing prompt...${C.reset}`);
    await ta.fill(PROMPT);
    await page.keyboard.press('Enter');
    console.log(`${C.green}✓ prompt sent${C.reset}\n`);
  } catch (e) {
    console.log(`${C.yellow}could not type prompt: ${(e as Error).message}${C.reset}\n`);
  }
  console.log(`${C.gray}capturing for 90s (waiting for agent)...${C.reset}\n`);
  await page.waitForTimeout(90000);

  // Dump ring + summary
  try {
    const ring = await page.evaluate(() => (window as any)._pulseTrace ?? []);
    for (const e of ring) appendFileSync(OUT_FILE, JSON.stringify({ ...e, source: 'ring' }) + '\n');
    console.log(`\n${C.bold}── ring: ${ring.length} | live: ${count} ──${C.reset}`);
  } catch { /* */ }
  console.log(`\n${C.bold}── summary: ${count} events ──${C.reset}`);
  for (const [evt, n] of [...byEvt.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${(EVT_COLOR[evt] ?? C.reset)}${evt.padEnd(22)}${C.reset} ${String(n).padStart(6)}`);
  console.log(`${C.gray}full log: ${OUT_FILE}${C.reset}`);
  await ctx.close();
}
main().catch(e => { console.error(`${C.red}fatal:${C.reset}`, e); process.exit(1); });
