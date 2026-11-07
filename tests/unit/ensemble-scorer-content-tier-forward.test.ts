/**
 * BRO-4804 allowlist parity: prepareScoringInput must forward contentTier so a
 * complete review whose page footer ("Share:", "Leave a comment") fails the
 * ending check is scored as complete instead of "truncated, verdict may be
 * missing". The text-quality fix alone was a silent no-op on the ensemble path
 * because the reviewData allowlist dropped contentTier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnsembleReviewScorer } from '../../scripts/llm-scoring/ensemble-scorer';

const BODY =
  'The production lands with real force. The lead delivers a performance of startling control, and the score is carried by a superb band. ' +
  'The direction is confident, the design inventive, and the second act builds to a finale that earns every bit of its ovation. ' +
  'It is a thrilling night out and a clear recommendation for anyone who loves new musicals, with a company that never lets the pace drop for a moment of the evening. ' +
  'Slam Frank is loud, funny and unexpectedly tender, and the ensemble numbers explode across the stage with real muscle. ' +
  'The book has a few soft spots in the middle, and one subplot overstays its welcome, but the songs keep landing and the cast sells every beat. ' +
  'The choreography is precise, the band is tight, and the sound design keeps every lyric audible even in the biggest ensemble moments. ' +
  'By the final number the house was on its feet, and deservedly so: this is a show with a point of view and the talent to deliver it. ' +
  'It deserves a long life, and anyone with an appetite for something new should go while tickets are easy to get.';

function prepare(extra: Record<string, unknown>, footer: string) {
  const scorer = Object.create(EnsembleReviewScorer.prototype) as EnsembleReviewScorer;
  const result = scorer.prepareScoringInput({
    showId: 'slam-frank-off-broadway-2026',
    showTitle: 'Slam Frank',
    outletId: 'theatermania',
    outlet: 'TheaterMania',
    criticName: 'Critic',
    url: 'https://example.com/review',
    publishDate: '2026-09-01',
    fullText: BODY + footer,
    bwwThumb: null,
    originalScore: null,
    category: 'off-broadway',
    venue: 'Test Venue',
    ...extra,
  } as any) as unknown as { ok: boolean; prep?: { scoringInput: { textQuality: string } } };
  assert.ok(result.ok && result.prep, 'scoring input should be prepared: ' + JSON.stringify(result).slice(0, 300));
  return result.prep!.scoringInput;
}

test('contentTier=complete with a Share/Leave-a-comment footer is scored as complete', () => {
  const si = prepare({ contentTier: 'complete' }, '\n\nShare:\n\nLeave a comment');
  assert.equal(si.textQuality, 'complete', 'prepareScoringInput must forward contentTier (allowlist bug)');
});

test('without contentTier the same footer still reads as truncated (control)', () => {
  const si = prepare({}, '\n\nShare:\n\nLeave a comment');
  assert.equal(si.textQuality, 'truncated');
});
