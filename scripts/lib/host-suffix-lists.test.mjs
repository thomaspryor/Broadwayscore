/**
 * Tests for the shared host-suffix source of truth (task #1188 residue).
 *
 * The point of this module is that TWO functions which must agree —
 * provisionalOutletIdFromHost (mints the outletId a new host registers under)
 * and normalizeHostSlug (decides whether an unregistered host is a known
 * outlet that moved) — stop keeping private copies of the same lists. So the
 * tests here are mostly AGREEMENT tests, plus a source-level guard that fails
 * if either consumer re-forks a literal list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PLATFORM_HOST_SUFFIXES,
  MULTIPART_PUBLIC_SUFFIXES,
  platformSuffixOf,
  multipartSuffixOf,
  stripCosmeticPrefixes,
} = require('./host-suffix-lists.js');
const { provisionalOutletIdFromHost } = require('./outlet-canonicalize.js');
const { normalizeHostSlug } = require('./silent-exclusion-detectors.js');
const { registrableHost } = require('./non-review-url-patterns.js');

test('platformSuffixOf matches a hosting platform, not a plain domain', () => {
  assert.equal(platformSuffixOf('1minutecritic.substack.com'), 'substack.com');
  assert.equal(platformSuffixOf('pagesonstages.wordpress.com'), 'wordpress.com');
  assert.equal(platformSuffixOf('www.someblog.tumblr.com'), 'tumblr.com');
  assert.equal(platformSuffixOf('nytimes.com'), null);
  assert.equal(platformSuffixOf('theatre-weekly.co.uk'), null);
});

test('platformSuffixOf handles Blogger country mirrors, not just blogspot.com', () => {
  // The live case: showshowdown.blogspot.co.id. Before the shared module, this
  // host hit the two-label-ccTLD branch on BOTH sides and yielded the platform's
  // own name as the outlet identity — a slug every other blog on that mirror
  // would collide with.
  assert.equal(platformSuffixOf('showshowdown.blogspot.co.id'), 'blogspot.co.id');
  assert.equal(platformSuffixOf('someblog.blogspot.co.uk'), 'blogspot.co.uk');
  assert.equal(platformSuffixOf('someblog.blogspot.com'), 'blogspot.com');
});

test('multipartSuffixOf matches two-label public suffixes only', () => {
  assert.equal(multipartSuffixOf('theatre-weekly.co.uk'), 'co.uk');
  assert.equal(multipartSuffixOf('news.dancemagazine.co.uk'), 'co.uk');
  assert.equal(multipartSuffixOf('example.com.br'), 'com.br');
  assert.equal(multipartSuffixOf('nytimes.com'), null);
});

test('the lists are frozen — a consumer cannot mutate shared state', () => {
  assert.throws(() => PLATFORM_HOST_SUFFIXES.push('evil.com'), TypeError);
  assert.throws(() => MULTIPART_PUBLIC_SUFFIXES.push('evil.tld'), TypeError);
});

test('empty/malformed input does not throw', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}, 'localhost']) {
    assert.doesNotThrow(() => platformSuffixOf(bad));
    assert.doesNotThrow(() => multipartSuffixOf(bad));
  }
});

// ---------------------------------------------------------------------------
// The drift these tests exist to prevent.
// ---------------------------------------------------------------------------

test('the union closes the drift that existed between the two forks', () => {
  // Pre-unification, outlet-canonicalize.js knew tumblr.com and the detector
  // did not; the detector knew co.id and canonicalize did not. Both must now
  // be present, because both consumers read the same list.
  assert.ok(PLATFORM_HOST_SUFFIXES.includes('tumblr.com'), 'tumblr.com was missing from the detector fork');
  assert.ok(MULTIPART_PUBLIC_SUFFIXES.includes('co.id'), 'co.id was missing from the canonicalize fork');
});

test('both consumers agree on the identity label for the drifted hosts', () => {
  // The concrete failure mode: a host registered under outletId A while the
  // domain-move detector reasons about slug B never gets recognized as a move.
  const cases = [
    ['someblog.tumblr.com', 'someblog'],
    ['showshowdown.blogspot.co.id', 'showshowdown'],
    ['1minutecritic.substack.com', '1minutecritic'],
    ['theatre-weekly.co.uk', 'theatreweekly'],
  ];
  for (const [host, expected] of cases) {
    // normalizeHostSlug strips non-alphanumerics; compare on the same basis.
    const minted = String(provisionalOutletIdFromHost(host) || '').replace(/[^a-z0-9]/g, '');
    assert.equal(minted, expected, `provisionalOutletIdFromHost(${host})`);
    assert.equal(normalizeHostSlug(host), expected, `normalizeHostSlug(${host})`);
  }
});

test('the garbage-slug class is closed: no real host mints a public-suffix fragment', () => {
  // The live registry still carries a junk tier-3 outlet named "Co" (domain
  // stagedoorjoe.co.uk) minted before the multipart list existed. Neither
  // function may ever produce that shape again.
  const junk = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'me', 'blogspot', 'wordpress', 'substack', 'medium', 'tumblr']);
  const hosts = [
    'stagedoorjoe.co.uk',
    'londontheatre.co.uk',
    'showshowdown.blogspot.co.id',
    'someblog.wordpress.com',
    'pub.substack.com',
    'example.com.au',
    'example.co.za',
  ];
  for (const h of hosts) {
    assert.ok(!junk.has(provisionalOutletIdFromHost(h)), `${h} minted a junk outletId`);
    assert.ok(!junk.has(normalizeHostSlug(h)), `${h} normalized to a junk slug`);
  }
});

test('registrableHost agrees with the other two on platform hosts', () => {
  // The THIRD fork, found in review: non-review-url-patterns.js carried its own
  // COLLAPSE_BLOG_PLATFORMS/COLLAPSE_MULTIPART_SUFFIXES copy whose comments
  // pointed at outlet-canonicalize.js's now-deleted constants. It knew no
  // Blogger country mirror, so it returned the bare public suffix 'co.id' as if
  // that were a registrable domain. registrableHost keeps the full host for a
  // platform publication (that IS its identity), so agreement here means
  // "recognized as a platform host", not an identical string.
  assert.equal(registrableHost('showshowdown.blogspot.co.id'), 'showshowdown.blogspot.co.id');
  assert.equal(registrableHost('1minutecritic.substack.com'), '1minutecritic.substack.com');
  assert.equal(registrableHost('someblog.tumblr.com'), 'someblog.tumblr.com');
  // Non-platform hosts still collapse to the registrable domain.
  assert.equal(registrableHost('theater.nytimes.com'), 'nytimes.com');
  assert.equal(registrableHost('news.dancemagazine.co.uk'), 'dancemagazine.co.uk');
});

test('stripCosmeticPrefixes drops www/amp/m/mobile but never the publication label', () => {
  assert.equal(stripCosmeticPrefixes('amp.theguardian.com'), 'theguardian.com');
  assert.equal(stripCosmeticPrefixes('m.someblog.substack.com'), 'someblog.substack.com');
  assert.equal(stripCosmeticPrefixes('mobile.m.amp.someblog.substack.com'), 'someblog.substack.com');
  assert.equal(stripCosmeticPrefixes('www.theatre-weekly.co.uk'), 'theatre-weekly.co.uk');
  // The guard: here 'm' IS the Blogger publication, not a mobile mirror.
  assert.equal(stripCosmeticPrefixes('m.blogspot.co.id'), 'm.blogspot.co.id');
  assert.equal(stripCosmeticPrefixes('m.co.uk'), 'm.co.uk');
  // Malformed hosts must not slice down to nothing.
  assert.equal(stripCosmeticPrefixes('.blogspot.co.id'), 'blogspot.co.id');
  assert.equal(stripCosmeticPrefixes('example.com.'), 'example.com');
  assert.equal(stripCosmeticPrefixes(null), '');
});

test('ALL THREE agree on mirror-prefixed hosts (ship-check regression)', () => {
  // Found by ship-check, confirmed by direct execution against the first
  // commit of this change: provisionalOutletIdFromHost stripped only www., so
  // 'm.someblog.substack.com' minted the outletId 'm' while normalizeHostSlug
  // said 'someblog' — a registration/detection split that makes a genuine
  // domain move unrecognizable. registrableHost had the mirror bug: it
  // stripped 'm.' unconditionally, so 'm.blogspot.co.id' collapsed onto the
  // platform's own name.
  const cases = [
    ['m.someblog.substack.com', 'someblog', 'someblog.substack.com'],
    ['amp.someblog.substack.com', 'someblog', 'someblog.substack.com'],
    ['mobile.m.amp.someblog.substack.com', 'someblog', 'someblog.substack.com'],
    ['amp.theguardian.com', 'theguardian', 'theguardian.com'],
    // 'm' is the publication here — all three must preserve it.
    ['m.blogspot.co.id', 'm', 'm.blogspot.co.id'],
  ];
  for (const [host, identity, registrable] of cases) {
    const minted = String(provisionalOutletIdFromHost(host) || '').replace(/[^a-z0-9]/g, '');
    assert.equal(minted, identity, `provisionalOutletIdFromHost(${host})`);
    assert.equal(normalizeHostSlug(host), identity, `normalizeHostSlug(${host})`);
    assert.equal(registrableHost(host), registrable, `registrableHost(${host})`);
  }
});

test('normalizeHostSlug never returns an empty slug for a parseable host', () => {
  for (const h of ['.blogspot.co.id', 'example.com.', 'substack.com', 'co.uk', 'm.co.uk']) {
    assert.notEqual(normalizeHostSlug(h), '', `${h} normalized to empty`);
  }
});

test('SOURCE GUARD: no consumer re-declares its own suffix list', () => {
  // A future edit that pastes a literal list back into any consumer silently
  // reintroduces the drift this module exists to prevent, and every behavioural
  // test above would still pass. So assert on the source text.
  const consumers = [
    'outlet-canonicalize.js',
    'silent-exclusion-detectors.js',
    'non-review-url-patterns.js',
  ];
  for (const file of consumers) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1');     // line AND trailing inline comments
    for (const suffix of ['substack.com', 'wordpress.com', 'co.uk', 'com.au']) {
      assert.ok(
        !code.includes(suffix),
        `${file} declares the literal "${suffix}" in code — use host-suffix-lists.js instead`,
      );
    }
    assert.ok(
      code.includes("require('./host-suffix-lists')"),
      `${file} must consume the shared host-suffix lists`,
    );
  }
});
