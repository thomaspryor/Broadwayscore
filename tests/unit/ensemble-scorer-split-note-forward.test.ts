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
  'The two performers sit on plain chairs and take turns voicing the playwright, reciting recorded interviews with every hesitation intact. ' +
  'The men being questioned recall a notorious video from their school years, and their descriptions are vivid enough to linger. ' +
  'The staging is spare and the tone is cool, and the evening turns toward a quiet discussion of how a girl first learns to feel disgust at her own body. ' +
  'Late in the hour the playwright talks about her own body now, and the conversation widens past what two actors can carry. ' +
  'The company plays it deadpan, the sound design keeps the in-ear microphones audible, and the hour runs without a wasted minute. ' +
  'The lighting stays flat and white, the chairs never move, and the only change in the room comes from the voices and the pauses between them. ' +
  'Some of the recollections are funny, some are uncomfortable, and the piece is careful never to settle on one reaction for long. ' +
  'It asks what a group of boys passed along in a lunchroom, and what the girls around them absorbed without ever seeing it. ' +
  'The final stretch is the least certain, trading the clean structure of the interviews for a looser conversation that raises more than it answers. ' +
  'It is an odd, cool, carefully made hour of theater that will suit some audiences far more than others.';

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
});

test('a split parent that kept its own section gets the note too', () => {
  assert.match(context({ multiShowSplitParent: true }), /only the section about "Sample Show"/);
});

test('a whole review gets no section note (control)', () => {
  assert.doesNotMatch(context({}), /only the section about/);
});
