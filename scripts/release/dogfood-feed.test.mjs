import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireReleaseArtifacts } from './artifacts.mjs';
import {
  DOGFOOD_FEED, checkDogfoodFeed, compareBundleVersions, feedItems, isSignedFeed, sparkleArchiveName,
} from './dogfood-feed.mjs';

// Written by Sparkle 2.9.5 generate_appcast (the version release.yml uses)
// with a throwaway key, the way release.yml runs it:
//   production-93 / production-94: publish-mac-appcast for mac-v0.2.91 (build 93), then mac-v0.2.92 (94)
//   dogfood-93.57: a dogfood build, from production-93 plus Kraki-93.57.app.zip
//   dogfood-refreshed-94: the mac-v0.2.92 refresh, from dogfood-93.57 plus its Kraki.app.zip
const fixture = name => readFileSync(new URL(`./fixtures/dogfood-feed/${name}.xml`, import.meta.url), 'utf8');
const download = 'https://github.com/corelli18512/kraki/releases/download';

test('fixtures carry a valid feed signature, the kind the app requires (SURequireSignedFeed)', () => {
  const raw = Buffer.from(readFileSync(new URL('./fixtures/dogfood-feed/throwaway-ed25519.pub', import.meta.url), 'utf8'), 'base64');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  for (const name of ['production-93', 'dogfood-93.57', 'production-94', 'dogfood-refreshed-94']) {
    const xml = fixture(name);
    assert.ok(isSignedFeed(xml), name);
    const [, signature, length] = /edSignature: (\S+)\nlength: (\d+)\n-->/.exec(xml);
    assert.ok(verify(null, Buffer.from(xml).subarray(0, Number(length)), key, Buffer.from(signature, 'base64')), name);
  }
  assert.ok(!isSignedFeed(fixture('dogfood-93.57').replace(/<!-- sparkle-signatures:[\s\S]*$/, '')));
});

test('a dogfood build feed: the build at its own archive plus the newest formal release', () => {
  const feed = fixture('dogfood-93.57');
  assert.deepEqual(feedItems(feed).map(i => [i.version, i.url]), [
    ['93.57', `${download}/dogfood-mac/Kraki-93.57.app.zip`],
    ['93', `${download}/mac-v0.2.91/Kraki.app.zip`],
  ]);
  checkDogfoodFeed({ feed, production: fixture('production-93'), version: '93.57', url: `${download}/dogfood-mac/Kraki-93.57.app.zip` });
});

test('a formal release refreshes the feed, so a dogfood Mac is offered it', () => {
  const feed = fixture('dogfood-refreshed-94');
  const items = feedItems(feed).sort((a, b) => compareBundleVersions(b.version, a.version));
  assert.deepEqual(items.map(i => i.version), ['94', '93.57']);
  checkDogfoodFeed({ feed, production: fixture('production-94'), version: '94', url: `${download}/mac-v0.2.92/Kraki.app.zip` });
  // The stale feed would leave a 93.57 Mac below the formal 94.
  assert.throws(() => checkDogfoodFeed({
    feed: fixture('dogfood-93.57'), production: fixture('production-94'), version: '93.57', url: `${download}/dogfood-mac/Kraki-93.57.app.zip`,
  }), /newest formal release 94/);
});

test('the check refuses unsigned feeds, missing items and in-place dogfood archives', () => {
  const feed = fixture('dogfood-93.57');
  const production = fixture('production-93');
  const url = `${download}/dogfood-mac/Kraki-93.57.app.zip`;
  assert.throws(() => checkDogfoodFeed({ feed: feed.replace(/<!-- sparkle-signatures:[\s\S]*$/, ''), production, version: '93.57', url }), /not signed/);
  assert.throws(() => checkDogfoodFeed({ feed, production, version: '93.58', url }), /does not list 93\.58/);
  // A swapped-in-place name could pair this signature with another build's zip.
  const inPlace = feed.replace('dogfood-mac/Kraki-93.57.app.zip', 'dogfood-mac/Kraki.app.zip');
  assert.throws(() => checkDogfoodFeed({ feed: inPlace, production, version: '93.57', url: `${download}/dogfood-mac/Kraki.app.zip` }), /its own archive/);
  const altered = feed.replace(/(mac-v0\.2\.91\/Kraki\.app\.zip" length=")\d+/, '$11');
  assert.throws(() => checkDogfoodFeed({ feed: altered, production, version: '93.57', url }), /newest formal release 93/);
  assert.throws(() => checkDogfoodFeed({ feed, production: '<rss></rss>', version: '93.57', url }), /no items/);
});

test('Sparkle version order puts a dogfood build between formal builds', () => {
  assert.ok(compareBundleVersions('93.57', '93') > 0);
  assert.ok(compareBundleVersions('94', '93.57') > 0);
  assert.ok(compareBundleVersions('93.58', '93.57') > 0);
  assert.ok(compareBundleVersions('93.100', '93.99') > 0);
  assert.equal(compareBundleVersions('93', '93'), 0);
  assert.throws(() => compareBundleVersions('93a', '93'));
});

test('per-build archive names, and the dogfood release manifest expects one', () => {
  assert.equal(sparkleArchiveName('93.57'), 'Kraki-93.57.app.zip');
  assert.throws(() => sparkleArchiveName('93.57/../x'));
  assert.throws(() => sparkleArchiveName(''));
  assert.equal(DOGFOOD_FEED, 'appcast-dogfood.xml');
  const dir = mkdtempSync(join(tmpdir(), 'kraki-dogfood-mac-'));
  try {
    for (const name of ['Kraki.dmg', 'Kraki-93.57.app.zip', 'kraki-mac-gui-universal.app.tar.gz']) writeFileSync(join(dir, name), name);
    requireReleaseArtifacts(dir, 'mac', '0.2.92-dev.57', sparkleArchiveName('93.57'));
    assert.throws(() => requireReleaseArtifacts(dir, 'mac', '0.2.92'), /Missing release artifact Kraki\.app\.zip/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the app reads the feeds release.yml publishes', () => {
  const swift = readFileSync(new URL('../../packages/arm/ios/Kraki/App/Mac/MacUpdateChannel.swift', import.meta.url), 'utf8');
  const plist = readFileSync(new URL('../../packages/arm/ios/KrakiMac.Info.plist', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const stable = /stableFeedURL = "([^"]+)"/.exec(swift)[1];
  const dogfood = /dogfoodFeedURL = "([^"]+)"/.exec(swift)[1];
  assert.equal(/<key>SUFeedURL<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)[1], stable);
  assert.match(plist, /<key>SURequireSignedFeed<\/key>\s*<true\/>/);
  assert.equal(dogfood, `${download}/dogfood-mac/${DOGFOOD_FEED}`);
  // Stable stays the production appcast on mac-updates, written only for mac-v* releases.
  assert.equal(stable, 'https://raw.githubusercontent.com/corelli18512/kraki/mac-updates/appcast.xml');
  assert.ok(workflow.includes('git push origin mac-updates'));
  for (const step of ['Generate dogfood Sparkle feed', 'Refresh the dogfood Sparkle feed']) assert.ok(workflow.includes(`- name: ${step}`), step);
});
