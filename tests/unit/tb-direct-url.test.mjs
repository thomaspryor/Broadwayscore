/**
 * Unit tests for scripts/lib/tb-direct-url.js
 *
 * Run: node --test tests/unit/tb-direct-url.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildTbCandidateUrls,
  verifyTbPage,
  tryTbDirectUrl,
  _internal,
} = require('../../scripts/lib/tb-direct-url.js');

const { toCamelSlug, extractTitle, hasBylineSignal, extractPublishDateCandidate, withinDateWindow } = _internal;

function realishReviewHtml({
  title = 'Fallen Angels - Talkin\' Broadway',
  body = 'Reviewed by Matthew Murray — this revival of Noel Coward\'s Fallen Angels is the kind of verdict critics love to write. Recommended.',
  date = 'April 19, 2026',
  padBytes = 2000,
} = {}) {
  const pad = 'x'.repeat(padBytes);
  return `<html><head><title>${title}</title></head><body><p>${date}</p><p>${body}</p><p>${pad}</p></body></html>`;
}

describe('toCamelSlug', () => {
  it('handles standard titles', () => {
    assert.strictEqual(toCamelSlug('Fallen Angels'), 'FallenAngels');
    assert.strictEqual(toCamelSlug('Meteor Shower'), 'MeteorShower');
  });
  it('lowercases middle articles', () => {
    assert.strictEqual(toCamelSlug('A Doll\'s House'), 'ADollsHouse');
    assert.strictEqual(toCamelSlug('Once Upon a One More Time'), 'OnceUponaOneMoreTime');
  });
  it('preserves Roman numerals', () => {
    assert.strictEqual(toCamelSlug('Part II'), 'PartII');
    assert.strictEqual(toCamelSlug('Henry V'), 'HenryV');
  });
  it('does not uppercase English words that look like numerals', () => {
    // strict numeral regex should NOT match "Did" or "Mix"
    assert.strictEqual(toCamelSlug('Did Mix'), 'DidMix');
  });
});

describe('buildTbCandidateUrls', () => {
  it('returns 4 variants', () => {
    const urls = buildTbCandidateUrls('Fallen Angels', 2026);
    assert.strictEqual(urls.length, 4);
    assert.ok(urls[0].includes('FallenAngels2026.html'));
    assert.ok(urls[1].includes('FallenAngels26.html'));
    assert.ok(urls[2].includes('FallenAngels.html'));
    assert.ok(urls[3].includes('fallenangels2026.html'));
  });
});

describe('extractTitle + hasBylineSignal', () => {
  it('extracts a title tag', () => {
    assert.strictEqual(extractTitle('<html><head><title>Hello World</title></head></html>'), 'Hello World');
  });
  it('detects byline', () => {
    assert.strictEqual(hasBylineSignal('Reviewed by Matthew Murray, cont.'), true);
    assert.strictEqual(hasBylineSignal('by Howard Kissel at some venue'), true);
    assert.strictEqual(hasBylineSignal('a reference to some content'), false);
  });
});

describe('extractPublishDateCandidate', () => {
  it('parses TB date formats', () => {
    const d = extractPublishDateCandidate('<p>April 19, 2026</p>');
    assert.ok(d instanceof Date);
    assert.strictEqual(d.getUTCFullYear(), 2026);
  });
  it('returns null on garbage', () => {
    assert.strictEqual(extractPublishDateCandidate('no date here'), null);
  });
});

describe('withinDateWindow', () => {
  const opening = '2026-04-19';
  it('accepts same-day publish', () => {
    assert.strictEqual(withinDateWindow(new Date('2026-04-19'), opening), true);
  });
  it('accepts day-after for revival', () => {
    assert.strictEqual(withinDateWindow(new Date('2026-04-20'), opening, { isRevival: true }), true);
  });
  it('rejects old-production review for revival', () => {
    // 10 years before opening (old production)
    assert.strictEqual(withinDateWindow(new Date('2016-04-19'), opening, { isRevival: true }), false);
  });
  it('accepts 5-day-pre review for non-revival', () => {
    assert.strictEqual(withinDateWindow(new Date('2026-04-14'), opening, { isRevival: false }), true);
  });
  it('returns null on missing publishDate', () => {
    assert.strictEqual(withinDateWindow(null, opening), null);
  });
  it('returns true when no openingDate given', () => {
    assert.strictEqual(withinDateWindow(new Date(), ''), true);
  });
});

describe('verifyTbPage', () => {
  it('accepts a valid recent review', () => {
    const html = realishReviewHtml();
    const res = verifyTbPage(html, { showTitle: 'Fallen Angels', openingDate: '2026-04-19' });
    assert.strictEqual(res.ok, true);
  });
  it('rejects soft-404 (short content)', () => {
    const res = verifyTbPage('<html><head><title>Fallen Angels</title></head><body>404</body></html>',
      { showTitle: 'Fallen Angels', openingDate: '2026-04-19' });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /too short/);
  });
  it('rejects wrong-show title', () => {
    const html = realishReviewHtml({ title: 'Hamilton - TB' });
    const res = verifyTbPage(html, { showTitle: 'Fallen Angels', openingDate: '2026-04-19' });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /title mismatch/);
  });
  it('rejects page with no review signals', () => {
    // Long enough, title matches, but no byline and no verdict keyword
    const pad = 'x'.repeat(2000);
    const html = `<html><head><title>Fallen Angels - TB</title></head><body><p>April 19, 2026</p><p>${pad}</p></body></html>`;
    const res = verifyTbPage(html, { showTitle: 'Fallen Angels', openingDate: '2026-04-19' });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /no review signal/);
  });
  it('rejects old-production review on a revival URL', () => {
    const html = realishReviewHtml({ date: 'April 19, 2016' });
    const res = verifyTbPage(html, { showTitle: 'Fallen Angels', openingDate: '2026-04-19', isRevival: true });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /publishDate/);
  });
  it('accepts old date for non-revival (no strict lower bound)', () => {
    // Non-revival, old review would still be within wider window
    const html = realishReviewHtml({ date: 'April 13, 2026' });
    const res = verifyTbPage(html, { showTitle: 'Fallen Angels', openingDate: '2026-04-19', isRevival: false });
    assert.strictEqual(res.ok, true);
  });
});

describe('tryTbDirectUrl (integration with injected fetchPage)', () => {
  it('returns found=true on first success', async () => {
    async function fetchPage(url) {
      return { content: realishReviewHtml(), format: 'html', source: 'mock' };
    }
    const res = await tryTbDirectUrl({
      show: { id: 'fallen-angels-2026', title: 'Fallen Angels', openingDate: '2026-04-19' },
      year: 2026,
      fetchPage,
      logger: { log: () => {} },
    });
    assert.strictEqual(res.found, true);
    assert.match(res.url, /FallenAngels2026\.html$/);
    assert.strictEqual(res.source, 'direct-url-construction');
  });
  it('falls through all variants on 404-like content', async () => {
    async function fetchPage(url) {
      return { content: '<html><body>404</body></html>', format: 'html', source: 'mock' };
    }
    const res = await tryTbDirectUrl({
      show: { id: 'fallen-angels-2026', title: 'Fallen Angels', openingDate: '2026-04-19' },
      year: 2026,
      fetchPage,
      logger: { log: () => {} },
    });
    assert.strictEqual(res.found, false);
    assert.match(res.reason, /all 4 candidates/);
  });
  it('uses overrideUrl alone when provided', async () => {
    let called = 0;
    async function fetchPage(url) {
      called++;
      return { content: realishReviewHtml(), format: 'html', source: 'mock' };
    }
    const res = await tryTbDirectUrl({
      show: { id: 'fallen-angels-2026', title: 'Fallen Angels', openingDate: '2026-04-19' },
      year: 2026,
      overrideUrl: 'https://www.talkinbroadway.com/custom.html',
      fetchPage,
      logger: { log: () => {} },
    });
    assert.strictEqual(called, 1);
    assert.strictEqual(res.found, true);
    assert.strictEqual(res.source, 'direct-url-override');
  });
  it('rejects revival old-production even if page verifies otherwise', async () => {
    async function fetchPage(url) {
      return { content: realishReviewHtml({ date: 'May 1, 2017' }), format: 'html', source: 'mock' };
    }
    const res = await tryTbDirectUrl({
      show: { id: 'fallen-angels-2026', title: 'Fallen Angels', openingDate: '2026-04-19' },
      year: 2026,
      isRevival: true,
      fetchPage,
      logger: { log: () => {} },
    });
    assert.strictEqual(res.found, false);
  });
});
