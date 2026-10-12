// Stop the isolated local-stack daemon (KRAKI_HOME=.tmp/kraki-local only), the
// same way the CLI's stop command does (stopDaemon: supervisor first, then worker).
import { resolve } from 'node:path';
import { stopDaemon } from '../../packages/tentacle/src/daemon.js';

const home = resolve(process.env.KRAKI_HOME ?? '');
if (home !== resolve('.tmp/kraki-local')) throw new Error(`refusing: KRAKI_HOME=${home}`);
console.log('stopped:', stopDaemon());
