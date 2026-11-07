/**
 * BRO-6000 allowlist parity: prepareScoringInput must forward the multi-show
 * split markers so the scoring context carries the "this is one show's section
 * of a longer article" note. Without the forward the note is a silent no-op on
 * the ensemble path (fifth instance of the allowlist-omission class: category/
 * venue, type, priorRuns, contentTier, now the split markers).
 *
 * Fixture text is synthetic, not a real review (the repo is public).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnsembleReviewScorer } from '../../scripts/llm-scoring/ensemble-scorer';

const BODY =
  'Though it is similarly portable, I would not recommend that approach for the other production on the block. ' +
  'Two performers sit on plain chairs and take turns reading from a script built out of recorded conversations. ' +
  'The staging is spare, the lighting stays flat, and the chairs never move during the whole evening. ' +
  'The company plays it deadpan and the sound design keeps every pause audible. ' +
  'Some passages are funny, some are uncomfortable, and the piece is careful never to settle on one mood for long. ' +
  'The middle stretch holds together well, and the performers trade lines with an ease that reads as rehearsed freedom. ' +
  'The final stretch is the least certain, trading the clean structure of the opening for a looser conversation. ' +
  'The program runs about an hour without an intermission, and the house was quiet throughout. ' +
  'The design team keeps the room simple and lets the voices carry the evening from the first line to the last. ' +
  'It is an odd, carefully made hour of theater that will suit some audiences more than others.';

function context(extra: Record<string, unknown>): string {
  const scorer = Object.create(EnsembleReviewScorer.prototype) as EnsembleReviewScorer;
  const result = scorer.prepareScoringInput({
    showId: 'sample-show-off-broadway-2026',
    showTitle: 'Sample Show',
    outletId: 'nytimes',
    outlet: 'The New York Times',
    criticName: 'Critic',
    url: 'https://example.com/review',
    publishDate: '2026-10-20',
    fullText: BODY,
    contentTier: 'complete',
    bwwThumb: null,
    originalScore: null,
    category: 'off-broadway',
    venue: 'Test Venue',
    ...extra,
  } as any) as unknown as { ok: boolean; prep?: { scoringInput: { context: string } } };
  assert.ok(result.ok && result.prep, 'scoring input should be prepared: ' + JSON.stringify(result).slice(0, 300));
  return result.prep!.scoringInput.context;
}

test('a split child gets the section note in the scoring context', () => {
  const ctx = context({ multiShowSplitChild: true });
  assert.match(ctx, /only the section about "Sample Show"/, 'prepareScoringInput must forward multiShowSplitChild (allowlist bug)');
  assert.match(ctx, /not a verdict on "Sample Show"/);
  assert.match(ctx, /counts in full, favorable or not/);
});

test('a split parent that kept its own section gets the note too', () => {
  assert.match(context({ multiShowSplitParent: true }), /only the section about "Sample Show"/);
});

test('a whole review gets no section note (control)', () => {
  assert.doesNotMatch(context({}), /only the section about/);
});
