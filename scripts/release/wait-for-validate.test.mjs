import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECK_NAME, validateCheckRuns, validateVerdict, waitForValidate } from './wait-for-validate.mjs';

const repo = 'corelli18512/kraki';
const sha = 'e005a16c6b6a577b6831d636be3715afd9ce5d33';
const run = (id, status = 'completed', conclusion = 'success', name = CHECK_NAME) => ({ id, name, status, conclusion });

/** A fake check-runs API: `pages(url)` returns the body for each request; every URL is recorded. */
function fakeApi(pages) {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer t');
    const body = pages(url, urls.length);
    if (body instanceof Error) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { urls, fetchImpl };
}
const quiet = () => {};
const noSleep = async () => {};

test('asks for the Validate check run by name, 100 per page', async () => {
  const api = fakeApi(() => ({ total_count: 1, check_runs: [run(7)] }));
  assert.deepEqual(await validateCheckRuns({ repo, sha, token: 't', fetchImpl: api.fetchImpl }), [run(7)]);
  assert.deepEqual(api.urls, [`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?check_name=Validate&per_page=100&page=1`]);
});

test('follows every page', async () => {
  const page = n => Array.from({ length: 100 }, (_, i) => run(n * 1000 + i));
  const api = fakeApi(url => {
    const n = Number(new URL(url).searchParams.get('page'));
    return { total_count: 201, check_runs: n <= 2 ? page(n) : [run(9999)] };
  });
  const runs = await validateCheckRuns({ repo, sha, token: 't', fetchImpl: api.fetchImpl });
  assert.equal(runs.length, 201);
  assert.equal(api.urls.length, 3);
  // Stops once total_count is reached, even on a full page.
  const exact = fakeApi(() => ({ total_count: 100, check_runs: page(1) }));
  await validateCheckRuns({ repo, sha, token: 't', fetchImpl: exact.fetchImpl });
  assert.equal(exact.urls.length, 1);
});

test('the newest Validate run decides', () => {
  assert.equal(validateVerdict([]).state, 'pending');
  assert.deepEqual(validateVerdict([run(1, 'in_progress', null)]), { state: 'pending', detail: 'in_progress' });
  assert.equal(validateVerdict([run(1, 'queued', null)]).state, 'pending');
  assert.equal(validateVerdict([run(1)]).state, 'success');
  // A re-run of a failed Validate that passed.
  assert.equal(validateVerdict([run(5), run(3, 'completed', 'failure')]).state, 'success');
  // A newer failed run is not hidden by an older pass, in any order.
  assert.deepEqual(validateVerdict([run(3), run(5, 'completed', 'failure')]), { state: 'failure', detail: 'failure' });
  // A re-run still going: wait for it.
  assert.equal(validateVerdict([run(3), run(5, 'in_progress', null)]).state, 'pending');
  for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'neutral', 'skipped']) {
    assert.deepEqual(validateVerdict([run(1, 'completed', conclusion)]), { state: 'failure', detail: conclusion });
  }
  // Other check names never count.
  assert.equal(validateVerdict([run(9, 'completed', 'success', 'Validate (other)')]).state, 'pending');
});

test('waits while Validate is pending, then passes', async () => {
  const states = [[], [run(1, 'queued', null)], [run(1, 'in_progress', null)], [run(1)]];
  const api = fakeApi((_, n) => ({ total_count: states[n - 1].length, check_runs: states[n - 1] }));
  const sleeps = [];
  const passed = await waitForValidate({
    repo, sha, token: 't', fetchImpl: api.fetchImpl, sleep: async ms => sleeps.push(ms), log: quiet,
  });
  assert.equal(passed, true);
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
});

test('refuses at once when Validate failed', async () => {
  const api = fakeApi(() => ({ total_count: 1, check_runs: [run(1, 'completed', 'failure')] }));
  const lines = [];
  assert.equal(await waitForValidate({ repo, sha, token: 't', fetchImpl: api.fetchImpl, sleep: noSleep, log: l => lines.push(l) }), false);
  assert.equal(api.urls.length, 1);
  assert.match(lines.at(-1), /CI status is failure\. Refusing to release\./);
});

test('retries GitHub API errors, and refuses when Validate never passes in time', async () => {
  const flaky = fakeApi((_, n) => (n === 1 ? new Error('502') : { total_count: 1, check_runs: [run(1)] }));
  assert.equal(await waitForValidate({ repo, sha, token: 't', fetchImpl: flaky.fetchImpl, sleep: noSleep, log: quiet }), true);
  assert.equal(flaky.urls.length, 2);

  const never = fakeApi(() => ({ total_count: 0, check_runs: [] }));
  const lines = [];
  assert.equal(await waitForValidate({
    repo, sha, token: 't', attempts: 4, fetchImpl: never.fetchImpl, sleep: noSleep, log: l => lines.push(l),
  }), false);
  assert.equal(never.urls.length, 4);
  assert.match(lines.at(-1), /did not pass within .* minutes\. Refusing to release\./);
});

test('Validate past the first 30 check runs of a busy commit still counts', async () => {
  // e005a16c had 58 check runs with Validate on the second unfiltered page;
  // the name filter returns it on the first.
  const api = fakeApi(url => (new URL(url).searchParams.get('check_name') === 'Validate'
    ? { total_count: 1, check_runs: [run(58)] }
    : { total_count: 58, check_runs: Array.from({ length: 30 }, (_, i) => run(i, 'completed', 'success', `job ${i}`)) }));
  assert.equal(await waitForValidate({ repo, sha, token: 't', fetchImpl: api.fetchImpl, sleep: noSleep, log: quiet }), true);
});

const workflow = name => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('release.yml and windows-release.yml gate on this script, not on the first page of check runs', () => {
  const release = workflow('release.yml');
  const gate = release.split('\n      - name: Ensure CI passed for this commit\n')[1].split('\n      - name: ')[0];
  assert.match(gate, /run: node scripts\/release\/wait-for-validate\.mjs "\$RELEASE_SHA"/);
  assert.match(gate, /GH_TOKEN: \$\{\{ github\.token \}\}/);

  const windows = workflow('windows-release.yml');
  const identity = windows.split('\n      - name: Validate release identity and CI\n')[1].split('\n      - name: ')[0];
  assert.match(identity, /node scripts\/release\/wait-for-validate\.mjs "\$GITHUB_SHA"/);
  for (const text of [release, windows]) assert.doesNotMatch(text, /check-runs/);
});
