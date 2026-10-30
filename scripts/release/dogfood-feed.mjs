#!/usr/bin/env node
/**
 * The dogfood Sparkle feed: `appcast-dogfood.xml` of the rolling
 * `dogfood-mac` release (docs/dogfood.md).
 *
 * Kraki for Mac on the Dogfood channel reads only this feed, so it lists the
 * newest dogfood build and the newest formal release; Sparkle offers the
 * higher one. release.yml writes it with Sparkle's generate_appcast, signed
 * with the production key (the app requires signed feeds): from the
 * production appcast plus the new build for every dogfood build, and from
 * the live dogfood feed plus the new release for every formal Mac release.
 *
 * A dogfood item points at `Kraki-<CFBundleVersion>.app.zip`, a name only
 * that build uses, never at an asset that is replaced in place. While the
 * release swaps its assets, a feed therefore never pairs a signature with
 * another build's archive.
 *
 *   check FEED PRODUCTION_FEED VERSION URL
 *     the feed lists VERSION at URL and the newest production item unchanged
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOGFOOD_FEED = 'appcast-dogfood.xml';
/** Items kept in the feed: the newest dogfood build and formal release. */
export const DOGFOOD_FEED_ITEMS = 2;

const BUNDLE_BUILD = /^[1-9][0-9]*(\.[1-9][0-9]*)?$/;

/** The dogfood release's Sparkle archive for a CFBundleVersion like 93.57. */
export function sparkleArchiveName(bundleBuild) {
  if (!BUNDLE_BUILD.test(String(bundleBuild))) throw new Error(`Invalid CFBundleVersion: ${bundleBuild}`);
  return `Kraki-${bundleBuild}.app.zip`;
}

/** Sparkle's order for numeric CFBundleVersions: 93 < 93.57 < 93.58 < 94. */
export function compareBundleVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  if ([...x, ...y].some(n => !Number.isInteger(n))) throw new Error(`Not a numeric CFBundleVersion: ${a} / ${b}`);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function attribute(tag, name) {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

/** The items of a generate_appcast feed: version and enclosure. */
export function feedItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const enclosure = /<enclosure\b[^>]*>/.exec(item)?.[0] ?? '';
    return {
      version: /<sparkle:version>([^<]*)<\/sparkle:version>/.exec(item)?.[1] ?? null,
      url: attribute(enclosure, 'url'),
      length: attribute(enclosure, 'length'),
      signature: attribute(enclosure, 'sparkle:edSignature'),
    };
  });
}

/** generate_appcast appends the feed's own EdDSA signature as a comment. */
export function isSignedFeed(xml) {
  return /<!-- sparkle-signatures:\s*\nedSignature: \S+\nlength: \d+\n-->\s*$/.test(xml);
}

/**
 * Throws unless `feed` is a signed dogfood feed that lists `version` at
 * `url`, keeps the newest item of the production feed unchanged, and points
 * every dogfood item at its own per-build archive.
 */
export function checkDogfoodFeed({ feed, production, version, url }) {
  if (!isSignedFeed(feed)) throw new Error('The dogfood feed is not signed');
  const items = feedItems(feed);
  if (!items.length || items.length > DOGFOOD_FEED_ITEMS) throw new Error(`The dogfood feed has ${items.length} items`);
  for (const item of items) {
    if (!item.version || !item.url || !/^[1-9][0-9]*$/.test(item.length ?? '') || !item.signature) {
      throw new Error(`Incomplete feed item: ${JSON.stringify(item)}`);
    }
    if (item.url.includes('/releases/download/dogfood-mac/') && !item.url.endsWith(`/dogfood-mac/${sparkleArchiveName(item.version)}`)) {
      throw new Error(`Dogfood item ${item.version} must point at its own archive, not ${item.url}`);
    }
  }
  if (!items.some(item => item.version === version && item.url === url)) {
    throw new Error(`The dogfood feed does not list ${version} at ${url}`);
  }
  const formal = feedItems(production).sort((a, b) => compareBundleVersions(b.version, a.version))[0];
  if (!formal) throw new Error('The production feed has no items');
  const kept = items.find(item => item.version === formal.version);
  if (!kept || JSON.stringify(kept) !== JSON.stringify(formal)) {
    throw new Error(`The dogfood feed must list the newest formal release ${formal.version} as the production feed does`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, feed, production, version, url] = process.argv.slice(2);
  if (command !== 'check' || !url) throw new Error('Usage: dogfood-feed.mjs check FEED PRODUCTION_FEED VERSION URL');
  checkDogfoodFeed({ feed: readFileSync(feed, 'utf8'), production: readFileSync(production, 'utf8'), version, url });
  console.log(`${feed}: signed; lists ${version} and the newest formal release`);
}
