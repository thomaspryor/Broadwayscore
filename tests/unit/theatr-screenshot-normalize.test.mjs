/**
 * theatr-screenshot-import helpers — request validation and cleanup of the
 * model's extraction. The model output is untrusted (it transcribes user
 * screenshots), so these checks are what stand between a misread or injected
 * value and a user's diary.
 *
 * Run: node --test tests/unit/theatr-screenshot-normalize.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  validateImages,
  normalizeExtraction,
  isIsoDate,
  MAX_IMAGES_PER_CALL,
  MAX_IMAGE_BASE64_LEN,
} from '../../supabase/functions/theatr-screenshot-import/normalize.mjs';

const img = (over = {}) => ({ mediaType: 'image/jpeg', data: 'QUJDRA==', ...over });
const TODAY = '2026-10-04';

describe('validateImages', () => {
  it('accepts a well-formed batch', () => {
    const r = validateImages({ images: [img(), img({ mediaType: 'image/png' })] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.images.length, 2);
  });

  it('rejects a missing, empty or non-array images field', () => {
    for (const body of [null, {}, { images: [] }, { images: 'x' }, 'str']) {
      assert.deepStrictEqual(validateImages(body), { ok: false, error: 'invalid_images' });
    }
  });

  it('caps the batch size', () => {
    const images = Array.from({ length: MAX_IMAGES_PER_CALL + 1 }, () => img());
    assert.deepStrictEqual(validateImages({ images }), { ok: false, error: 'too_many_images' });
  });

  it('rejects unsupported media types (gif, svg, pdf)', () => {
    for (const mediaType of ['image/gif', 'image/svg+xml', 'application/pdf', '']) {
      assert.strictEqual(validateImages({ images: [img({ mediaType })] }).ok, false);
    }
  });

  it('rejects oversize and non-base64 data, including a data: URL prefix', () => {
    assert.strictEqual(validateImages({ images: [img({ data: 'A'.repeat(MAX_IMAGE_BASE64_LEN + 4) })] }).ok, false);
    assert.strictEqual(validateImages({ images: [img({ data: 'data:image/jpeg;base64,QUJD' })] }).ok, false);
    assert.strictEqual(validateImages({ images: [img({ data: '' })] }).ok, false);
  });
});

describe('isIsoDate', () => {
  it('accepts real calendar dates only', () => {
    assert.strictEqual(isIsoDate('2024-02-29'), true);
    assert.strictEqual(isIsoDate('2023-02-29'), false);
    assert.strictEqual(isIsoDate('2024-13-01'), false);
    assert.strictEqual(isIsoDate('March 5, 2024'), false);
    assert.strictEqual(isIsoDate(null), false);
  });
});

describe('normalizeExtraction', () => {
  it('passes clean rows through and trims whitespace', () => {
    const { entries, dropped } = normalizeExtraction({
      entries: [
        { title: '  Hamilton ', venue: 'Richard Rodgers Theatre', date: '2024-05-01', list: 'attended' },
        { title: 'Maybe Happy Ending', venue: null, date: null, list: 'interested' },
      ],
    }, TODAY);
    assert.strictEqual(dropped, 0);
    assert.deepStrictEqual(entries, [
      { title: 'Hamilton', venue: 'Richard Rodgers Theatre', date: '2024-05-01', list: 'attended' },
      { title: 'Maybe Happy Ending', venue: null, date: null, list: 'interested' },
    ]);
  });

  it('drops rows with no title or an unknown list, and counts them', () => {
    const { entries, dropped } = normalizeExtraction({
      entries: [
        { title: '', venue: null, date: null, list: 'attended' },
        { title: 'Wicked', venue: null, date: null, list: 'seen' },
        { title: 42, venue: null, date: null, list: 'attended' },
        { title: 'Six', venue: null, date: null, list: 'attended' },
      ],
    }, TODAY);
    assert.deepStrictEqual(entries.map(e => e.title), ['Six']);
    assert.strictEqual(dropped, 3);
  });

  it('nulls impossible, malformed and far-off dates instead of trusting a misread year', () => {
    const { entries } = normalizeExtraction({
      entries: [
        { title: 'A', venue: null, date: '2024-02-30', list: 'attended' },
        { title: 'B', venue: null, date: '5/1/2024', list: 'attended' },
        { title: 'C', venue: null, date: '2099-01-01', list: 'attended' },
        { title: 'D', venue: null, date: '1850-01-01', list: 'attended' },
        { title: 'E', venue: null, date: '2027-03-01', list: 'attended' },
      ],
    }, TODAY);
    assert.deepStrictEqual(entries.map(e => e.date), [null, null, null, null, '2027-03-01']);
  });

  it('never carries a date on an Interested row', () => {
    const { entries } = normalizeExtraction({
      entries: [{ title: 'Oh, Mary!', venue: null, date: '2025-01-10', list: 'interested' }],
    }, TODAY);
    assert.strictEqual(entries[0].date, null);
  });

  it('dedupes a row repeated across overlapping screenshots, keeping the venue', () => {
    const { entries } = normalizeExtraction({
      entries: [
        { title: 'Hadestown', venue: null, date: '2023-09-02', list: 'attended' },
        { title: 'hadestown', venue: 'Walter Kerr Theatre', date: '2023-09-02', list: 'attended' },
        // Same show, second viewing: a different date is a separate entry.
        { title: 'Hadestown', venue: null, date: '2024-01-20', list: 'attended' },
      ],
    }, TODAY);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].venue, 'Walter Kerr Theatre');
  });

  it('caps runaway title and venue lengths', () => {
    const { entries } = normalizeExtraction({
      entries: [{ title: 'x'.repeat(500), venue: 'y'.repeat(500), date: null, list: 'attended' }],
    }, TODAY);
    assert.strictEqual(entries[0].title.length, 150);
    assert.strictEqual(entries[0].venue.length, 120);
  });

  it('returns nothing for a malformed extraction rather than throwing', () => {
    for (const bad of [null, {}, { entries: 'x' }, { entries: [null, 7] }]) {
      const r = normalizeExtraction(bad, TODAY);
      assert.deepStrictEqual(r.entries, []);
    }
  });
});

describe('normalizeExtraction merge rule', () => {
  it('folds an undated attended copy into the dated one in either order', () => {
    for (const rows of [
      [{ title: 'Six', venue: null, date: null, list: 'attended' }, { title: 'Six', venue: 'Lena Horne', date: '2024-04-01', list: 'attended' }],
      [{ title: 'Six', venue: null, date: '2024-04-01', list: 'attended' }, { title: 'six', venue: 'Lena Horne', date: null, list: 'attended' }],
    ]) {
      const { entries } = normalizeExtraction({ entries: rows }, TODAY);
      assert.deepStrictEqual(entries.map(e => e.date), ['2024-04-01']);
    }
  });
});
