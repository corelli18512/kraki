/** `kraki devices` — the apps this computer takes commands from (device trust). */

import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safetyCode } from '@kraki/crypto';
import { getKrakiHome } from '../config.js';
import { getTrustDir, TrustStore } from '../trust-store.js';
import { gracefulExit } from './exit.js';

const HELP = `
  ${chalk.bold('kraki devices')}                 Apps that can control this computer
  ${chalk.bold('kraki devices revoke <id|name>')} Stop trusting an app (it must scan a new code)
  ${chalk.bold('kraki devices enforce on|off')}   Only paired apps may connect (recommended: on)

  Add --json for machine-readable output. Pair an app with ${chalk.bold('kraki connect')}.
  Compare the safety code with the one your app shows for this computer.
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
  const envMode = process.env.KRAKI_DEVICE_TRUST;
  const store = new TrustStore(getTrustDir());

  if (sub === 'list') {
    const devices = store.list();
    const code = computerSafetyCode();
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, enforced: store.enforced, safetyCode: code, devices }) + '\n');
      return;
    }
    console.log('');
    console.log(`  ${chalk.bold('Safety code of this computer')}  ${code ?? chalk.dim('(not set up yet)')}`);
    console.log(`  ${chalk.bold('Only paired devices')}           ${store.enforced ? chalk.green('on') : chalk.yellow('off — any device on your account can connect')}`);
    if (envMode) console.log(chalk.dim(`  (KRAKI_DEVICE_TRUST=${envMode} overrides this for the running daemon)`));
    console.log('');
    if (devices.length === 0) {
      console.log(chalk.dim('  No paired apps. Run `kraki connect` and scan the code with your phone.'));
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
    if (json) process.stdout.write(JSON.stringify({ ok: true, revoked: matches[0]!.id, enforced: store.enforced }) + '\n');
    else if (store.enforced) console.log(chalk.green(`  ${name} can no longer control this computer.`));
    else console.log(chalk.yellow(`  ${name} is no longer paired. "Only paired devices" is off, so it can still connect as an unpaired device — run \`kraki devices enforce on\` to block it.`));
    return;
  }

  if (sub === 'enforce') {
    const value = positional[1];
    if (value !== 'on' && value !== 'off') return fail('Usage: kraki devices enforce on|off', json);
    store.setPolicy({ enforce: value === 'on' });
    if (json) process.stdout.write(JSON.stringify({ ok: true, enforced: value === 'on' }) + '\n');
    else console.log(value === 'on'
      ? chalk.green('  Only paired apps can connect to this computer now.')
      : chalk.yellow('  Any app signed in to your account can connect to this computer now.'));
    return;
  }

  fail(`Unknown subcommand "${sub}". Run \`kraki devices --help\`.`, json);
}
