// Isolated real WebSocket peer. No production identities, services or payloads.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import readline from 'node:readline';
const require = createRequire(new URL('../../packages/head/package.json', import.meta.url));
const { WebSocketServer, WebSocket } = require('ws');
const { Endpoint, StreamSet } = require('@coinfra/pulse');
const server = createServer();
const wss = new WebSocketServer({ noServer: true, autoPong: false });
const counts = new Map(), sockets = new Set();
server.on('upgrade', (req, socket, head) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  const mode = req.url.slice(1), number = (counts.get(mode) || 0) + 1;
  counts.set(mode, number);
  if (mode === 'connect-timeout' && number === 1) return; // no HTTP upgrade
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, mode, number));
});
wss.on('connection', (ws, mode, number) => {
  const streams = new StreamSet([new Endpoint({epoch:`${mode}:live`,streamId:0}),new Endpoint({epoch:`${mode}:bulk`,streamId:1})]);
  let started = false, fragmenting = false, pending = [], timer, fragmentTimer;
  const send = text => { if (ws.readyState !== WebSocket.OPEN) return; if (fragmenting) pending.push(text); else ws.send(text); };
  const effects = es => { for (const e of es) if(e.t === 'transmit') send(JSON.stringify({pulse:Buffer.from(e.bytes).toString('base64')})); };
  const fragment = (text, ms, done) => {
    fragmenting = true; const bytes = Buffer.from(text), size = Math.ceil(bytes.length/(ms/100)); let offset=0;
    const step = () => {
      if(ws.readyState!==WebSocket.OPEN)return;
      const end=Math.min(offset+size,bytes.length),fin=end===bytes.length;
      ws.send(bytes.subarray(offset,end),{binary:false,fin});offset=end;
      if(fin){fragmenting=false;for(const p of pending)send(p);pending=[];done?.();}
      else fragmentTimer=setTimeout(step,100);
    };step();
  };
  const silent = () => number===1 && ['stall','half-open'].includes(mode);
  const start = () => {
    started=true;effects(streams.onConnected(Date.now()));
    if(!silent())timer=setInterval(()=>effects(streams.onTick(Date.now())),1000);
    if(mode==='slow-bulk' && number===1) {
      setTimeout(()=>{
        const es=streams.send(1,Buffer.alloc(2*1024*1024,65),{durable:false}).effects;
        for(const e of es)if(e.t==='transmit')fragment(JSON.stringify({pulse:Buffer.from(e.bytes).toString('base64')}),48000);
      },500);
    }
  };
  ws.on('ping', data => { if(!(mode==='half-open' && number===1))ws.pong(data); });
  ws.on('message', raw => {
    const msg=JSON.parse(raw.toString());
    if(msg.type==='auth') {
      if(mode==='auth-timeout' && number===1)return;
      const auth=JSON.stringify({type:'auth_ok',padding:mode==='slow-auth'?'x'.repeat(200*1024):''});
      if(mode==='slow-auth')fragment(auth,8000,start);else {send(auth);start();}
    } else if(msg.pulse && started && !silent()) effects(streams.onBytes(Buffer.from(msg.pulse,'base64'),Date.now()));
    // Native pong, not JSON pong, is the liveness proof under test.
  });
  ws.on('error',()=>{});
  ws.on('close',()=>{clearInterval(timer);clearTimeout(fragmentTimer);});
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
readline.createInterface({input:process.stdin}).on('line',()=>{
 console.log(JSON.stringify({connections:Object.fromEntries(counts)}));
 for(const socket of sockets)socket.destroy();wss.close();server.close(()=>process.exit(0));
});
