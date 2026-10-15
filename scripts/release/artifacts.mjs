#!/usr/bin/env node
/** Produce a durable manifest and fail closed when validating release files. */
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBuildInfo } from './build-info.mjs';

export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function createManifest(dir, build) {
  const files = readdirSync(dir).sort();
  if (!files.length) throw new Error('No release artifacts');
  const artifacts = [];
  for (const name of files) {
    if (!/^[\w.-]+$/.test(name) || !lstatSync(join(dir, name)).isFile()) throw new Error(`Unsafe artifact: ${name}`);
    if (['release-manifest.json', 'SHA256SUMS.txt', 'provenance.json'].includes(name)) throw new Error(`Output directory is not fresh: ${name}`);
    artifacts.push({ name, sha256: await digest(join(dir, name)), size: lstatSync(join(dir, name)).size });
  }
  return { schemaVersion: 1, build, artifacts };
}

export async function checkManifest(dir, manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('Invalid manifest');
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    if (!/^[\w.-]+$/.test(artifact.name) || seen.has(artifact.name)) throw new Error('Unsafe/duplicate artifact name');
    seen.add(artifact.name);
    const path = join(dir, artifact.name);
    if (!lstatSync(path).isFile() || await digest(path) !== artifact.sha256 || lstatSync(path).size !== artifact.size) {
      throw new Error(`Artifact mismatch: ${artifact.name}`);
    }
  }
}

export function verificationArgs(file, bundle, env = process.env) {
  if (env.KRAKI_BUILD_CHANNEL !== 'release') throw new Error('Verification requires an explicit release identity');
  const workflow = env.GITHUB_WORKFLOW_REF?.split('@')[0];
  // Reuse the same strict identity validation as the embedded metadata.
  createBuildInfo({ component: 'verification', version: '1', env, commit: env.GITHUB_SHA });
  return ['attestation', 'verify', file, '--repo', env.GITHUB_REPOSITORY,
    '--signer-workflow', workflow, '--source-digest', env.GITHUB_SHA,
    '--source-ref', env.GITHUB_REF, '--deny-self-hosted-runners',
    ...(bundle ? ['--bundle', bundle] : [])];
}

export function checkVerifiedIdentity(results, env = process.env) {
  const run = `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const signer = `https://github.com/${env.GITHUB_WORKFLOW_REF}`;
  if (!Array.isArray(results) || !results.some(result => {
    const certificate = result.verificationResult?.signature?.certificate;
    return certificate?.runInvocationURI === run && certificate?.buildSignerURI === signer;
  })) throw new Error('Verified proof does not belong to this exact workflow run/attempt');
}

async function main() {
  const [command, dir, ...args] = process.argv.slice(2);
  if (command === 'manifest') {
    const [component, version] = args;
    const manifest = await createManifest(dir, createBuildInfo({ component, version }));
    writeFileSync(join(dir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const files = [...manifest.artifacts.map(a => a.name), 'release-manifest.json'];
    const sums = await Promise.all(files.map(async name => `${await digest(join(dir, name))}  ${name}`));
    writeFileSync(join(dir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  } else if (command === 'verify') {
    const manifest = JSON.parse(readFileSync(join(dir, 'release-manifest.json'), 'utf8'));
    await checkManifest(dir, manifest);
    for (const file of ['release-manifest.json', 'SHA256SUMS.txt', ...manifest.artifacts.map(a => a.name)]) {
      const output = execFileSync('gh', [...verificationArgs(join(dir, file), args[0]), '--format', 'json'],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      checkVerifiedIdentity(JSON.parse(output));
      console.log(`Verified ${file} (source, workflow and run/attempt)`);
    }
  } else {
    throw new Error('Usage: artifacts.mjs manifest DIR COMPONENT VERSION | verify DIR [BUNDLE]');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
