// Restart the isolated local-stack daemon (KRAKI_HOME=.tmp/kraki-local only).
import { join, resolve } from 'node:path';
import { loadConfig } from '../../packages/tentacle/src/config.js';
import { startDaemon } from '../../packages/tentacle/src/daemon.js';

async function main() {
  const home = resolve(process.env.KRAKI_HOME ?? '');
  if (home !== resolve('.tmp/kraki-local')) throw new Error(`refusing: KRAKI_HOME=${home}`);
  const config = loadConfig();
  if (!config) throw new Error('no local config');
  const pid = await startDaemon(config, join(process.cwd(), 'packages/tentacle/src/cli.ts'));
  console.log('restarted local daemon pid', pid);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
