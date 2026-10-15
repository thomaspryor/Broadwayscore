// Regression coverage for TB URL candidate generation and page verification.
// BRO-1013: buildTbCandidateUrls missed the short-title variant for comma-subtitled
// shows (e.g. "Beaches, A New Musical" → real TB URL is "Beaches.html", not
// "BeachesaNewMusical*.html"). Beaches 2026-04-22 opening night, 24+ hour discovery gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTbCandidateUrls, verifyTbPage } = require('./tb-direct-url.js');

test('buildTbCandidateUrls includes the short-title variant for comma-subtitled shows', () => {
  const urls = buildTbCandidateUrls('Beaches, A New Musical', 2026);
  assert.ok(
    urls.includes('https://www.talkinbroadway.com/page/world/Beaches.html'),
    `expected Beaches.html among candidates, got: ${JSON.stringify(urls)}`
  );
  // Full-title variants must still be generated (tried first, cheapest to verify).
  assert.ok(urls.includes('https://www.talkinbroadway.com/page/world/BeachesaNewMusical2026.html'));
  assert.ok(urls.includes('https://www.talkinbroadway.com/page/world/BeachesaNewMusical.html'));
});

test('buildTbCandidateUrls also emits year-suffixed short-title variants', () => {
  const urls = buildTbCandidateUrls('Beaches, A New Musical', 2026);
  assert.ok(urls.includes('https://www.talkinbroadway.com/page/world/Beaches2026.html'));
  assert.ok(urls.includes('https://www.talkinbroadway.com/page/world/Beaches26.html'));
  assert.ok(urls.includes('https://www.talkinbroadway.com/page/world/beaches2026.html'));
});

test('buildTbCandidateUrls tries ALL dated short-title variants (including lowercase) before the bare undated one', () => {
  // The bare short-title URL (Beaches.html) has no publish-date signal to verify against,
  // so for a same-titled revival it could match the wrong production's page. Every dated
  // variant — camel-case AND lowercase — must be tried before the bare one.
  const urls = buildTbCandidateUrls('Beaches, A New Musical', 2026);
  const bareIdx = urls.indexOf('https://www.talkinbroadway.com/page/world/Beaches.html');
  const datedIdxs = [
    urls.indexOf('https://www.talkinbroadway.com/page/world/Beaches2026.html'),
    urls.indexOf('https://www.talkinbroadway.com/page/world/Beaches26.html'),
    urls.indexOf('https://www.talkinbroadway.com/page/world/beaches2026.html'),
  ];
  assert.ok(bareIdx !== -1 && datedIdxs.every(i => i !== -1));
  for (const i of datedIdxs) {
    assert.ok(i < bareIdx, `expected dated variant at ${i} before bare variant at ${bareIdx}, got: ${JSON.stringify(urls)}`);
  }
});

test('buildTbCandidateUrls does not duplicate when short title equals full title camel-slug', () => {
  const urls = buildTbCandidateUrls('Hamilton', 2015);
  const unique = new Set(urls);
  assert.equal(urls.length, unique.size, 'no short-title variants should be added for non-subtitled titles');
  assert.equal(urls.length, 4);
});

test('buildTbCandidateUrls suppresses short-title variants below the 4-char floor', () => {
  // "Oh, Mary!" → short title "Oh" (2 chars) — too generic to build a slug from
  // (would collide with any title containing "oh"). Same guard as verifyTbPage.
  const urls = buildTbCandidateUrls('Oh, Mary!', 2024);
  assert.equal(urls.length, 4, `expected no short-title variants, got: ${JSON.stringify(urls)}`);
  assert.ok(!urls.some(u => /\/Oh(\d|\.html)/.test(u)));
});

test('buildTbCandidateUrls uses normalized (not raw) length for the floor', () => {
  // "Oh!!, A Musical" -> short title "Oh!!" is 4 raw chars (would pass a naive raw-length
  // check) but normalizes to "oh" (2 chars) -- must still be suppressed, matching the
  // normalized check verifyTbPage applies to the same short title.
  const urls = buildTbCandidateUrls('Oh!!, A Musical', 2026);
  assert.equal(urls.length, 4, `expected no short-title variants, got: ${JSON.stringify(urls)}`);
});

test('buildTbCandidateUrls handles titles with no comma normally (4 variants)', () => {
  const urls = buildTbCandidateUrls('Hadestown', 2019);
  assert.deepEqual(urls, [
    'https://www.talkinbroadway.com/page/world/Hadestown2019.html',
    'https://www.talkinbroadway.com/page/world/Hadestown19.html',
    'https://www.talkinbroadway.com/page/world/Hadestown.html',
    'https://www.talkinbroadway.com/page/world/hadestown2019.html',
  ]);
});

