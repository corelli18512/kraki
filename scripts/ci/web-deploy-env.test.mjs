import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = name => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const values = (text, name) => [...text.matchAll(new RegExp(`\\n\\s+${name}: (.+)`, 'g'))].map(match => match[1]);

test('CI runs the web tests with the VITE_* values Deploy Web builds and tests with', () => {
  const ci = workflow('ci.yml');
  const deploy = workflow('deploy-web.yml');
  const job = ci.split('\n  test-typescript:\n')[1].split(/\n  [a-z-]+:\n/)[0];
  const step = job.split('\n      - name: Web tests with the deploy build env\n')[1];
  assert.ok(step, 'test-typescript has the deploy-env web step');
  assert.ok(job.indexOf('run: pnpm validate') < job.indexOf('Web tests with the deploy build env'), 'after the build');
  assert.match(step, /\n {8}run: pnpm --filter @kraki\/arm-web test(\n|$)/);
  // Deploy Web (beta and production) tests the same package.
  assert.equal(deploy.match(/\n {10}pnpm --filter @kraki\/arm-web test\n/g)?.length, 2);
  for (const name of ['VITE_WS_URL', 'VITE_IOS_APP_STORE_URL']) {
    const deployed = values(deploy, name);
    assert.equal(deployed.length, 2, `${name} in beta and production`);
    assert.equal(new Set(deployed).size, 1, `${name} is the same for beta and production`);
    assert.deepEqual(values(step, name), [deployed[0]], name);
  }
});
