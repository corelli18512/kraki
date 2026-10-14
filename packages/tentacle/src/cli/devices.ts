/** `kraki devices` — retained encryption relationships, not an access allowlist. */

import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safetyCode } from '@kraki/crypto';
import { getKrakiHome } from '../config.js';
import { getTrustDir, TrustStore } from '../trust-store.js';
import { gracefulExit } from './exit.js';

const HELP = `
  ${chalk.bold('kraki devices')}                 Saved encryption connections
  ${chalk.bold('kraki devices revoke <id|name>')} Forget a saved connection (does not sign it out)

  Any device signed in to your account can connect; pairing is not required.
  To remove account access, remove the device in the app's Devices settings.
  Add --json for machine-readable output.
`;

function computerSafetyCode(): string | null {
  const path = join(getKrakiHome(), 'keys', 'public-identity.json');
  if (!existsSync(path)) return null;
  try {
    const { identityKey } = JSON.parse(readFileSync(path, 'utf8')) as { identityKey?: string };
    return identityKey ? safetyCode(identityKey) : null;
  } catch {
    return null;
  }
}

function fail(message: string, json: boolean): void {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  else console.log(chalk.red(`  ${message}`));
  gracefulExit(1);
}

export function cmdDevices(args: string[]): void {
  const json = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const sub = positional[0] ?? 'list';
  if (args.includes('--help') || args.includes('-h') || sub === 'help') {
    console.log(HELP);
    return;
  }
  const store = new TrustStore(getTrustDir());

  if (sub === 'list') {
    const devices = store.list();
    const code = computerSafetyCode();
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, enforced: false, access: 'account', safetyCode: code, devices }) + '\n');
      return;
    }
    console.log('');
    console.log(`  ${chalk.bold('Safety code of this computer')}  ${code ?? chalk.dim('(not set up yet)')}`);
    console.log(`  ${chalk.bold('Access')}                        Any device signed in to your account`);
    console.log('');
    if (devices.length === 0) {
      console.log(chalk.dim('  No saved encryption connections. Sign in on any device to use Kraki.'));
    } else {
      for (const d of devices) {
        const via = d.via === 'local' ? 'this computer' : 'QR code';
        console.log(`  ${chalk.bold(d.name ?? d.id)}  ${chalk.dim(d.id)}  ${chalk.dim(`paired ${d.pairedAt.slice(0, 10)} via ${via}`)}`);
      }
    }
    console.log('');
    return;
  }

  if (sub === 'revoke') {
    const target = positional[1];
    if (!target) return fail('Usage: kraki devices revoke <id|name>', json);
    const matches = store.list().filter((d) => d.id === target || d.name === target);
    if (matches.length !== 1) {
      return fail(matches.length === 0 ? `No paired app "${target}".` : `"${target}" matches several apps; use the id.`, json);
    }
    store.remove(matches[0]!.id);
    const name = matches[0]!.name ?? matches[0]!.id;
    if (json) process.stdout.write(JSON.stringify({ ok: true, revoked: matches[0]!.id, enforced: false }) + '\n');
    else console.log(chalk.yellow(`  Forgot the saved connection for ${name}. Account access is unchanged; remove the device in the app to sign it out.`));
    return;
  }

  if (sub === 'enforce') {
    const value = positional[1];
    if (value !== 'on' && value !== 'off') return fail('Usage: kraki devices enforce on|off', json);
    if (value === 'on') return fail('Pairing-only access has been retired. Any device signed in to your account can connect.', json);
    // Keep `off` usable by older scripts; `on` must never recreate the gate.
    store.setPolicy({ enforce: false });
    if (json) process.stdout.write(JSON.stringify({ ok: true, enforced: false }) + '\n');
    else console.log('  Any app signed in to your account can connect to this computer.');
    return;
  }

  fail(`Unknown subcommand "${sub}". Run \`kraki devices --help\`.`, json);
}
