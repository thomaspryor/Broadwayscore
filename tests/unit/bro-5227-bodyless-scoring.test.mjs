/**
 * BRO-5227: reviews with only part of their text, or a star rating and no
 * text, were left off the site. Three gaps, each driven through the real
 * functions (CLAUDE.md §15):
 *   1. a 300-999 char partial article was refused by the scorer's
 *      body_too_short gate and stamped never-retry;
 *   2. aggregator star ratings were ignored for metro-uk / sunday-telegraph /
 *      sunday-express because KNOWN_STAR_OUTLETS held short forms the review
 *      files never carry;
 *   3. a stale scoreStatus 'TO_BE_CALCULATED' kept files with stars or text
 *      off the site AND away from the scorer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const {
  isShortPartialReview, isExemptFromBodyLengthGate, isStaleToBeCalculated, isToBeCalculatedScored, isCapsuleReview,
} = require('../../scripts/lib/scorable-text');
const { validateScoreableText } = require('../../scripts/lib/score-input-validator');
const { isBlockedFromRescore } = require('../../scripts/lib/rescore-lifecycle');
const { KNOWN_STAR_OUTLETS } = require('../../scripts/lib/score-extractors');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers');
const { explainExclusion } = require('../../scripts/lib/review-guards');
const { clearFailureFlags } = require('../../scripts/lib/clear-failure-flags');
const { buildScoringInput } = require('../../scripts/llm-scoring/input-builder');
const { pickConsensusRejection } = require('../../scripts/llm-scoring/ensemble-scorer');
const { hasValidScore: hasValidScoreForOrphans } = require('../../scripts/verify-all-scored');

// Shape of heated-rivalry-...-off-broadway-2026/off-off-online--edward-karam.json:
// a 531-char lede that ends on a full stop and states a verdict.
const LEDE = 'Send-ups of television series have become a cottage industry in New York theater, '
  + 'but they usually target familiar, long-established properties. This parody arrives barely '
  + 'six months after the series premiered. Under the director, the result is fresh and bawdy, '
  + 'and sung with serious voices by a talented cast that clearly loves the source. '
  + 'The jokes land more often than not, and the evening is a good deal of fun.';

function partial(over = {}) {
  return { showId: 't-2026', outletId: 'off-off-online', contentTier: 'truncated', fullText: LEDE, ...over };
}

describe('short partial articles (gap 1)', () => {
  test('a 300-999 char truncated article qualifies', () => {
    assert.ok(LEDE.length >= 300 && LEDE.length < 1000);
    assert.equal(isShortPartialReview(partial()), true);
    assert.equal(isExemptFromBodyLengthGate(partial()), true);
  });

  test('page shells, full texts and already-judged files do not', () => {
    assert.equal(isShortPartialReview(partial({ fullText: LEDE.slice(0, 250) })), false);
    assert.equal(isShortPartialReview(partial({ fullText: LEDE.repeat(3) })), false);
    for (const contentTier of ['invalid', 'stub', 'needs-rescrape', 'complete', undefined]) {
      assert.equal(isShortPartialReview(partial({ contentTier })), false, contentTier);
    }
    assert.equal(isShortPartialReview(partial({ rejectionReason: 'not_a_review' })), false);
    assert.equal(isShortPartialReview(partial({ wrongProduction: true })), false);
    assert.equal(isShortPartialReview(partial({ isNonReview: true })), false);
  });

  test('a Theatre Record capsule stays on its own path and stays exempt', () => {
    const capsule = partial({ source: 'theatre-record' });
    assert.equal(isCapsuleReview(capsule), true);
    assert.equal(isShortPartialReview(capsule), false);
    assert.equal(isExemptFromBodyLengthGate(capsule), true);
  });

  test('the validator passes it with the exemption and still blocks it without', () => {
    assert.equal(validateScoreableText(LEDE, 'Heated Rivalry', { isExcerpt: false }).reason, 'body_too_short');
    assert.equal(validateScoreableText(LEDE, 'Heated Rivalry', { isExcerpt: isExemptFromBodyLengthGate(partial()) }).ok, true);
  });

  test('a file stamped body_too_short before this change is retried', () => {
    const stamped = partial({
      rescoreBlockedReason: 'input_validation_failed:body_too_short',
      rescoreBlockedTextLength: LEDE.length, rescoreBlockedHadExcerpt: false,
    });
    assert.equal(isBlockedFromRescore(stamped), false);
    // A file the exemption does not cover keeps its block.
    const shell = { ...stamped, fullText: LEDE.slice(0, 250), rescoreBlockedTextLength: 250 };
    assert.equal(isBlockedFromRescore(shell), true);
  });

  test('scoring input is always low confidence, even when the lede reads as complete', () => {
    const input = buildScoringInput({ ...partial(), showTitle: 'Heated Rivalry', outlet: 'Off Off Online',
      category: 'off-broadway', venue: 'Theatre 555' });
    assert.equal(input.confidence, 'low');
    // Control: the same text padded past the body gate is not forced low.
    const full = buildScoringInput({ ...partial({ fullText: LEDE.repeat(3), contentTier: 'complete' }),
      showTitle: 'Heated Rivalry', outlet: 'Off Off Online', category: 'off-broadway', venue: 'Theatre 555' });
    assert.notEqual(full.confidence, 'low');
    // A Theatre Record capsule of the same length keeps its own framing.
    const capsule = buildScoringInput({ ...partial({ source: 'theatre-record' }), showTitle: 'Heated Rivalry',
      outlet: 'Off Off Online', category: 'off-broadway', venue: 'Theatre 555' });
    assert.notEqual(capsule.confidence, 'low');
  });

  test('a consensus on a type the prompt does not list is recorded, not thrown', () => {
    // gpt-4o answers "truncated_text" for a lede cut off before the verdict.
    // pickConsensusRejection returned undefined and the caller threw, so
    // nothing was saved and the file was re-sent on every run.
    const two = [{ rejected: true, rejection: 'truncated_text' }, { rejected: true, rejection: 'truncated_text' }];
    assert.equal(pickConsensusRejection(two)?.rejection, 'truncated_text');
    // A listed type still wins a tie through the priority order.
    const tie = [{ rejected: true, rejection: 'truncated_text' }, { rejected: true, rejection: 'not_a_review' }];
    assert.equal(pickConsensusRejection(tie).rejection, 'not_a_review');
  });
});

describe('star outlets carry canonical registry ids (gap 2)', () => {
  test('metro-uk, sunday-telegraph and sunday-express are star outlets', () => {
    for (const id of ['metro-uk', 'sunday-telegraph', 'sunday-express']) assert.ok(KNOWN_STAR_OUTLETS.has(id), id);
  });

  test('every alias in the set has its canonical id in the set too', () => {
    // Review files are written with the registry's canonical outletId, so an
    // alias-only entry ('metro' without 'metro-uk') never matches a file.
    const registry = JSON.parse(fs.readFileSync(new URL('../../data/outlet-registry.json', import.meta.url), 'utf8'));
    const missing = [...KNOWN_STAR_OUTLETS]
      .filter((id) => !registry.outlets[id] && registry._aliasIndex[id] && !KNOWN_STAR_OUTLETS.has(registry._aliasIndex[id]))
      .map((id) => `${id} -> ${registry._aliasIndex[id]}`);
    assert.deepEqual(missing, []);
  });

  test('the orphan guard counts a relayed star score the rebuild publishes', () => {
    const d = { outletId: 'metro-uk', aggregatorStars: '4/5' };
    assert.equal(hasValidScoreForOrphans(d), false, 'field list alone misses it');
    assert.equal(hasValidScoreForOrphans(d, { category: 'west-end' }), true);
  });

  test('a relayed 4/5 for metro-uk now scores', () => {
    const r = getBestScore({ outletId: 'metro-uk', aggregatorStars: '4/5', _showCategory: 'west-end' });
    assert.ok(r && r.score >= 71 && r.score <= 90, JSON.stringify(r));
  });
});

describe('stale TO_BE_CALCULATED marker (gap 3)', () => {
  const show = { id: 'six-2021', title: 'Six', category: 'broadway', status: 'open', openingDate: '2021-10-03' };

  test('the marker holds when the file has nothing to score', () => {
    const bare = { showId: 'six-2021', outletId: 'nypost', scoreStatus: 'TO_BE_CALCULATED' };
    assert.equal(isStaleToBeCalculated(bare), false);
    assert.equal(getBestScore(bare), null);
    assert.equal(explainExclusion(bare, show), 'scoreStatusToBeCalculated');
  });

  test('a relayed star rating lifts the marker on a London show', () => {
    // the-play-that-goes-wrong-west-end-2021/west-end-wilma: StageDoor 5/5.
    const we = { id: 'tpgw-we-2021', title: 'The Play That Goes Wrong', category: 'west-end', status: 'open', openingDate: '2021-09-01' };
    const d = { showId: we.id, outletId: 'west-end-wilma', source: 'stagedoor', scoreStatus: 'TO_BE_CALCULATED', aggregatorStars: '5/5 stars' };
    assert.equal(isToBeCalculatedScored(d, 'west-end'), true);
    assert.notEqual(explainExclusion(d, we), 'scoreStatusToBeCalculated');
    const r = getBestScore({ ...d, _showCategory: 'west-end' });
    assert.ok(r && r.score >= 91, JSON.stringify(r));
  });

  test('but not on a Broadway show, where it rates the London run', () => {
    // harry-potter-2021/independent--unknown.json: StageDoor 5/5 for the Palace Theatre.
    const hp = { id: 'harry-potter-2021', title: 'Harry Potter and the Cursed Child', category: 'broadway', status: 'open', openingDate: '2021-11-16' };
    const d = { showId: hp.id, outletId: 'independent', source: 'stagedoor', scoreStatus: 'TO_BE_CALCULATED', aggregatorStars: '5/5 stars' };
    assert.equal(isToBeCalculatedScored(d, 'broadway'), false);
    assert.equal(explainExclusion(d, hp), 'scoreStatusToBeCalculated');
    assert.equal(getBestScore({ ...d, _showCategory: 'broadway' }), null);
    // clear-failure-flags has no show, so a relay alone never clears it there.
    assert.equal(isToBeCalculatedScored(d), false);
  });

  test('stars relayed for an outlet that publishes none do not', () => {
    const d = { outletId: 'london-theatre', scoreStatus: 'TO_BE_CALCULATED', aggregatorStars: '5/5' };
    assert.equal(isStaleToBeCalculated(d, 'west-end'), false);
  });

  test('text the scorer will take makes it stale, so the scorer can reach it', () => {
    assert.equal(isStaleToBeCalculated({ scoreStatus: 'TO_BE_CALCULATED', fullText: 'x'.repeat(1200) }), true);
    assert.equal(isStaleToBeCalculated({ scoreStatus: 'TO_BE_CALCULATED', ...partial() }), true);
    assert.equal(isStaleToBeCalculated({ scoreStatus: 'TO_BE_CALCULATED', fullText: 'x'.repeat(250) }), false);
  });

  test('text alone lets the scorer in but keeps a placeholder score off the site', () => {
    // the-lyons-2012/theatermania: TO_BE_CALCULATED with an unsourced
    // Mixed/50 placeholder and 581 chars of text.
    const d = { showId: 'six-2021', outletId: 'theatermania', scoreStatus: 'TO_BE_CALCULATED',
      bucket: 'Mixed', assignedScore: 55, ...partial({ outletId: 'theatermania' }) };
    assert.equal(isStaleToBeCalculated(d), true);
    assert.equal(isToBeCalculatedScored(d), false);
    assert.equal(explainExclusion(d, show), null);
    assert.equal(getBestScore({ ...d, _showCategory: 'broadway' }), null);
    // Once the scorer writes a score, that score is used.
    const scored = { ...d, llmScore: { score: 74, confidence: 'low' }, ensembleData: { needsReview: false } };
    assert.equal(getBestScore({ ...scored, _showCategory: 'broadway' })?.score, 74);
  });

  test('clearFailureFlags clears the marker on a real score only', () => {
    const scored = { scoreStatus: 'TO_BE_CALCULATED', outletId: 'thestage', originalScore: '3/5' };
    clearFailureFlags(scored);
    assert.equal(scored.scoreStatus, null);
    const textOnly = { scoreStatus: 'TO_BE_CALCULATED', fullText: 'x'.repeat(1200) };
    clearFailureFlags(textOnly);
    assert.equal(textOnly.scoreStatus, 'TO_BE_CALCULATED');
  });
});
