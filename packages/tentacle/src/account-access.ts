/** Product policy: signing in to the account is sufficient to use a computer.
 * Pairing is retained as a wire/key compatibility mechanism, not an access gate.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrustStore } from './trust-store.js';
import { createLogger } from './logger.js';

/** Retire a previously enabled pairing-only policy without deleting keys, pins
 * or replay state. Preserve the old policy for audit, never restore it silently.
 * A write failure fails startup rather than reporting a migration we didn't save.
 */
export function restoreAccountAccess(store: TrustStore): void {
  const logger = createLogger('account-access');
  if (process.env.KRAKI_DEVICE_TRUST === 'enforce' || process.env.KRAKI_DEVICE_TRUST === '1'
    || process.env.KRAKI_FRESH_INSTALL_ENFORCE === '1') {
    logger.warn({}, 'Pairing-only access has been retired; legacy enforcement environment settings are ignored');
  }
  if (!store.enforced) return;
  if (store.dir) {
    const policy = join(store.dir, 'policy.json');
    const backup = join(store.dir, 'policy.pairing-only.json');
    if (existsSync(policy) && !existsSync(backup)) {
      try { writeFileSync(backup, readFileSync(policy), { mode: 0o600, flag: 'wx' }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  store.setPolicy({ enforce: false });
  logger.warn({}, 'Restored account-based access: signed-in devices can connect without pairing; existing encryption keys are unchanged');
}
