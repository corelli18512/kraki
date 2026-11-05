/**
 * One Kraki home serves one GitHub account at a time. Signing in with a
 * different account (Kraki for Mac's Sign Out → sign in, or `kraki setup`)
 * must not keep this computer registered as the previous account's device,
 * nor publish the previous account's sessions to the new one.
 *
 * `account.json` names the account whose identity (device id, keys, device
 * trust) and sessions are in place. When the signed-in account
 * (`config.account.login`, written by setup) differs, the daemon moves that
 * data aside to `accounts/<previous login>/` before it reads any of it, and
 * puts back what an earlier switch moved aside for the new account. Nothing
 * is deleted: signing in as the previous account again restores its device
 * and sessions. A new device id makes the relay register this computer for
 * the new account instead of authenticating the old device by challenge.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir, getKrakiHome } from './config.js';

/** Files and folders that belong to the signed-in account, not the computer. */
export const ACCOUNT_SCOPED_ENTRIES = ['device-id', 'channel.key', 'keys', 'trust', 'sessions'] as const;

const ACCOUNT_DATA_FILE = 'account.json';
const ACCOUNTS_DIR = 'accounts';

/** GitHub logins are case-insensitive. */
export function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function loginDirName(login: string): string {
  return login.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

/** The account whose identity and sessions are in place, if known. */
export function loadAccountDataOwner(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(getKrakiHome(), ACCOUNT_DATA_FILE), 'utf8')) as { login?: unknown };
    return typeof parsed.login === 'string' && parsed.login ? parsed.login : null;
  } catch {
    return null;
  }
}

function saveAccountDataOwner(login: string): void {
  writeFileSync(join(getConfigDir(), ACCOUNT_DATA_FILE), JSON.stringify({ login }) + '\n', 'utf8');
}

/**
 * Record who owns the data in place when nobody is recorded yet (installs
 * from before the record existed). Never overrides an existing owner.
 */
export function adoptAccountDataOwner(login: string): void {
  if (!login || loadAccountDataOwner()) return;
  saveAccountDataOwner(login);
}

export type AccountDataSwitch =
  | { switched: false }
  | { switched: true; from: string; to: string; restored: boolean; restoreError?: string };

/**
 * Make the data in place belong to `login`: move the previous account's
 * identity and sessions aside and restore `login`'s own, if it has any.
 * Call before anything reads the device id, keys, trust or sessions.
 */
export function switchAccountData(login: string): AccountDataSwitch {
  const owner = loadAccountDataOwner();
  if (!owner) {
    saveAccountDataOwner(login);
    return { switched: false };
  }
  if (sameLogin(owner, login)) return { switched: false };

  const home = getConfigDir();
  const accountsDir = join(home, ACCOUNTS_DIR);
  let aside = join(accountsDir, loginDirName(owner));
  // An earlier copy for this account that was never restored stays as it is.
  if (existsSync(aside)) aside = `${aside}.${Date.now()}`;
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  try {
    for (const name of ACCOUNT_SCOPED_ENTRIES) {
      const from = join(home, name);
      if (!existsSync(from)) continue;
      renameSync(from, join(aside, name));
      moved.push(name);
    }
  } catch (err) {
    // Never leave one account's data half moved: put it back and fail.
    for (const name of moved) {
      try { renameSync(join(aside, name), join(home, name)); } catch { /* left in accounts/ */ }
    }
    throw err;
  }

  // The previous account's data is safely aside: from here on the data in
  // place is `login`'s, even if restoring its own data below fails.
  saveAccountDataOwner(login);

  const own = join(accountsDir, loginDirName(login));
  let restored = false;
  let restoreError: string | undefined;
  if (existsSync(own)) {
    try {
      for (const name of ACCOUNT_SCOPED_ENTRIES) {
        const from = join(own, name);
        // Never overwrite: whatever is in place already belongs to `login`.
        if (existsSync(from) && !existsSync(join(home, name))) {
          renameSync(from, join(home, name));
          restored = true;
        }
      }
    } catch (err) {
      // What was not restored stays in accounts/<login>/; nothing is lost.
      restoreError = (err as Error).message;
    }
    try {
      if (readdirSync(own).length === 0) rmdirSync(own);
    } catch { /* leave it */ }
  }
  return { switched: true, from: owner, to: login, restored, ...(restoreError && { restoreError }) };
}
