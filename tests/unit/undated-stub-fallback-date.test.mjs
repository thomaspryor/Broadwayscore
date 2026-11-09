// BRO-6762 hole 3 (gathering side): an undated discovered stub gets the archive.org
// first-capture fallback date before gather-reviews.js parks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fb = require('../../scripts/lib/fallback-publish-date.js');
const { evaluateUndatedStageStub } = require('../../scripts/lib/undated-stage-stub-guard.js');

const STAGE_URL = 'https://www.thestage.co.uk/reviews/some-show-review';
const cdx = (ts) => async () => [['timestamp'], [ts]];

test('first capture inside the review window dates the stub, so it is no longer parked', async () => {
  const r = await fb.fallbackDateForUndatedStub({ url: STAGE_URL, openingDate: '2026-10-29', fetchJson: cdx('20261030090000') });
  assert.deepEqual(r, { publishDate: '2026-10-30', dateSource: 'archive-first-capture' });
  assert.equal(evaluateUndatedStageStub({ outletId: 'thestage', url: STAGE_URL, publishDate: r.publishDate }).park, false);
});

test('first capture years before this opening (an earlier staging) stays undated and is still parked', async () => {
  const r = await fb.fallbackDateForUndatedStub({ url: STAGE_URL, openingDate: '2026-10-29', fetchJson: cdx('20190412000000') });
  assert.equal(r, null);
  assert.equal(evaluateUndatedStageStub({ outletId: 'thestage', url: STAGE_URL, publishDate: null }).park, true);
});

test('no capture, a CDX error, or no opening date returns null and never throws', async () => {
  assert.equal(await fb.fallbackDateForUndatedStub({ url: STAGE_URL, openingDate: '2026-10-29', fetchJson: async () => [['timestamp']] }), null);
  assert.equal(await fb.fallbackDateForUndatedStub({ url: STAGE_URL, openingDate: '2026-10-29', fetchJson: async () => { throw new Error('down'); } }), null);
  let called = false;
  assert.equal(await fb.fallbackDateForUndatedStub({ url: STAGE_URL, openingDate: null, fetchJson: async () => { called = true; return [['timestamp'], ['20261030000000']]; } }), null);
  assert.equal(called, false, 'no CDX call without an opening date');
  assert.equal(await fb.fallbackDateForUndatedStub({ url: '', openingDate: '2026-10-29' }), null);
});

test('gather-reviews.js tries the fallback date before the park decision', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../../scripts/gather-reviews.js'), 'utf8');
  const fallbackAt = src.indexOf('fallbackDateForUndatedStub(');
  const parkAt = src.indexOf("evaluateUndatedStageStub({ outletId: review.outletId", fallbackAt);
  assert.ok(fallbackAt > 0, 'gather-reviews.js calls fallbackDateForUndatedStub');
  assert.ok(parkAt > fallbackAt, 'the fallback runs before evaluateUndatedStageStub parks the stub');
  // createReviewFile persists `dateSource` (not publishDateSource); downstream guards read it via
  // isFallbackPublishDate to treat the date as weak, so the tag must land on that field.
  assert.match(src.slice(fallbackAt, parkAt), /review\.dateSource = _fb\.dateSource/);
});

test('the fallback tag is recognised downstream as a weak (fallback) date', async () => {
  const { isFallbackPublishDate } = require('../../scripts/lib/fallback-date-source.js');
  const r = await fb.fallbackDateForUndatedStub({ url: STAGE_URL, openingDate: '2026-10-29', fetchJson: cdx('20261030090000') });
  assert.equal(isFallbackPublishDate({ dateSource: r.dateSource }), true);
});

import { createRequire as _cr } from 'node:module';
import _test from 'node:test';
import _assert from 'node:assert/strict';
const _fp = _cr(import.meta.url)('../../scripts/lib/fallback-publish-date.js');
_test('gather stub: a first capture 20 days after opening is refused (7-day window)', async () => {
  const fetchJson = async () => [['timestamp'], ['20260120000000']];
  _assert.equal(await _fp.fallbackDateForUndatedStub({ url: 'https://x.test/a', openingDate: '2026-01-01', fetchJson }), null);
});
