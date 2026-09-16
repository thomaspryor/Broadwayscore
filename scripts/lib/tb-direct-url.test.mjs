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

test('buildTbCandidateUrls tries dated short-title variants before the bare undated one', () => {
  // The bare short-title URL (Beaches.html) has no publish-date signal to verify against,
  // so for a same-titled revival it could match the wrong production's page. Dated variants
  // must be tried first so a correctly-dated page wins when one exists.
  const urls = buildTbCandidateUrls('Beaches, A New Musical', 2026);
  const datedIdx = urls.indexOf('https://www.talkinbroadway.com/page/world/Beaches2026.html');
  const bareIdx = urls.indexOf('https://www.talkinbroadway.com/page/world/Beaches.html');
  assert.ok(datedIdx !== -1 && bareIdx !== -1);
  assert.ok(datedIdx < bareIdx, `expected dated variant before bare variant, got: ${JSON.stringify(urls)}`);
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
