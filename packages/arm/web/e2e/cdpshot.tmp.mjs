import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const [,, match, out] = process.argv;
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const t = list.find((x) => x.url.includes(match));
if (!t) { console.log('no target'); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const call = (method, params = {}) => new Promise((res) => { const i = ++id; ws.on('message', function h(m) { const d = JSON.parse(m); if (d.id === i) { ws.off('message', h); res(d.result ?? d.error); } }); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.on('open', r));
const ev = await call('Runtime.evaluate', { expression: 'document.readyState + " | " + document.title + " | " + (document.body?.innerText||"").slice(0,200).replace(/\\n/g," / ")', returnByValue: true });
console.log(ev?.result?.value);
const s = await call('Page.captureScreenshot', { format: 'png' });
if (s?.data) writeFileSync(out, Buffer.from(s.data, 'base64'));
ws.close(); process.exit(0);
