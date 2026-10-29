#!/usr/bin/env node
/**
 * Rolling dogfood releases of the CLI and Kraki for Mac (docs/dogfood.md).
 *
 * Exactly two GitHub releases, `dogfood-cli` and `dogfood-mac`, both
 * prerelease and never "latest". Every main build that changes a component
 * updates its release in place: same tag name (moved to the built commit),
 * same asset names, new title/notes. None of the automatic update/download
 * paths (CLI updater, install.sh/ps1 without KRAKI_CHANNEL, web Mac
 * download, production Sparkle appcast) look at them.
 *
 *   plan                     -> GITHUB_OUTPUT: what to build, versions, bases
 *   stamp-tentacle VERSION   -> set packages/tentacle/package.json version (CI workspace only)
 *   publish                  -> replace the dogfood release's assets, tag and notes
 *   recover                  -> undo an interrupted publish (failed or cancelled run)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPONENTS = ['cli', 'mac'];
export const DOGFOOD_TAG = { cli: 'dogfood-cli', mac: 'dogfood-mac' };
/** release.yml `target` input of each component. */
export const RELEASE_TARGET = { cli: 'tentacle', mac: 'mac' };
const FORMAL_TAG = { cli: /^v(\d+\.\d+\.\d+)$/, mac: /^mac-v(\d+\.\d+\.\d+)(?:-diag)?$/ };
/** New assets are uploaded under this prefix, verified, then swapped in. */
export const INCOMING = 'incoming.';
/** Replaced assets keep this prefix until the new set is live. */
export const PREVIOUS = 'previous.';

// ── Versions ────────────────────────────────────────────

function core(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Not a numeric x.y.z version: ${version}`);
  return m.slice(1).map(Number);
}

export function compareCore(a, b) {
  const x = core(a), y = core(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function bumpPatch(version) {
  const [major, minor, patch] = core(version);
  return `${major}.${minor}.${patch + 1}`;
}

/** The version the next formal release will at least have. */
function nextFormal(formal, inRepo) {
  if (!formal) return inRepo;
  return compareCore(inRepo, formal) > 0 ? inRepo : bumpPatch(formal);
}

function checkNumber(number) {
  if (!/^[1-9][0-9]*$/.test(String(number))) throw new Error(`Invalid dogfood build number: ${number}`);
}

/** `<Base>-dev.<N>`: semver-below Base, so the next formal release is newer. */
export function cliDogfoodVersion({ formal, packageVersion, number }) {
  checkNumber(number);
  return `${nextFormal(formal, packageVersion)}-dev.${number}`;
}

/**
 * Sparkle orders CFBundleVersion: `<formal build>.<N>` sorts above the formal
 * build it follows and below every later formal build (an integer above it).
 * CFBundleShortVersionString stays numeric.
 */
export function macDogfoodVersion({ formal, formalBuild, marketingVersion, number }) {
  checkNumber(number);
  if (!/^[1-9][0-9]*$/.test(String(formalBuild))) throw new Error(`Invalid formal build: ${formalBuild}`);
  const marketing = nextFormal(formal, marketingVersion);
  return { marketing, build: `${formalBuild}.${number}`, version: `${marketing}-dev.${number}` };
}

/** A setting of the KrakiMac target in packages/arm/ios/project.yml. */
export function krakiMacSetting(projectYml, key) {
  let inTargets = false, inMac = false;
  for (const line of projectYml.split('\n')) {
    if (/^targets:/.test(line)) { inTargets = true; continue; }
    if (inTargets && /^  KrakiMac:/.test(line)) { inMac = true; continue; }
    if (inMac && /^  [A-Za-z0-9_]+:/.test(line)) break;
    const m = inMac && new RegExp(`^\\s+${key}:\\s*"?([^"\\s]+)"?`).exec(line);
    if (m) return m[1];
  }
  throw new Error(`KrakiMac ${key} not found in project.yml`);
}

// ── Tags and releases ───────────────────────────────────

/** Latest formal tag of a component: { tag, version } or null. */
export function latestFormalTag(tags, component) {
  let best = null;
  for (const tag of tags) {
    const m = FORMAL_TAG[component].exec(tag);
    if (!m) continue;
    // A -diag build of the same version is not newer than the plain one.
    if (!best || compareCore(m[1], best.version) > 0) best = { tag, version: m[1] };
  }
  return best;
}

/** The published dogfood release of a component, or null (drafts never count). */
export function publishedDogfoodRelease(releases, component) {
  return releases.find(r => r.tag_name === DOGFOOD_TAG[component] && !r.draft) ?? null;
}

