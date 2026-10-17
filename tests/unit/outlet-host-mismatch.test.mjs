// Outlet id vs URL host advisory (2026 data audit S7-T6, BRO-4204).
//
// A review file's outletId comes from the aggregator's label, not the URL
// host, so a Time Out review can be filed as NYT (every-brilliant-thing-2026
// / Adam Feldman). outlet-domain-validation.js's classifyOutletHostMismatch
// says when the host belongs to ANOTHER registered outlet; the rebuild stamps
// outletHostMismatch:true on the emitted reviews.json row and prints one
// advisory line — audit-only, never an exclusion. Wire services,
// newspapers.com / web.archive.org provenance and dual-hosted brands
// (timeout.com serves timeout AND timeout-london) are exempt.
//
// Runs against the real data/outlet-registry.json (tracked), like the other
// cross-market-guard tests. Per CLAUDE.md §15: real functions, then wiring.
//
// Run: node --test tests/unit/outlet-host-mismatch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const { classifyOutletHostMismatch, HOST_MISMATCH_EXEMPT_HOSTS } = require(path.join(ROOT, 'scripts/lib/outlet-domain-validation.js'));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/outlet-registry.json'), 'utf8'));

const EBT_TIMEOUT_URL = 'https://www.timeout.com/newyork/news/broadway-review-daniel-radcliffe-brings-his-shine-to-every-brilliant-thing-031326';

test('registry fixtures this test relies on', () => {
  assert.equal(registry.outlets.nytimes.domain, 'nytimes.com');
  assert.equal(registry.outlets.timeout.domain, 'timeout.com');
  assert.equal(registry.outlets['timeout-london'].domain, 'timeout.com');
  assert.ok(registry.outlets.nytimes.tier === 1 && registry.outlets.timeout.tier === 1, 'the Feldman case is a same-tier mismatch');
  assert.equal(registry.outlets['about-entertainment'].tier, 3);
  assert.equal(registry.outlets.ap.tier, 1);
});

test('Every Brilliant Thing: outletId nytimes, URL on timeout.com → mismatch (same tier, still an attribution error)', () => {
  const r = classifyOutletHostMismatch({ outletId: 'nytimes', url: EBT_TIMEOUT_URL }, registry);
  assert.equal(r.mismatch, true);
  assert.equal(r.outletId, 'nytimes');
  assert.equal(r.hostOutletId, 'timeout');
  assert.equal(r.host, 'timeout.com');
  assert.equal(r.outletTier, 1);
  assert.equal(r.hostOutletTier, 1);
  assert.equal(r.tiersDiffer, false);
  assert.match(r.reason, /belongs to registered outlet "timeout"/);
});

test('same outlet: nytimes on nytimes.com (and its registered subdomain alias) is not a mismatch', () => {
  const own = classifyOutletHostMismatch({ outletId: 'nytimes', url: 'https://www.nytimes.com/2026/03/12/theater/every-brilliant-thing-review-daniel-radcliffe.html' }, registry);
  assert.equal(own.mismatch, false);
  assert.equal(own.reason, 'outlet-owns-host');
  const sub = classifyOutletHostMismatch({ outletId: 'nytimes', url: 'http://theater.nytimes.com/2009/03/10/theater/reviews/10thir.html' }, registry);
  assert.equal(sub.mismatch, false);
  assert.equal(sub.reason, 'outlet-owns-host');
});

test('tiers differ: a T3 outlet id on an NYT URL borrows nothing but is flagged with tiersDiffer', () => {
  const r = classifyOutletHostMismatch({ outletId: 'about-entertainment', url: 'http://theater.nytimes.com/2009/03/10/theater/reviews/10thir.html' }, registry);
  assert.equal(r.mismatch, true);
  assert.equal(r.hostOutletId, 'nytimes');
  assert.equal(r.outletTier, 3);
  assert.equal(r.hostOutletTier, 1);
  assert.equal(r.tiersDiffer, true);
  assert.match(r.reason, /tiers differ/);
});