test('verifyTbPage accepts a page titled with the short title only', () => {
  const html = `<html><head><title>Beaches - Talkin' Broadway</title></head><body>
    ${'x'.repeat(900)}
    Reviewed by Howard Miller
  </body></html>`;
  const result = verifyTbPage(html, { showTitle: 'Beaches, A New Musical', openingDate: null });
  assert.equal(result.ok, true, result.reason);
});

// BRO-4437: Off-Broadway TB reviews arrive via Show Score as /page/ob/index.html.
const { isTbObIndexUrl, extractTbReviewDate, buildTbObCandidateUrls, resolveTbObIndexUrl } = require('./tb-direct-url.js');
const silent = { log() {} };

test('isTbObIndexUrl matches only the OB front page', () => {
  assert.equal(isTbObIndexUrl('https://www.talkinbroadway.com/page/ob/index.html'), true);
  assert.equal(isTbObIndexUrl('https://www.talkinbroadway.com/page/ob/03_29_26.html'), false);
  assert.equal(isTbObIndexUrl('https://www.talkinbroadway.com/page/world/index.html'), false);
});

test('extractTbReviewDate reads the header date line, ignores later body dates', () => {
  const text = 'Theatre Review by Marc Miller - September 29, 2026\n' + 'x'.repeat(2000) + ' January 3, 2020';
  assert.deepEqual(extractTbReviewDate(text), { y: 2026, m: 9, d: 29 });
  assert.equal(extractTbReviewDate('no date here'), null);
});

test('buildTbObCandidateUrls builds MM_DD_YY with b/c suffixes', () => {
  assert.deepEqual(buildTbObCandidateUrls({ y: 2026, m: 9, d: 29 }), [
    'https://www.talkinbroadway.com/page/ob/09_29_26.html',
    'https://www.talkinbroadway.com/page/ob/09_29_26b.html',
    'https://www.talkinbroadway.com/page/ob/09_29_26c.html',
  ]);
  assert.deepEqual(buildTbObCandidateUrls(null), []);
});

test('resolveTbObIndexUrl takes the candidate matching title and critic, skips others', async () => {
  const page = (title, critic) => ({ content: `<html><head><title>${title} - Talkin' Broadway</title></head><body>${'x'.repeat(900)} Theatre Review by ${critic} - September 29, 2026</body></html>` });
  const pages = {
    'https://www.talkinbroadway.com/page/ob/09_29_26.html': page('Other Show', 'Marc Miller'),
    'https://www.talkinbroadway.com/page/ob/09_29_26b.html': page('Degenerates', 'Someone Else'),
    'https://www.talkinbroadway.com/page/ob/09_29_26c.html': page('Degenerates', 'Marc Miller'),
  };
  const fetchPage = async (u) => pages[u];
  const r = await resolveTbObIndexUrl({
    url: 'https://www.talkinbroadway.com/page/ob/index.html',
    reviewText: 'Theatre Review by Marc Miller - September 29, 2026\nbody',
    showTitle: 'Degenerates', criticName: "Marc Miller", fetchPage, logger: silent,
  });
  assert.equal(r.found, true);
  assert.equal(r.url, 'https://www.talkinbroadway.com/page/ob/09_29_26c.html');
});

test('resolveTbObIndexUrl refuses non-index urls and undated text', async () => {
  const fetchPage = async () => { throw new Error('should not fetch'); };
  assert.equal((await resolveTbObIndexUrl({ url: 'https://www.talkinbroadway.com/page/ob/03_29_26.html', reviewText: 'x', fetchPage })).found, false);
  assert.equal((await resolveTbObIndexUrl({ url: 'https://www.talkinbroadway.com/page/ob/index.html', reviewText: 'no date', fetchPage })).found, false);
});

test('resolveTbObIndexUrl needs a critic name and ignores Jr. suffix', async () => {
  const html = `<html><head><title>Degenerates - Talkin' Broadway</title></head><body>${'x'.repeat(900)} Theatre Review by Marc Miller - September 29, 2026</body></html>`;
  const fetchPage = async () => ({ content: html });
  const base = { url: 'https://www.talkinbroadway.com/page/ob/index.html', reviewText: 'Theatre Review by Marc Miller - September 29, 2026', showTitle: 'Degenerates', fetchPage, logger: silent };
  assert.equal((await resolveTbObIndexUrl({ ...base, criticName: '' })).found, false);
  assert.equal((await resolveTbObIndexUrl({ ...base, criticName: 'Unknown' })).found, false);
  assert.equal((await resolveTbObIndexUrl({ ...base, criticName: 'Marc Miller Jr.' })).found, true);
  assert.equal((await resolveTbObIndexUrl({ ...base, criticName: 'Ill Mill' })).found, false);
});