// ── What changed ────────────────────────────────────────

const SHARED_PACKAGES = ['packages/tentacle/', 'packages/protocol/', 'packages/pulse/', 'packages/crypto/'];
/** Dependencies and release tooling: they change every shipped binary. */
const BUILD_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'logo.png',
  '.github/workflows/release.yml'];
const IOS_ONLY = ['KrakiNotification/', 'KrakiTests/', 'KrakiUITests/', 'KrakiVoiceUITests/', 'KrakiMacTests/',
  'ExportOptions-AppStore.plist'].map(p => `packages/arm/ios/${p}`);

function notShipped(path) {
  return /(^|\/)__tests__\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path) || path.endsWith('.md');
}

/** Whether a changed path ends up in the component's artifacts. */
export function affects(component, path) {
  if (notShipped(path)) return false;
  const swift = /^packages\/(pulse|crypto)\/Swift[^/]*\//.test(path);
  const cli = SHARED_PACKAGES.some(p => path.startsWith(p)) || BUILD_INPUTS.includes(path)
    || path.startsWith('scripts/release/');
  if (component === 'cli') return cli && !swift;
  if (component === 'mac') {
    return cli || path.startsWith('scripts/mac/')
      || (path.startsWith('packages/arm/ios/') && !IOS_ONLY.some(p => path.startsWith(p)));
  }
  throw new Error(`Unknown component: ${component}`);
}

/**
 * Plan one component: changed since its previous dogfood build, else since
 * its latest formal tag. `force` builds it regardless.
 */
export function planComponent({ component, changedSince, base, force }) {
  const changed = changedSince(base).filter(p => affects(component, p));
  return { build: force || changed.length > 0, base, changed };
}

// ── Replacing the assets of a published release ─────────

/**
 * Steps that bring a release back to one complete asset set after a publish
 * was interrupted. A swap is unfinished while incoming.* assets remain: it is
 * rolled back to the previous set (complete under previous.* and the not yet
 * swapped stable names). Without incoming.*, the swap finished and only the
 * previous.* copies are left to delete. Only a name with a previous.* copy is
 * ever deleted, so recovery never removes the only copy of an asset; a name
 * that is new in the interrupted build stays until the next publish
 * replaces it.
 */
export function recoveryActions(names) {
  const present = new Set(names);
  const incoming = names.filter(n => n.startsWith(INCOMING));
  const previous = names.filter(n => n.startsWith(PREVIOUS));
  if (!incoming.length) return previous.map(name => ({ op: 'delete', name }));
  const actions = [];
  for (const name of previous) {
    const stable = name.slice(PREVIOUS.length);
    // Swapped in already: drop the new copy, restore the old one.
    if (present.has(stable)) actions.push({ op: 'delete', name: stable });
    actions.push({ op: 'rename', name, to: stable });
  }
  for (const name of incoming) actions.push({ op: 'delete', name });
  return actions;
}

/**
 * Swap incoming.<name> in for <name>: first move assets the new set drops,
 * then replace shared names, then add names that are new in this build.
 */
export function swapActions(oldNames, newNames) {
  const old = new Set(oldNames), next = new Set(newNames);
  const actions = [];
  for (const name of oldNames) if (!next.has(name)) actions.push({ op: 'rename', name, to: PREVIOUS + name });
  for (const name of newNames) {
    if (!old.has(name)) continue;
    actions.push({ op: 'rename', name, to: PREVIOUS + name });
    actions.push({ op: 'rename', name: INCOMING + name, to: name });
  }
  for (const name of newNames) if (!old.has(name)) actions.push({ op: 'rename', name: INCOMING + name, to: name });
  return actions;
}

// ── Release title and notes ─────────────────────────────

export function dogfoodTitle({ component, version, bundleBuild }) {
  if (component === 'cli') return `Kraki CLI dogfood ${version}`;
  return `Kraki for Mac dogfood ${version.replace(/-dev\.\d+$/, '')} (${bundleBuild})`;
}

