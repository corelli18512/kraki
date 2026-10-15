#!/usr/bin/env node
/** One build identity shared by native apps, SEA binaries and npm packages. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'corelli18512/kraki';
const workflows = new Set(['.github/workflows/release.yml', '.github/workflows/ios-testflight.yml', '.github/workflows/windows-release.yml']);

export function createBuildInfo({ component, version, env = process.env, cwd = process.cwd(), commit } = {}) {
  if (!component || !version) throw new Error('Build component and version are required');
  const channel = env.KRAKI_BUILD_CHANNEL || 'local';
  if (!['local', 'ci', 'release'].includes(channel)) throw new Error('Invalid build channel');
  if (env.KRAKI_BUILD_NUMBER && !/^[1-9][0-9]*$/.test(env.KRAKI_BUILD_NUMBER)) throw new Error('Invalid build number');
  const base = { schemaVersion: 1, component, version, channel,
    ...(env.KRAKI_BUILD_NUMBER ? { buildNumber: env.KRAKI_BUILD_NUMBER } : {}),
  };
  // Never inherit a random developer/CI environment as an official identity.
  if (channel === 'local') return base;
  const sourceCommit = commit ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || sourceCommit !== env.GITHUB_SHA) {
    throw new Error('Build source must match the workflow commit. Dispatch on the release tag, not another branch.');
  }
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== repository) throw new Error('Unexpected build repository/runner');
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    if (!/^[1-9][0-9]*$/.test(env[key] || '')) throw new Error(`Missing or invalid ${key}`);
  }
  const workflow = env.GITHUB_WORKFLOW_REF?.split('@')[0]?.replace(`${repository}/`, '');
  if (!workflows.has(workflow)) throw new Error('Unexpected release workflow');
  const ref = env.GITHUB_REF || '';
  const validRef = /^refs\/(heads|tags)\/[\w./-]+$/.test(ref)
    || (channel === 'ci' && /^refs\/pull\/[1-9][0-9]*\/merge$/.test(ref));
  if (!validRef || ref.trim() !== ref) throw new Error('Invalid build ref');
  const runURL = `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  return {
    ...base, repository, commit: sourceCommit, ref: env.GITHUB_REF, workflow,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    runURL, sourceURL: `https://github.com/${repository}/commit/${sourceCommit}`,
    provenanceURL: `${runURL}#summary`,
  };
}

export function writeBuildInfo(path, info) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, component, versionOrPackage] = process.argv.slice(2);
  if (!output || !component || !versionOrPackage) throw new Error('Usage: build-info.mjs OUTPUT COMPONENT VERSION_OR_PACKAGE_JSON');
  const version = versionOrPackage.endsWith('package.json')
    ? JSON.parse(readFileSync(versionOrPackage, 'utf8')).version : versionOrPackage;
  writeBuildInfo(output, createBuildInfo({ component, version }));
}
