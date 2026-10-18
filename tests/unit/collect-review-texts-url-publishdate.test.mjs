// BRO-5351: collect-review-texts.js must never store a URL-derived date as
// publishDate (CLAUDE.md rule 3). The decision lives in
// scripts/lib/publish-date-provenance.js (bodyPublishDateFallback); this test
// requires the real function and pins the call site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { bodyPublishDateFallback } = require(path.join(ROOT, 'scripts/lib/publish-date-provenance.js'));
const { extractDateFromUrl } = require(path.join(ROOT, 'scripts/lib/rebuild-helpers.js'));
const { extractDateFromText } = require(path.join(ROOT, 'scripts/lib/body-date-mismatch.js'));

const DASH_URL = 'https://www.latimes.com/entertainment/story/2025-04-22/some-show-review';

test('URL date alone is never returned as publishDate', () => {
  const urlDate = extractDateFromUrl(DASH_URL);
  assert.equal(urlDate.source, 'url-dash');
  const r = bodyPublishDateFallback({ textDate: null, urlDate });
  assert.equal(r.publishDate, null);
  assert.equal(r.reason, 'no-body-date');
  assert.equal(r.dateSource, undefined);
});

test('byline date wins and is marked text-regex when it agrees with the URL', () => {
  const textDate = extractDateFromText('By A Critic\nApril 22, 2025\n' + 'The revival opens with a bang. '.repeat(10));
  assert.equal(textDate, '2025-04-22');
  const r = bodyPublishDateFallback({ textDate, urlDate: extractDateFromUrl(DASH_URL) });
  assert.deepEqual(r, { publishDate: '2025-04-22', dateSource: 'text-regex' });
});

test('byline date is stored when the URL has no date', () => {
  const r = bodyPublishDateFallback({ textDate: '2025-05-01', urlDate: extractDateFromUrl('https://example.com/reviews/some-show') });
  assert.deepEqual(r, { publishDate: '2025-05-01', dateSource: 'text-regex' });
});

test('byline that disagrees with the URL date stores nothing (left to rebuild backfill)', () => {
  const r = bodyPublishDateFallback({ textDate: '2025-06-30', urlDate: extractDateFromUrl(DASH_URL) });
  assert.equal(r.publishDate, null);
  assert.equal(r.reason, 'body-url-conflict');
});

test('year-only or month-only URL results never veto a byline date', () => {
  const yearOnly = extractDateFromUrl('https://example.com/2025/some-show-review');
  assert.equal(yearOnly.date, null);
  assert.deepEqual(bodyPublishDateFallback({ textDate: '2025-05-01', urlDate: yearOnly }), { publishDate: '2025-05-01', dateSource: 'text-regex' });
  const ym = extractDateFromUrl('https://someblog.blogspot.com/2025/04/show.html');
  assert.equal(ym.date, '2025-04');
  assert.deepEqual(bodyPublishDateFallback({ textDate: '2025-04-03', urlDate: ym }), { publishDate: '2025-04-03', dateSource: 'text-regex' });
});

test('malformed inputs are rejected', () => {
  assert.equal(bodyPublishDateFallback({ textDate: 'April 2025', urlDate: null }).publishDate, null);
  assert.equal(bodyPublishDateFallback().publishDate, null);
});

test('collect-review-texts.js never assigns a URL date to publishDate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/collect-review-texts.js'), 'utf8');
  assert.equal(src.includes('Extracted publishDate from URL'), false);
  assert.match(src, /bodyPublishDateFallback\(\{/);
  // No assignment of an extractDateFromUrl result (or its source) onto the record.
  assert.doesNotMatch(src, /data\.publishDate\s*=\s*urlDate/i);
  assert.doesNotMatch(src, /data\.dateSource\s*=\s*urlDate/i);
});

test('ingestGateDate: stored date wins, URL date fills in, a vetoed URL date is ignored, compact URL defers to a later byline', () => {
  const { ingestGateDate } = require(path.join(ROOT, 'scripts', 'lib', 'publish-date-provenance.js'));
  assert.equal(ingestGateDate({ publishDate: '2024-05-01', url: 'https://x.com/2020/01/02/a' }), '2024-05-01');
  assert.equal(ingestGateDate({ url: 'https://x.com/2020/01/02/a' }), '2020-01-02');
  assert.equal(ingestGateDate({ url: 'https://x.com/2020/01/02/a' }, { bylineVetoed: true }), null);
  assert.equal(ingestGateDate({ url: 'https://x.com/2020/01/a' }), null);
  assert.equal(ingestGateDate({}), null);
});

test('collector wires the gate through ingestGateDate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect-review-texts.js'), 'utf8');
  assert.match(src, /const gateDate = ingestGateDate\(data, \{ bylineVetoed \}\)/);
  assert.match(src, /isAnticipatoryPreviewPost\(\s*gateDate,/);
});