export function dogfoodNotes({ component, repo, version, bundleBuild, tentacleVersion, sha, runURL, base, commits }) {
  const tag = DOGFOOD_TAG[component];
  const download = `https://github.com/${repo}/releases/download/${tag}`;
  const lines = [
    `Dogfood build for the owner and internal testers, replaced in place by every main build that changes ${component === 'cli' ? 'the CLI' : 'Kraki for Mac'}. No automatic update or download path offers it; see [docs/dogfood.md](https://github.com/${repo}/blob/main/docs/dogfood.md).`,
    '',
    component === 'cli' ? `- Version: \`${version}\`` : `- Version: \`${version.replace(/-dev\.\d+$/, '')}\` (build \`${bundleBuild}\`), built-in tentacle \`${tentacleVersion}\``,
    `- Commit: [\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha})`,
    `- Build: ${runURL}`,
    '',
  ];
  if (component === 'cli') {
    lines.push('Install: `curl -fsSL https://app.kraki.chat/install.sh | KRAKI_CHANNEL=dogfood bash`', '');
  } else {
    lines.push(`Install: download [Kraki.dmg](${download}/Kraki.dmg). Dogfood Sparkle feed: ${download}/appcast-dogfood.xml`, '');
  }
  lines.push(`## Changes since ${base.label}`, '');
  if (commits.length) {
    for (const c of commits) lines.push(`- ${c.message.split('\n')[0]} (${c.sha.slice(0, 7)})`);
  } else {
    lines.push('- No new commits (rebuild).');
  }
  lines.push('', `Full diff: https://github.com/${repo}/compare/${base.ref}...${sha}`);
  return `${lines.join('\n')}\n`;
}

