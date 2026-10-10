/**
 * POC: measure which Kraki region is fastest from this machine.
 *
 *   pnpm --filter @kraki/tentacle exec tsx scripts/region-latency-poc.ts [--direct] [--rounds N] [--api URL]
 *
 * Fetches the live region list from the main server, then pings every region
 * over a real WebSocket (through the system/env proxy unless --direct).
 * Read-only: no sign-in, no account changes.
 */
import { applyProcessProxy } from '../src/proxy.js';
import { probeRegions } from '../src/region-probe.js';

const args = process.argv.slice(2);
const direct = args.includes('--direct');
const roundsIdx = args.indexOf('--rounds');
const rounds = roundsIdx >= 0 ? Number(args[roundsIdx + 1]) : 3;
const apiIdx = args.indexOf('--api');
const api = apiIdx >= 0 ? args[apiIdx + 1] : (process.env.KRAKI_API_URL ?? 'https://relay.kraki.chat');

if (!direct) applyProcessProxy();

const picks: string[] = [];
for (let round = 1; round <= rounds; round++) {
  const r = await probeRegions(api, { direct });
  picks.push(r.best ?? '-');
  const rows = r.measurements.map((m) =>
    `${m.code.padEnd(8)} ${m.medianRttMs !== undefined ? `${String(m.medianRttMs).padStart(7)} ms rtt` : `   ${m.error}`.padEnd(14)}`
    + `  connect ${m.connectMs ?? '-'} ms  samples [${m.samplesMs.join(', ')}]${m.proxied ? '  (via proxy)' : ''}`);
  console.log(`round ${round}: best=${r.best ?? 'none'}  list v${r.listVersion}  took ${r.totalMs} ms`);
  for (const row of rows) console.log(`  ${row}`);
}
console.log(JSON.stringify({ mode: direct ? 'direct' : 'proxy-aware', picks }));
