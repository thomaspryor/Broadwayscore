import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// BRO-90: the NYC census (S2-T1) + t1-coverage-ledger surfaced junk and
// duplicate outletIds as phantom GAP cells — 'buy-tickets-directly-from-the-
// theatre' (a Playbill Verdict CTA link parsed as an outlet), 'the-la-times'
// (a separate registry outlet duplicating 'latimes'), and 'about-entertainment'
// (a stale theater.nytimes.com URL mismatched against byline text).

const { unionCensus, parsePlaybillVerdict } = require('../../scripts/lib/review-census.js');
const { isJunkOutlet, normalizeOutlet } = require('../../scripts/lib/review-normalization.js');

test('unionCensus drops a CTA link parsed as an outlet ("buy tickets directly")', () => {
  const census = unionCensus([{
    source: 'playbill-verdict',
    reviews: [
      {
        outlet: 'Buy Tickets Directly from the Theatre',
        outletId: 'buy-tickets-directly-from-the-theatre',
        critic: 'Unknown',
        stars: null,
        url: 'https://someventuretheatre.example.com/tickets',
      },
      { outlet: 'Vulture', outletId: 'vulture', critic: 'Sara Holdren', stars: null, url: 'https://www.vulture.com/review' },
    ],
  }]);
  const ids = census.entries.map((e) => e.outletId);
  assert.ok(!ids.includes('buy-tickets-directly-from-the-theatre'), 'CTA junk outletId must not survive the union');
  assert.ok(ids.includes('vulture'), 'a real outlet in the same batch is unaffected');
});

test('isJunkOutlet rejects ticket/box-office CTA link text generically, not just the one BRO-90 string', () => {
  for (const name of [
    'Buy Tickets Directly from the Theatre',
    'buy-tickets-directly-from-the-theatre',
    'Get Tickets Now',
    'Box Office',
  ]) {
    assert.equal(isJunkOutlet(name), true, `expected junk: ${name}`);
  }
  // Sanity: real outlets with short/plain names must not be caught by the new heuristic.
  for (const name of ['Vulture', 'The New York Times', 'TheaterMania']) {
    assert.equal(isJunkOutlet(name), false, `expected NOT junk: ${name}`);
  }
});

test('parsePlaybillVerdict filters junk CTA anchor text end-to-end from raw article HTML', () => {
  const html = `<html><body><article>
    <p>
      <a href="https://someventuretheatremarquee.example.com/box-office/buy-tickets">Buy Tickets Directly from the Theatre</a>
      <a href="https://www.vulture.com/2026/01/some-show-review.html">Vulture</a>
    </p>
  </article></body></html>`;
  const rows = parsePlaybillVerdict(html, 'some-show-2026');
  const ids = rows.map((r) => r.outletId);
  assert.ok(!ids.includes('buy-tickets-directly-from-the-theatre'), 'CTA link text must not become an outletId');
  assert.ok(ids.includes('vulture'), 'a real outlet link on the same page still resolves');
});

test('the-la-times normalizes to latimes (not a separate outlet)', () => {
  for (const text of ['The LA Times', 'The La Times', 'the-la-times', 'LA Times', 'the la times']) {
    assert.equal(normalizeOutlet(text), 'latimes', `"${text}" should resolve to latimes`);
  }
});

test('outlet-registry.json has no standalone "the-la-times" outlet entry (it is an alias of latimes)', () => {
  const registryPath = path.join(process.cwd(), 'data', 'outlet-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  assert.equal(registry.outlets['the-la-times'], undefined, '"the-la-times" must not be its own registry outlet');
  assert.ok(registry.outlets.latimes, 'latimes outlet must exist');
  const aliases = (registry.outlets.latimes.aliases || []).map((a) => a.toLowerCase());
  assert.ok(aliases.includes('the-la-times'), 'latimes.aliases must include "the-la-times"');
});

test('unionCensus prefers URL-based resolution over stale/mismatched byline text ("about-entertainment" from a nytimes URL)', () => {
  const census = unionCensus([{
    source: 'bww-roundup',
    reviews: [
      {
        outlet: 'About Entertainment',
        critic: 'Ben Brantley',
        stars: null,
        url: 'https://theater.nytimes.com/2010/some-archived-article.html',
      },
    ],
  }]);
  const ids = census.entries.map((e) => e.outletId);
  assert.ok(!ids.includes('about-entertainment'), 'stale byline text must not win over a resolvable nytimes URL');
  assert.ok(ids.includes('nytimes'), 'the URL domain must resolve to nytimes');
});

test('unionCensus still resolves a genuinely-unresolvable-by-URL row via outlet text (no url present)', () => {
  const census = unionCensus([{
    source: 'bww-roundup',
    reviews: [{ outlet: 'The LA Times', critic: 'Charles McNulty', stars: null, url: '' }],
  }]);
  const ids = census.entries.map((e) => e.outletId);
  assert.ok(ids.includes('latimes'), 'text-only fallback still works and resolves the alias correctly');
  assert.ok(!ids.includes('the-la-times'), 'no duplicate outletId leaks through');
});