// ── GitHub ──────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function github(repo, token = process.env.GH_TOKEN) {
  if (!token) throw new Error('GH_TOKEN is required');
  const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  async function call(method, url, { body, raw, accept = 'application/vnd.github+json', ok = [] } = {}) {
    const full = url.startsWith('https://') ? url : `https://api.github.com/repos/${repo}/${url}`;
    const init = { method, headers: { ...headers, Accept: accept } };
    if (raw) Object.assign(init, { body: raw, headers: { ...init.headers, 'Content-Type': 'application/octet-stream' } });
    else if (body) Object.assign(init, { body: JSON.stringify(body), headers: { ...init.headers, 'Content-Type': 'application/json' } });
    const res = await fetch(full, init);
    if (ok.includes(res.status)) return null;
    if (!res.ok) throw new Error(`${method} ${full}: HTTP ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  return {
    call,
    async releases() {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = await call('GET', `releases?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) return all;
      }
    },
    /** Every asset of a release (also of a draft), by id. */
    async assets(releaseId) {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = await call('GET', `releases/${releaseId}/assets?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) return all;
      }
    },
    async download(assetId) {
      // The asset redirects to storage that must not receive the token.
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${assetId}`,
        { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'manual' });
      const target = res.status >= 300 && res.status < 400 ? await fetch(res.headers.get('location')) : res;
      if (!target.ok) throw new Error(`Download of asset ${assetId}: HTTP ${target.status}`);
      return Buffer.from(await target.arrayBuffer());
    },
    upload(releaseId, name, data) {
      return call('POST', `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, { raw: data });
    },
    rename(assetId, name) { return call('PATCH', `releases/assets/${assetId}`, { body: { name } }); },
    deleteAsset(assetId) { return call('DELETE', `releases/assets/${assetId}`); },
    tagCommit(tag) {
      return call('GET', `git/ref/tags/${tag}`, { ok: [404] }).then(ref => (ref?.object.type === 'commit' ? ref.object.sha : null));
    },
  };
}

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

// ── plan ────────────────────────────────────────────────

async function plan() {
  const { REPO, SHA, RUN_NUMBER, FORCE = 'auto', DOGFOOD_BRANCH = 'main' } = process.env;
  if (!REPO || !/^[a-f0-9]{40}$/.test(SHA || '')) throw new Error('REPO and SHA are required');
  if (!['auto', 'cli', 'mac', 'both'].includes(FORCE)) throw new Error(`Invalid FORCE: ${FORCE}`);
  const values = { cli_build: false, mac_build: false };

  // Dogfood only builds the head of main. A newer commit's CI run (which
  // cancels this one's on main) dogfoods everything since the last build.
  const head = git(['ls-remote', 'origin', `refs/heads/${DOGFOOD_BRANCH}`]).split(/\s/)[0];
  if (head !== SHA) {
    console.error(`${DOGFOOD_BRANCH} is at ${head || 'nothing'}, not ${SHA}: its own CI run dogfoods it.`);
    output(values);
    return;
  }

  const api = github(REPO);
  const tags = git(['tag', '-l']).split('\n').filter(Boolean);
  const releases = await api.releases();
  const changedSince = base => git(['diff', '--no-renames', '--name-only', base, SHA, '--']).split('\n').filter(Boolean);
  const show = path => git(['show', `${SHA}:${path}`]);

  const formalCli = latestFormalTag(tags, 'cli');
  const formalMac = latestFormalTag(tags, 'mac');
  if (!formalCli || !formalMac) throw new Error('No formal v* or mac-v* tag found (fetch tags with fetch-depth: 0)');
  const cliVersion = cliDogfoodVersion({
    formal: formalCli.version, packageVersion: JSON.parse(show('packages/tentacle/package.json')).version, number: RUN_NUMBER,
  });
  const mac = macDogfoodVersion({
    formal: formalMac.version,
    formalBuild: krakiMacSetting(git(['show', `${formalMac.tag}:packages/arm/ios/project.yml`]), 'CURRENT_PROJECT_VERSION'),
    marketingVersion: krakiMacSetting(show('packages/arm/ios/project.yml'), 'MARKETING_VERSION'),
    number: RUN_NUMBER,
  });

  for (const [component, formal, version] of [['cli', formalCli, cliVersion], ['mac', formalMac, mac.version]]) {
    // The previous dogfood build is the commit its release's tag points at.
    const previous = publishedDogfoodRelease(releases, component) && await api.tagCommit(DOGFOOD_TAG[component]);
    const result = planComponent({
      component, base: previous || formal.tag, changedSince, force: FORCE === component || FORCE === 'both',
    });
    console.error(`${component}: base ${result.base}, ${result.changed.length} shipped file(s) changed${result.build ? '' : ' -> no dogfood build'}`);
    Object.assign(values, {
      [`${component}_build`]: result.build,
      [`${component}_base`]: result.base,
      [`${component}_version`]: version,
    });
  }
  // The Mac app embeds the tentacle; give it a version of its own so the
  // app restarts the running daemon after installing the dogfood build.
  Object.assign(values, { mac_bundle_build: mac.build, mac_tentacle_version: cliVersion });
  output(values);
}

function stampTentacle(version) {
  if (!/^\d+\.\d+\.\d+-dev\.[1-9][0-9]*$/.test(version || '')) throw new Error(`Not a dogfood version: ${version}`);
  const path = 'packages/tentacle/package.json';
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`@kraki/tentacle version -> ${version}`);
}

// ── publish / recover ───────────────────────────────────

function componentFromEnv() {
  const component = process.env.COMPONENT;
  if (!COMPONENTS.includes(component)) throw new Error(`COMPONENT must be cli or mac, not ${component}`);
  if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required');
  return { component, tag: DOGFOOD_TAG[component], repo: process.env.GITHUB_REPOSITORY };
}

async function apply(api, assets, actions) {
  const byName = new Map(assets.map(a => [a.name, a]));
  for (const action of actions) {
    const asset = byName.get(action.name);
    if (!asset) throw new Error(`Asset ${action.name} disappeared`);
    if (action.op === 'delete') {
      console.log(`Delete ${action.name}`);
      await api.deleteAsset(asset.id);
      byName.delete(action.name);
    } else {
      console.log(`Rename ${action.name} -> ${action.to}`);
      await api.rename(asset.id, action.to);
      byName.delete(action.name);
      byName.set(action.to, asset);
    }
  }
}

/** Apply recoveryActions to the release's current assets. */
async function settle(api, releaseId) {
  const assets = await api.assets(releaseId);
  await apply(api, assets, recoveryActions(assets.map(a => a.name)));
}

/** Delete leaked drafts of the tag and undo an interrupted swap. */
async function recoverRelease(api, tag) {
  const releases = (await api.releases()).filter(r => r.tag_name === tag);
  for (const draft of releases.filter(r => r.draft)) {
    console.log(`Delete leftover draft release ${draft.id} of ${tag}`);
    await api.call('DELETE', `releases/${draft.id}`);
  }
  const release = releases.find(r => !r.draft) ?? null;
  if (release) await settle(api, release.id);
  return release;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Download `name -> uploaded name` from the release, compare each with the
 * local file, then check the downloaded set's provenance like the published
 * one (artifacts.mjs verify).
 */
async function verifyUploaded(api, releaseId, dir, uploadedName) {
  const verifyDir = join(process.env.RUNNER_TEMP || '.', `verify-${Date.now()}`);
  mkdirSync(verifyDir, { recursive: true });
  const assets = new Map((await api.assets(releaseId)).map(a => [a.name, a]));
  for (const name of readdirSync(dir)) {
    const asset = assets.get(uploadedName(name));
    if (!asset) throw new Error(`Uploaded ${uploadedName(name)} is missing`);
    const data = await api.download(asset.id);
    if (sha256(data) !== sha256(readFileSync(join(dir, name)))) throw new Error(`Uploaded ${uploadedName(name)} differs from ${name}`);
    writeFileSync(join(verifyDir, name), data);
  }
  execFileSync('node', ['scripts/release/artifacts.mjs', 'verify', verifyDir, join(verifyDir, 'provenance.json')], { stdio: 'inherit' });
}

async function publish() {
  const { component, tag, repo } = componentFromEnv();
  const { SHA, VERSION, BUNDLE_BUILD = '', TENTACLE_VERSION = '', BASE, ASSET_DIR = 'release-assets' } = process.env;
  if (!/^[a-f0-9]{40}$/.test(SHA || '')) throw new Error('SHA is required');
  if (!/^\d+\.\d+\.\d+-dev\.[1-9][0-9]*$/.test(VERSION || '')) throw new Error(`Invalid VERSION: ${VERSION}`);
  if (!/^[A-Za-z0-9._-]+$/.test(BASE || '')) throw new Error(`Invalid BASE: ${BASE}`);
  const api = github(repo);
  const names = readdirSync(ASSET_DIR).sort();

  let release = await recoverRelease(api, tag);
  // Changes since the build the release holds now; the planned base (the
  // formal tag) only for a first build.
  const previous = (release && await api.tagCommit(tag)) || BASE;
  const base = /^[a-f0-9]{40}$/.test(previous)
    ? { ref: previous, label: `the previous dogfood build (${previous.slice(0, 7)})` } : { ref: previous, label: previous };
  const compare = await api.call('GET', `compare/${base.ref}...${SHA}`);
  const commits = compare.commits.reverse().slice(0, 100).map(c => ({ sha: c.sha, message: c.commit.message }));
  const runURL = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const metadata = {
    name: dogfoodTitle({ component, version: VERSION, bundleBuild: BUNDLE_BUILD }),
    body: dogfoodNotes({ component, repo, version: VERSION, bundleBuild: BUNDLE_BUILD, tentacleVersion: TENTACLE_VERSION, sha: SHA, runURL, base, commits }),
    prerelease: true,
    make_latest: 'false',
  };
  const moveTag = async () => {
    if (await api.tagCommit(tag)) await api.call('PATCH', `git/refs/tags/${tag}`, { body: { sha: SHA, force: true } });
    else await api.call('POST', 'git/refs', { body: { ref: `refs/tags/${tag}`, sha: SHA } });
  };

  if (!release) {
    // First build: a draft stays invisible until its assets are verified;
    // recoverRelease deletes it if this run does not get that far.
    await moveTag();
    const draft = await api.call('POST', 'releases', { body: { tag_name: tag, ...metadata, draft: true } });
    for (const name of names) await api.upload(draft.id, name, readFileSync(join(ASSET_DIR, name)));
    await verifyUploaded(api, draft.id, ASSET_DIR, name => name);
    release = await api.call('PATCH', `releases/${draft.id}`, { body: { ...metadata, draft: false } });
  } else {
    for (const name of names) await api.upload(release.id, INCOMING + name, readFileSync(join(ASSET_DIR, name)));
    await verifyUploaded(api, release.id, ASSET_DIR, name => INCOMING + name);
    const current = await api.assets(release.id);
    const old = current.map(a => a.name).filter(n => !n.startsWith(INCOMING));
    await apply(api, current, swapActions(old, names));
    await moveTag();
    await api.call('PATCH', `releases/${release.id}`, { body: metadata });
    // Only previous.* copies are left: delete them.
    await settle(api, release.id);
  }

  const live = await api.call('GET', `releases/${release.id}`);
  const liveNames = (await api.assets(release.id)).map(a => a.name).sort();
  if (!live.prerelease || live.draft) throw new Error(`${tag} must be a published prerelease`);
  if (JSON.stringify(liveNames) !== JSON.stringify(names)) throw new Error(`${tag} assets ${liveNames} != ${names}`);
  if (await api.tagCommit(tag) !== SHA) throw new Error(`${tag} does not point at ${SHA}`);
  const latest = await api.call('GET', 'releases/latest', { ok: [404] });
  if (latest?.tag_name === tag) throw new Error(`${tag} became GitHub's latest release`);
  console.log(`${tag}: ${metadata.name} at ${SHA}`);
}

async function recover() {
  const { tag, repo } = componentFromEnv();
  await recoverRelease(github(repo), tag);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') await plan();
  else if (command === 'stamp-tentacle') stampTentacle(args[0]);
  else if (command === 'publish') await publish();
  else if (command === 'recover') await recover();
  else throw new Error('Usage: prerelease.mjs plan | stamp-tentacle VERSION | publish | recover');
}
