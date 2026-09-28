#!/usr/bin/env node
/** Conservative change routing using only git paths and Node built-ins. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function testScope(paths, full = false) {
  const scope = { typescript: full, native: full, binary: full, resilience: full, webResilience: full };
  for (const path of paths) {
    // Do not exempt arbitrary .md files: prompts/fixtures can be runtime inputs.
    if ((!path.includes('/') && path.endsWith('.md')) || path.startsWith('docs/')
      || /(^|\/)(README|CHANGELOG|MIGRATION[^/]*)\.md$/.test(path)
      || path.startsWith('.github/ISSUE_TEMPLATE/')) continue;
    if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|biome\.json|tsconfig[^/]*\.json)$/.test(path)
      || path === '.github/workflows/ci.yml' || path.startsWith('scripts/ci/')) {
      Object.keys(scope).forEach(key => { scope[key] = true; });
    } else if (path.startsWith('packages/arm/ios/') || path.startsWith('scripts/diag/')
      || path === 'scripts/ios-voice-hold-gate.sh' || path.startsWith('scripts/test-native')) {
      scope.native = true;
      scope.resilience = true;
    } else if (path.startsWith('packages/protocol/')) {
      Object.keys(scope).forEach(key => { scope[key] = true; });
    } else if (/^packages\/(crypto|tentacle)\//.test(path)) {
      scope.typescript = true;
      scope.binary = true;
      scope.resilience = true;
      scope.webResilience = true;
    } else if (/^packages\/(head|tests)\//.test(path) || path.startsWith('scripts/chaos/')) {
      // The relay path and the chaos stack itself: network-resilience scenarios.
      scope.typescript = true;
      scope.resilience = true;
      scope.webResilience = true;
    } else if (path === 'packages/arm/web/public/install.ps1' || path === 'packages/arm/web/public/install.sh') {
      scope.typescript = true;
      scope.binary = true;
    } else if (path.startsWith('packages/arm/web/')) {
      // The browser client: its own network-resilience scenarios (Linux, fast).
      scope.typescript = true;
      scope.webResilience = true;
    } else if (path.startsWith('packages/')) {
      scope.typescript = true;
    } else if (/^install\.(sh|ps1)$/.test(path) || path.startsWith('scripts/e2e/')) {
      scope.binary = true;
      scope.typescript = true;
    } else if (path.startsWith('scripts/')) {
      scope.typescript = true;
    } else if (path.startsWith('.github/workflows/')) {
      // Release/deploy workflows have their own build/smoke checks.
      continue;
    } else {
      // Unknown build/config inputs: err on the side of coverage.
      Object.keys(scope).forEach(key => { scope[key] = true; });
    }
  }
  return scope;
}

export function changedPaths(event, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  if (event.pull_request) {
    const { base, head } = event.pull_request;
    // Include both sides of cross-package moves, not just the rename destination.
    // The full PR range, not just its latest commit. Paths only, no checkout.
    return git(['diff', '--no-renames', '--name-only', '-z', `${base.sha}...${head.sha}`]).split('\0').filter(Boolean);
  }
  if (!event.before || /^0+$/.test(event.before) || !event.after) return null;
  return git(['diff', '--no-renames', '--name-only', '-z', event.before, event.after]).split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let scope;
  try {
    const full = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
    const paths = full ? [] : changedPaths(event);
    scope = testScope(paths ?? [], full || paths === null);
  } catch (error) {
    // Missing history must broaden coverage rather than silently skip tests.
    console.warn('Unable to determine changed files; running all routine checks:', error.message);
    scope = testScope([], true);
  }
  console.log(JSON.stringify(scope));
  for (const [key, value] of Object.entries(scope)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
