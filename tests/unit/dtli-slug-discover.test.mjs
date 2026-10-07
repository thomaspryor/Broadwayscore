/**
 * Unit tests for scripts/lib/dtli-slug-discover.js — uses injected fetchSlugs
 * so tests don't hit DTLI's sitemaps.
 *
 * Run: node --test tests/unit/dtli-slug-discover.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  discoverDtliSlug,
  scoreSlug,
  tokensFromTitle,
  slugify,
  extractShowSlugs,
} = require('../../scripts/lib/dtli-slug-discover.js');

// Real slugs pulled from DTLI sitemaps (sampled) — representative of structure.
const REAL_SLUGS = [
  'fear-of-13',
  'fear-of-13-bway',
  'proof-2',
  'proof-bway-2026',
  'titanique',
  'titanique-off-broadway',
  'death-of-a-salesman-2026',
  'hamlet-off-broadway',
  'hamlet-bway',
  'maybe-happy-ending-bway',
  'cabaret-at-the-kit-kat-club-west-end',
  'frozen-3',
  'company-2',
];

describe('slugify + tokensFromTitle', () => {
  it('slugifies titles correctly', () => {
    assert.strictEqual(slugify('The Fear of 13'), 'the-fear-of-13');
    assert.strictEqual(slugify("Death of a Salesman"), 'death-of-a-salesman');
  });

  it('drops stopwords and short tokens', () => {
    assert.deepStrictEqual(tokensFromTitle('The Fear of 13'), ['fear', '13']);
    assert.deepStrictEqual(tokensFromTitle('Death of a Salesman'), ['death', 'salesman']);
  });
});

describe('extractShowSlugs', () => {
  it('pulls show slugs from sitemap XML', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://didtheylikeit.com/shows/hamlet-bway/</loc></url>
        <url><loc>https://didtheylikeit.com/shows/titanique/</loc></url>
        <url><loc>https://didtheylikeit.com/shows/titanique/review-nyt/</loc></url>
        <url><loc>https://didtheylikeit.com/shows/all/</loc></url>
      </urlset>`;
    const slugs = extractShowSlugs(xml);
    assert.deepStrictEqual(slugs.sort(), ['hamlet-bway', 'titanique']);
  });
});

describe('scoreSlug', () => {
  it('exact id-base match scores highest', () => {
    const show = { id: 'proof-2026', slug: 'proof-2026', title: 'Proof', category: 'broadway' };
    // 'proof-bway-2026' strips market suffix '-bway' to 'proof' which matches idBase 'proof' → +12
    // but also '2026' is a year, not a market suffix. Let me check: the regex strips -bway or -broadway or -off-broadway etc at END. "proof-bway-2026" ends in -2026 not any recognized suffix.
    // Best match should be 'proof-2' (no market suffix, matches id base 'proof' after stripping digit-only suffix? no, we don't strip generic suffixes)
    // Actually — 'proof-bway-2026' ≠ 'proof'. 'proof-2' ≠ 'proof'. No exact match available.
    // 'fear-of-13-bway' strips to 'fear-of-13' — exact titleSlug for 'The Fear of 13'.
    // Let me fix this test to use The Fear of 13 instead.
    const show2 = { id: 'the-fear-of-13-2026', slug: 'the-fear-of-13-2026', title: 'The Fear of 13', category: 'broadway' };
    const scored = REAL_SLUGS.map(slug => ({ slug, ...scoreSlug(slug, show2) }));
    const best = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)[0];
    assert.strictEqual(best.slug, 'fear-of-13-bway', `expected fear-of-13-bway, got ${best.slug} (score ${best.score})`);
  });

  it('prefers market-suffixed slug for Broadway show when both exist', () => {
    const show = { id: 'hamlet-2025', slug: 'hamlet-2025', title: 'Hamlet', category: 'broadway' };
    const withBway = scoreSlug('hamlet-bway', show).score;
    const withOb = scoreSlug('hamlet-off-broadway', show).score;
    assert.ok(withBway > withOb, `bway (${withBway}) should beat off-broadway (${withOb}) for Broadway show`);
  });

  it('prefers -off-broadway for off-Broadway show', () => {
    const show = { id: 'hamlet-ob-2026', slug: 'hamlet-ob-2026', title: 'Hamlet', category: 'off-broadway' };
    const withOb = scoreSlug('hamlet-off-broadway', show).score;
    const withBway = scoreSlug('hamlet-bway', show).score;
    assert.ok(withOb > withBway);
  });

  it('rejects unrelated slugs', () => {
    const show = { id: 'hamilton-2015', slug: 'hamilton-2015', title: 'Hamilton', category: 'broadway' };
    const s = scoreSlug('frozen-3', show).score;
    assert.strictEqual(s, 0);
  });
});

describe('discoverDtliSlug', () => {
  const fetchSlugs = async () => REAL_SLUGS;

  it('finds Fear of 13 Broadway production from sitemap', async () => {
    const show = { id: 'the-fear-of-13-2026', slug: 'the-fear-of-13-2026', title: 'The Fear of 13', category: 'broadway' };
    const r = await discoverDtliSlug(show, { fetchSlugs });
    assert.strictEqual(r.slug, 'fear-of-13-bway');
    assert.strictEqual(r.url, 'https://didtheylikeit.com/shows/fear-of-13-bway/');
  });

  it('finds Titanique (off-Broadway variant when show is off-Broadway)', async () => {
    const show = { id: 'titanique-ob-2024', slug: 'titanique-ob-2024', title: 'Titanique', category: 'off-broadway' };
    const r = await discoverDtliSlug(show, { fetchSlugs });
    assert.strictEqual(r.slug, 'titanique-off-broadway');
  });

  it('returns null for show not present in sitemap', async () => {
    const show = { id: 'hamilton-2015', slug: 'hamilton-2015', title: 'Hamilton', category: 'broadway' };
    const r = await discoverDtliSlug(show, { fetchSlugs });
    assert.strictEqual(r.slug, null);
  });

  it('returns null on empty sitemap', async () => {
    const r = await discoverDtliSlug(
      { id: 'anything', slug: 'anything', title: 'Anything', category: 'broadway' },
      { fetchSlugs: async () => [] }
    );
    assert.strictEqual(r.slug, null);
  });
});
