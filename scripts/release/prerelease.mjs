#!/usr/bin/env node
/**
 * Dogfood prereleases of the CLI and Kraki for Mac (docs/prerelease.md).
 *
 * Every prerelease is a GitHub prerelease, never "latest", tagged dev-cli-* or
 * dev-mac-*: none of the automatic update/download paths (CLI updater,
 * install.sh/ps1, web Mac download, Sparkle appcast) look at those.
 *
 *   plan                     -> GITHUB_OUTPUT: what to build, versions, tags
 *   stamp-tentacle VERSION   -> set packages/tentacle/package.json version (CI workspace only)
 *   prune COMPONENT TAG      -> keep the newest KEEP prereleases; delete older ones and orphan tags
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEP_PRERELEASES = 10;
export const COMPONENTS = ['cli', 'mac'];
const TAG_PREFIX = { cli: 'dev-cli-', mac: 'dev-mac-' };
const FORMAL_TAG = { cli: /^v(\d+\.\d+\.\d+)$/, mac: /^mac-v(\d+\.\d+\.\d+)(?:-diag)?$/ };

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
  if (!/^[1-9][0-9]*$/.test(String(number))) throw new Error(`Invalid prerelease number: ${number}`);
}

/** `<Base>-dev.<N>`: semver-below Base, so the next formal release is newer. */
export function cliPrereleaseVersion({ formal, packageVersion, number }) {
  checkNumber(number);
  return `${nextFormal(formal, packageVersion)}-dev.${number}`;
}

/**
 * Sparkle orders CFBundleVersion: `<formal build>.<N>` sorts above the formal
 * build it follows and below every later formal build (an integer above it).
 * CFBundleShortVersionString stays numeric.
 */
export function macPrereleaseVersion({ formal, formalBuild, marketingVersion, number }) {
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

/** N of a dev-<component>-*-dev.N tag, or null. */
export function prereleaseNumber(tag, component) {
  if (!tag.startsWith(TAG_PREFIX[component])) return null;
  const m = /-dev\.([1-9][0-9]*)$/.exec(tag);
  return m ? Number(m[1]) : null;
}

export function prereleaseTag(component, version) {
  return `${TAG_PREFIX[component]}${version}`;
}

/** Published prereleases of a component, newest (highest N) first. */
export function publishedPrereleases(releases, component) {
  return releases
    .filter(r => r.prerelease && !r.draft && prereleaseNumber(r.tag_name, component) !== null)
    .sort((a, b) => prereleaseNumber(b.tag_name, component) - prereleaseNumber(a.tag_name, component));
}

/**
 * What a new prerelease of `currentTag` may delete: published prereleases
 * beyond the newest `keep`, and dev tags without a release (left by a build a
 * newer commit cancelled) that are older than `currentTag` and not being built.
 */
export function pruneTargets({ releases, tags, component, currentTag, activeRefs = [], keep = KEEP_PRERELEASES }) {
  const current = prereleaseNumber(currentTag, component);
  if (current === null) throw new Error(`Not a ${component} prerelease tag: ${currentTag}`);
  const published = publishedPrereleases(releases, component);
  const releaseTags = new Set(releases.map(r => r.tag_name));
  const active = new Set(activeRefs);
  const orphanTags = tags.filter(tag => {
    const n = prereleaseNumber(tag, component);
    return n !== null && n < current && !releaseTags.has(tag) && !active.has(tag);
  });
  return { releases: published.slice(keep).map(r => r.tag_name), orphanTags };
}

// ── What changed ────────────────────────────────────────

const SHARED_PACKAGES = ['packages/tentacle/', 'packages/protocol/', 'packages/pulse/', 'packages/crypto/'];
const IOS_ONLY = ['KrakiNotification/', 'KrakiTests/', 'KrakiUITests/', 'KrakiVoiceUITests/', 'KrakiMacTests/',
  'ExportOptions-AppStore.plist'].map(p => `packages/arm/ios/${p}`);

function notShipped(path) {
  return /(^|\/)__tests__\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path) || path.endsWith('.md');
}

/** Whether a changed path ends up in the component's artifacts. */
export function affects(component, path) {
  if (notShipped(path)) return false;
  const swift = /^packages\/(pulse|crypto)\/Swift[^/]*\//.test(path);
  const cli = SHARED_PACKAGES.some(p => path.startsWith(p)) || path === 'scripts/release/build-info.mjs';
  if (component === 'cli') return cli && !swift;
  if (component === 'mac') {
    return cli || path.startsWith('scripts/mac/')
      || (path.startsWith('packages/arm/ios/') && !IOS_ONLY.some(p => path.startsWith(p)));
  }
  throw new Error(`Unknown component: ${component}`);
}

/**
 * Plan one component: changed since its previous prerelease, else since its
 * latest formal tag. `force` builds it regardless.
 */
