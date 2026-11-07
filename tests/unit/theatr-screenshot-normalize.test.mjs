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
  parseScoreText,
  scoreToRating,
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

const row = (over = {}) => ({
  title: 'Hamilton', venue: null, list: 'attended', screen: 'activity', date: null,
  month_day: null, year_hint: null, reaction: null, score_text: null, review: null, review_cut_off: false, ...over,
});

describe('normalizeExtraction', () => {
  it('passes a clean Activity row through in screenshot order', () => {
    const { entries, dropped } = normalizeExtraction({
      entries: [
        row({ title: '  The 25th Annual Putnam County Spelling Bee ', venue: 'New World Stages', month_day: '03-10', reaction: 'recommend', score_text: '84/100', review: 'Fun.\n\n84/100.' }),
        row({ title: 'Kyoto', list: 'interested', month_day: '10-11', year_hint: 2025 }),
      ],
    }, TODAY);
    assert.strictEqual(dropped, 0);
    assert.deepStrictEqual(entries[0], {
      title: 'The 25th Annual Putnam County Spelling Bee', venue: 'New World Stages', list: 'attended', screen: 'activity',
      date: null, monthDay: '03-10', yearHint: null, score: 84, rating: 4, review: 'Fun.\n\n84/100.', reviewCutOff: false, reaction: 'recommend',
    });
    assert.strictEqual(entries[1].title, 'Kyoto');
    assert.strictEqual(entries[1].yearHint, 2025);
  });

  it('drops rows with no title or an unknown list, and counts them', () => {
    const { entries, dropped } = normalizeExtraction({
      entries: [row({ title: '' }), row({ list: 'seen' }), row({ title: 42 }), row({ title: 'Six' })],
    }, TODAY);
    assert.deepStrictEqual(entries.map(e => e.title), ['Six']);
    assert.strictEqual(dropped, 3);
  });

  it('nulls impossible, malformed and far-off dates instead of trusting a misread year', () => {
    const { entries } = normalizeExtraction({
      entries: ['2024-02-30', '5/1/2024', '2099-01-01', '1850-01-01', '2027-03-01'].map((date) => row({ date })),
    }, TODAY);
    assert.deepStrictEqual(entries.map(e => e.date), [null, null, null, null, '2027-03-01']);
  });

  it('validates month_day and year_hint', () => {
    const { entries } = normalizeExtraction({
      entries: [
        row({ month_day: '02-29', year_hint: 2024 }),
        row({ month_day: '13-01', year_hint: 2099 }),
        row({ month_day: 'Oct 12', year_hint: '2025' }),
      ],
    }, TODAY);
    assert.deepStrictEqual(entries.map(e => [e.monthDay, e.yearHint]), [['02-29', 2024], [null, null], [null, null]]);
  });

  it('keeps an Interested row\'s feed position but never a date, score or review', () => {
    const { entries } = normalizeExtraction({
      entries: [row({ list: 'interested', date: '2025-01-10', month_day: '01-10', score_text: '90/100', review: 'x', reaction: 'recommend' })],
    }, TODAY);
    assert.deepStrictEqual(
      [entries[0].date, entries[0].monthDay, entries[0].score, entries[0].review, entries[0].reaction],
      [null, '01-10', null, null, null],
    );
  });

  it('keeps review paragraphs and caps runaway lengths', () => {
    const { entries } = normalizeExtraction({
      entries: [row({ title: 'x'.repeat(500), venue: 'y'.repeat(500), review: '  First   para.\n\n\n Second\npara. ' })],
    }, TODAY);
    assert.strictEqual(entries[0].title.length, 150);
    assert.strictEqual(entries[0].venue.length, 120);
    assert.strictEqual(entries[0].review, 'First para.\n\nSecond para.');
  });

  it('falls back to safe values for unknown screen/reaction', () => {
    const { entries } = normalizeExtraction({ entries: [row({ screen: 'feed', reaction: 'love' })] }, TODAY);
    assert.strictEqual(entries[0].screen, 'other');
    assert.strictEqual(entries[0].reaction, null);
  });

  it('returns nothing for a malformed extraction rather than throwing', () => {
    for (const bad of [null, {}, { entries: 'x' }, { entries: [null, 7] }]) {
      assert.deepStrictEqual(normalizeExtraction(bad, TODAY).entries, []);
    }
  });
});

describe('review_cut_off', () => {
  it('flags a seen show whose review was cut off, and only then', () => {
    const { entries } = normalizeExtraction({
      entries: [
        row({ title: 'A', review_cut_off: true }),
        row({ title: 'B', review_cut_off: true, review: 'Full text.' }),
        row({ title: 'C', list: 'interested', review_cut_off: true }),
        row({ title: 'D', review_cut_off: 'yes' }),
      ],
    }, TODAY);
    assert.deepStrictEqual(entries.map(e => e.reviewCutOff), [true, false, false, false]);
  });
});

describe('score fallback from the review', () => {
  it('reads a score that ends the review when score_text is empty', () => {
    const { entries } = normalizeExtraction({ entries: [row({ review: 'Warm and funny.\n\n84/100.' })] }, TODAY);
    assert.deepStrictEqual([entries[0].score, entries[0].rating], [84, 4]);
  });
  it('never takes a mid-review fraction as the verdict', () => {
    const { entries } = normalizeExtraction({ entries: [row({ review: 'Only 3/5 songs land, and the rest drag on and on and on.' })] }, TODAY);
    assert.strictEqual(entries[0].score, null);
  });
});

describe('parseScoreText / scoreToRating', () => {
  it('reads explicit scores over 100, 10 and 5 only', () => {
    assert.strictEqual(parseScoreText('84/100'), 84);
    assert.strictEqual(parseScoreText('68/100.'), 68);
    assert.strictEqual(parseScoreText('8.5/10'), 85);
    assert.strictEqual(parseScoreText(' 4 / 5 '), 80);
    assert.strictEqual(parseScoreText('Score: 84/100!'), 84);
    assert.strictEqual(parseScoreText('4 out of 5'), 80);
    assert.strictEqual(parseScoreText('84 / 100 ⭐'), 84);
    // Last score wins: the verdict ends the review.
    assert.strictEqual(parseScoreText('3/5 songs land. Overall 72/100.'), 72);
    for (const bad of ['loved it', '120/100', '7/8', '84', '', null, 'Recommend it', '84/1000']) {
      assert.strictEqual(parseScoreText(bad), null, String(bad));
    }
  });

  it('converts to half-stars like the Show Score import', () => {
    assert.deepStrictEqual([84, 68, 0, 100, 3].map(scoreToRating), [4, 3.5, 0.5, 5, 0.5]);
    assert.strictEqual(scoreToRating(null), null);
  });
});