test('dual-hosted brands: timeout-london on timeout.com/newyork and timeout on timeout.com/london both own the host', () => {
  assert.equal(classifyOutletHostMismatch({ outletId: 'timeout-london', url: EBT_TIMEOUT_URL }, registry).reason, 'outlet-owns-host');
  assert.equal(classifyOutletHostMismatch({ outletId: 'timeout', url: 'https://www.timeout.com/london/theatre/abigails-party-5-review' }, registry).reason, 'outlet-owns-host');
  // Edition splits sharing one host.
  if (registry.outlets['sunday-telegraph'] && registry.outlets['sunday-telegraph'].domain === 'telegraph.co.uk') {
    assert.equal(classifyOutletHostMismatch({ outletId: 'sunday-telegraph', url: 'https://www.telegraph.co.uk/theatre/what-to-see/x-review/' }, registry).mismatch, false);
  }
});

test('wire services syndicate on partner hosts by design → exempt', () => {
  const r = classifyOutletHostMismatch({ outletId: 'ap', url: 'https://www.huffpost.com/entry/review-hamilton-broadway' }, registry);
  assert.equal(r.mismatch, false);
  assert.equal(r.reason, 'wire-service');
});

test('newspapers.com and web.archive.org provenance → exempt', () => {
  assert.ok(HOST_MISMATCH_EXEMPT_HOSTS.includes('newspapers.com') && HOST_MISMATCH_EXEMPT_HOSTS.includes('web.archive.org'));
  for (const url of [
    'https://www.newspapers.com/article/daily-news-hello-dolly-review/12345/',
    'https://web.archive.org/web/20190101000000/https://www.timeout.com/newyork/theater/x-review',
  ]) {
    const r = classifyOutletHostMismatch({ outletId: 'nytimes', url }, registry);
    assert.equal(r.mismatch, false, url);
    assert.equal(r.reason, 'archival-host', url);
  }
});

test('hosts nobody registered, unregistered outlet ids and unusable input never flag', () => {
  assert.equal(classifyOutletHostMismatch({ outletId: 'nytimes', url: 'https://some-critics-personal-blog.example/2026/03/every-brilliant-thing/' }, registry).reason, 'host-not-registered');
  assert.equal(classifyOutletHostMismatch({ outletId: 'not-a-real-outlet-xyz', url: EBT_TIMEOUT_URL }, registry).reason, 'outlet-not-registered');
  assert.equal(classifyOutletHostMismatch({ outletId: 'nytimes', url: 'not a url' }, registry).reason, 'unparseable-url');
  assert.equal(classifyOutletHostMismatch({ outletId: 'nytimes' }, registry).mismatch, false);
  assert.equal(classifyOutletHostMismatch({ url: EBT_TIMEOUT_URL }, registry).mismatch, false);
  assert.equal(classifyOutletHostMismatch({ outletId: 'nytimes', url: EBT_TIMEOUT_URL }, null).mismatch, false);
});

test('an alias-form outlet id is canonicalised before the comparison', () => {
  const { normalizeOutlet } = require(path.join(ROOT, 'scripts/lib/review-normalization.js'));
  const canonical = normalizeOutlet('The New York Times');
  if (canonical === 'nytimes') {
    const r = classifyOutletHostMismatch({ outletId: 'The New York Times', url: EBT_TIMEOUT_URL }, registry);
    assert.equal(r.outletId, 'nytimes');
    assert.equal(r.mismatch, true);
  }
});

test('wiring: the rebuild stamps outletHostMismatch on the emitted row, logs one advisory line and prints the count', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  assert.ok(src.includes('classifyOutletHostMismatch({ outletId: review.outletId, url: review.url }, outletRegistry)'), 'classified on the emitted row');
  assert.ok(src.includes('review.outletHostMismatch = true;'), 'audit-only field set');
  assert.ok(src.includes('[OUTLET-HOST-MISMATCH]'), 'advisory line');
  assert.ok(src.includes('Outlet id vs URL host mismatches (audit-only'), 'stats print');
  const stamp = src.indexOf('review.outletHostMismatch = true;');
  const push = src.indexOf('allReviews.push(review);');
  assert.ok(stamp > 0 && push > stamp, 'stamped before the row is emitted');
  // Never an exclusion: no return / logExclusion between the classification and the push.
  const between = src.slice(src.indexOf('const hostMismatch = classifyOutletHostMismatch('), push);
  assert.ok(!/logExclusion\(|\breturn;/.test(between), 'the advisory never excludes');
});