export function planComponent({ component, changedSince, base, force }) {
  const changed = changedSince(base).filter(p => affects(component, p));
  return { build: force || changed.length > 0, base, changed };
}

// ── CLI ─────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function listReleases(repo) {
  const out = gh(['api', '--paginate', `repos/${repo}/releases?per_page=100`,
    '--jq', '.[] | {tag_name, prerelease, draft}']);
  return out ? out.split('\n').map(line => JSON.parse(line)) : [];
}

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function plan() {
  const { REPO, SHA, RUN_NUMBER, FORCE = 'auto' } = process.env;
  if (!REPO || !/^[a-f0-9]{40}$/.test(SHA || '')) throw new Error('REPO and SHA are required');
  if (!['auto', 'cli', 'mac', 'both'].includes(FORCE)) throw new Error(`Invalid FORCE: ${FORCE}`);
  const tags = git(['tag', '-l']).split('\n').filter(Boolean);
  const releases = listReleases(REPO);
  const changedSince = base => git(['diff', '--no-renames', '--name-only', base, SHA, '--']).split('\n').filter(Boolean);
  const show = path => git(['show', `${SHA}:${path}`]);

  const formalCli = latestFormalTag(tags, 'cli');
  const formalMac = latestFormalTag(tags, 'mac');
  if (!formalCli || !formalMac) throw new Error('No formal v* or mac-v* tag found (fetch tags with fetch-depth: 0)');
  const cliVersion = cliPrereleaseVersion({
    formal: formalCli.version, packageVersion: JSON.parse(show('packages/tentacle/package.json')).version, number: RUN_NUMBER,
  });
  const mac = macPrereleaseVersion({
    formal: formalMac.version,
    formalBuild: krakiMacSetting(git(['show', `${formalMac.tag}:packages/arm/ios/project.yml`]), 'CURRENT_PROJECT_VERSION'),
    marketingVersion: krakiMacSetting(show('packages/arm/ios/project.yml'), 'MARKETING_VERSION'),
    number: RUN_NUMBER,
  });
  const baseOf = (component, formal) => publishedPrereleases(releases, component)[0]?.tag_name ?? formal.tag;

  const values = {};
  for (const [component, formal, version] of [['cli', formalCli, cliVersion], ['mac', formalMac, mac.version]]) {
    const result = planComponent({
      component, base: baseOf(component, formal), changedSince,
      force: FORCE === component || FORCE === 'both',
    });
    console.error(`${component}: base ${result.base}, ${result.changed.length} shipped file(s) changed${result.build ? '' : ' -> no prerelease'}`);
    Object.assign(values, {
      [`${component}_build`]: result.build,
      [`${component}_base`]: result.base,
      [`${component}_version`]: version,
      [`${component}_tag`]: prereleaseTag(component, version),
    });
  }
  // The Mac app embeds the tentacle; give it a version of its own so the
  // app restarts the running daemon after installing the prerelease.
  Object.assign(values, { mac_marketing: mac.marketing, mac_bundle_build: mac.build, mac_tentacle_version: cliVersion });
  output(values);
}

function stampTentacle(version) {
  if (!/^\d+\.\d+\.\d+-dev\.[1-9][0-9]*$/.test(version || '')) throw new Error(`Not a prerelease version: ${version}`);
  const path = 'packages/tentacle/package.json';
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`@kraki/tentacle version -> ${version}`);
}

function prune(component, currentTag) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !COMPONENTS.includes(component)) throw new Error('Usage: prune cli|mac CURRENT_TAG (GITHUB_REPOSITORY set)');
  const releases = listReleases(repo);
  const tagsOut = gh(['api', '--paginate', `repos/${repo}/git/matching-refs/tags/${TAG_PREFIX[component]}`, '--jq', '.[].ref']);
  const tags = tagsOut ? tagsOut.split('\n').map(ref => ref.replace(/^refs\/tags\//, '')) : [];
  const runsOut = gh(['run', 'list', '--repo', repo, '--workflow', 'release.yml', '--limit', '100',
    '--json', 'headBranch,status', '--jq', '.[] | select(.status != "completed") | .headBranch']);
  const targets = pruneTargets({ releases, tags, component, currentTag, activeRefs: runsOut ? runsOut.split('\n') : [] });
  for (const tag of targets.releases) {
    console.log(`Deleting prerelease ${tag}`);
    gh(['release', 'delete', tag, '--repo', repo, '--cleanup-tag', '--yes']);
  }
  for (const tag of targets.orphanTags) {
    console.log(`Deleting orphan tag ${tag}`);
    gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/tags/${tag}`]);
  }
  if (!targets.releases.length && !targets.orphanTags.length) console.log('Nothing to prune');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') plan();
  else if (command === 'stamp-tentacle') stampTentacle(args[0]);
  else if (command === 'prune') prune(args[0], args[1]);
  else throw new Error('Usage: prerelease.mjs plan | stamp-tentacle VERSION | prune cli|mac CURRENT_TAG');
}
