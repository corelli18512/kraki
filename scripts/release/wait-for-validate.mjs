#!/usr/bin/env node
/**
 * Release gate: waits until the commit's "Validate" check run (ci.yml) has
 * passed. Asks GitHub for that check run by name, every page of it: a busy
 * commit has more check runs than one unfiltered page (30) holds.
 *
 * Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/release/wait-for-validate.mjs SHA
 * Exit 0 once Validate passed; 1 when it failed or did not pass in time.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECK_NAME = 'Validate';
const PER_PAGE = 100;

/** Every Validate check run of `sha`, across pages. */
export async function validateCheckRuns({ repo, sha, token, fetchImpl = fetch }) {
  const runs = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs`
      + `?check_name=${CHECK_NAME}&per_page=${PER_PAGE}&page=${page}`;
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    const body = await res.json();
    runs.push(...body.check_runs);
    if (body.check_runs.length < PER_PAGE || runs.length >= body.total_count) return runs;
  }
}

/**
 * The newest Validate run decides (a re-run supersedes an earlier result):
 * `success`, `failure` (completed any other way) or `pending` (none yet, or
 * still queued / running).
 */
export function validateVerdict(runs) {
  const named = runs.filter(run => run.name === CHECK_NAME);
  if (!named.length) return { state: 'pending', detail: 'no Validate check run yet' };
  const newest = named.reduce((a, b) => (b.id > a.id ? b : a));
  if (newest.status !== 'completed') return { state: 'pending', detail: newest.status };
  if (newest.conclusion === 'success') return { state: 'success', detail: 'success' };
  return { state: 'failure', detail: newest.conclusion };
}

/** Polls until Validate passed (true) or failed / timed out (false). */
export async function waitForValidate({
  repo, sha, token, attempts = 30, intervalMs = 10_000, fetchImpl = fetch,
  sleep = ms => new Promise(done => setTimeout(done, ms)), log = console.log,
}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let verdict;
    try {
      verdict = validateVerdict(await validateCheckRuns({ repo, sha, token, fetchImpl }));
    } catch (error) {
      verdict = { state: 'pending', detail: `GitHub API error (${error.message})` };
    }
    if (verdict.state === 'success') {
      log(`CI passed for ${sha} (Validate).`);
      return true;
    }
    if (verdict.state === 'failure') {
      log(`CI status is ${verdict.detail}. Refusing to release.`);
      return false;
    }
    if (attempt < attempts) {
      log(`CI status: ${verdict.detail}. Waiting ${intervalMs / 1000}s... (attempt ${attempt}/${attempts})`);
      await sleep(intervalMs);
    }
  }
  log(`CI did not pass within ${(attempts * intervalMs) / 60_000} minutes. Refusing to release.`);
  return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] || '';
  const { GH_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
  if (!/^[0-9a-f]{40}$/.test(sha) || !token || !repo) {
    console.error('Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/repo wait-for-validate.mjs SHA (40 hex)');
    process.exit(2);
  }
  console.log(`Checking CI status for ${sha}...`);
  process.exit((await waitForValidate({ repo, sha, token })) ? 0 : 1);
}
