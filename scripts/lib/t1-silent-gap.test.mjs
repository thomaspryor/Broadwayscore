import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifySilentGap, classifyGapCardState, GAP_CARD_STATE, shouldAlertGap, shouldDispatchScoring, shouldEmailUnscoredGap } = require('./t1-silent-gap.js');

const NOW = new Date('2026-07-18T12:00:00Z');
const classify = (file, over = {}) =>
  classifySilentGap({ file, show: {}, tier: 1, outletScored: false, now: NOW, ...over });

// Fixture shapes are the two real 2026-07-18 incident files, trimmed.
const TIMES_EMPTY_STUB = {
  url: 'https://www.thetimes.com/culture/theatre-dance/article/the-oresteia-review-david-morrissey-bg8qzzhhn',
  criticName: 'Clive Davis',
  contentTier: 'excerpt',
  fullText: '',
};

const NYT_BOT_STUB_REJECTED = {
  url: 'https://www.nytimes.com/2026/07/15/theater/the-potluck-review-cesar-alvarez.html',
  criticName: 'Helen Shaw',
  contentTier: 'truncated',
  fullText: 'x'.repeat(2956),
  assignedScore: 62,
  rejectedBy: 'ensemble-scoreability-check',
  rejectedAt: '2026-07-18T06:37:19.249Z',
};

test('Times/Oresteia incident shape: empty T1 stub is a recoverable empty-body gap', () => {
  assert.deepEqual(classify(TIMES_EMPTY_STUB), { type: 'empty-body', recoverable: true });
});

test('NYT/Potluck incident shape: scoreability-rejected bot-stub is a gap even with an assignedScore', () => {
  assert.deepEqual(classify(NYT_BOT_STUB_REJECTED), { type: 'rejected-unscoreable', recoverable: false });
});

test('rejection re-fetched AFTER rejectedAt is revalidated (canonical) → unscored, not rejected', () => {
  const refetched = { ...NYT_BOT_STUB_REJECTED, textFetchedAt: '2026-07-18T07:00:00.000Z' };
  // passesFlagFilters treats post-rejection re-fetch as revalidated; the text
  // is fresh (< grace window) so nothing escalates yet.
  assert.equal(classify(refetched), null);
});

test('content present, never scored, past the grace window → unscored', () => {
  const gap = classify({
    url: 'https://www.thetimes.com/culture/theatre/article/show-review-abc123', fullText: 'y'.repeat(1000), contentTier: 'complete',
    textFetchedAt: '2026-07-17T00:00:00Z',
  }, { tier: 2 });
  // dispatchable (BRO-2985): 'y'.repeat(1000) is substantive text the scorer's
  // selector would accept, so dispatching llm-ensemble-score.yml for it is
  // legitimate self-heal. Contrast the blocked case below.
  assert.deepEqual(gap, { type: 'unscored', recoverable: false, dispatchable: true });
});

test('unscored gap the scorer would refuse is reported but NOT dispatchable (BRO-2985)', () => {
  // the-story-west-end-2026's the-spectator-uk--unknown.json: a
  // spectator.co.uk/submit contact page from a 2020 archive.org snapshot,
  // already stamped terminal by the ensemble. The sweep used to dispatch
  // scoring for it 4x/day/show forever (DISPATCH_RETRY_HOURS=6) and the
  // scorer skipped it identically every time.
  const submitPageText =
    'Have a story to share with us? Contact the right member of the editorial team below. '.repeat(6);
  // BRO-5227: a 300-999 char text the classifier tiered 'truncated' is a
  // short partial the scorer now takes once (the ensemble's not_a_review
  // rejection then ends it; see the dispatchable assertion at the end). A
  // short text tiered anything else keeps the terminal block, which is what
  // this test pins.
  // The live file's url was spectator.co.uk/submit/; since BRO-3106 that
  // site-utility path is not a review url, so it is no gap at all (asserted
  // at the end). An article-shaped url keeps this test on the dispatch block.
  const blocked = {
    url: 'https://www.spectator.co.uk/article/the-story-review/',
    fullText: submitPageText,
    contentTier: 'complete',
    textFetchedAt: '2026-07-17T00:00:00Z',
    rescoreAttempts: 1,
    rescoreBlockedReason: 'input_validation_failed:body_too_short',
    rescoreBlockedAt: '2026-09-06T15:11:26.316Z',
    // Derived, not hardcoded: isBlockedFromRescore fingerprints on fullText
    // LENGTH, so a stale literal here silently voids the block and the test
    // would pass for the wrong reason.
    rescoreBlockedTextLength: submitPageText.length,
    rescoreBlockedHadExcerpt: false,
  };
  const gap = classify(blocked, { tier: 2 });
  // Still a reported gap — the operator must see it.
  assert.equal(gap && gap.type, 'unscored');
  assert.equal(
    gap.dispatchable,
    false,
    'a file carrying a terminal rescue block must not keep dispatching scoring',
  );
  // The same text tiered 'truncated' (the live file) is dispatchable since BRO-5227.
  assert.equal(classify({ ...blocked, contentTier: 'truncated' }, { tier: 2 }).dispatchable, true);
  assert.equal(classify({ ...blocked, url: 'https://www.spectator.co.uk/submit/' }, { tier: 2 }), null, 'a site utility page is not a review gap');
});

test('content fetched within the 12h grace window is NOT yet a gap', () => {
  assert.equal(classify({
    url: 'https://www.thetimes.com/culture/theatre/article/show-review-abc123', fullText: 'y'.repeat(1000), contentTier: 'complete',
    textFetchedAt: '2026-07-18T09:00:00Z',
  }), null);
});

test('tier 3+ outlets are never a silent gap', () => {
  assert.equal(classify(TIMES_EMPTY_STUB, { tier: 3 }), null);
});

test('outlet already scored (sibling file or reviews.json) → no gap', () => {
  assert.equal(classify(TIMES_EMPTY_STUB, { outletScored: true }), null);
});

test('legitimate editorial exclusions are not gaps', () => {
  for (const excl of [
    { wrongProduction: true },
    { wrongShow: true },
    { isNonReview: true },
    { isNotReview: true },
    { nonReviewFlag: true },
    { nonReviewContent: true },
    { isRoundupArticle: true },
    { fabricatedEntry: true },
    { isSyndicatedDuplicate: true },
    { crossOutletDuplicate: true },
    { wrongAttribution: true },
    { suspectedMisattribution: true },
    { duplicateOf: 'whatsonstage--matt-trueman.json' },
    { duplicateTextOf: 'a.json' },
    { rejectedAt: '2026-07-01T00:00:00Z', rejectionReason: 'not_a_review' },
    { humanReviewedWrongProduction: true },
    { contentVerification: { wrongArticle: true, confidence: 'high' } },
    { showNotMentioned: true },
  ]) {
    assert.equal(classify({ ...TIMES_EMPTY_STUB, ...excl }), null,
      `expected null for ${JSON.stringify(excl)}`);
  }
});

test('showNotMentioned with real text but no score is NOT a gap (mirror suppression preserved, S1-T5)', () => {
  // Would falsely escalate as {unscored} after the passesFlagFilters→
  // isIncludableForRebuild migration (isIncludableForRebuild does not model
  // showNotMentioned) without the hasEditorialExclusion restore.
  const f = { url: 'https://www.thetimes.com/x/foo-review-abc', fullText: 'y'.repeat(1500),
    contentTier: 'complete', textFetchedAt: '2026-07-01T00:00:00Z', showNotMentioned: true };
  assert.equal(classify(f), null);
  // …but an aggregator excerpt provides real content → NOT suppressed.
  const withExcerpt = { ...f, bwwExcerpt: 'A rave from the critic.' };
  assert.notEqual(classify(withExcerpt), null);
});

test('wrong-URL discovery phantoms (QA finding) are not gaps and never recovered', () => {
  for (const sig of [
    { incompleteReason: 'url_content_mismatch', contentTier: 'stub' },
    { incompleteReason: 'scraper_garbage', contentTier: 'stub' },
    { incompleteReason: 'wrong_content' },
    { isBlockedReviewUrl: true, contentTier: 'stub' },
    { bwwAggregatorAmbiguous: true, contentTier: 'stub' },
  ]) {
    assert.equal(classify({ ...TIMES_EMPTY_STUB, ...sig }), null,
      `expected null for ${JSON.stringify(sig)}`);
  }
});

test('scored + includable file is not a gap (canonical predicate says it reaches reviews.json)', () => {
  assert.equal(classify({
    url: 'https://www.thetimes.com/culture/theatre/article/show-review-abc123', fullText: 'y'.repeat(5000),
    llmScore: { score: 39 }, assignedScore: 39,
  }), null);
});

test('adjudicated star-stub (The Stage class) is scored, not a gap', () => {
  assert.equal(classify({ url: 'https://www.thetimes.com/culture/theatre/article/show-review-abc123', fullText: '', contentTier: 'excerpt', adjudicatedScore: 62 }), null);
});

test('empty stub with contentTier=stub (flag-excluded but not editorial) is a recoverable gap', () => {
  assert.deepEqual(classify({ ...TIMES_EMPTY_STUB, contentTier: 'stub' }),
    { type: 'empty-body', recoverable: true });
});

test('empty-body over the retry cap stays a gap but is no longer recoverable', () => {
  assert.deepEqual(classify({ ...TIMES_EMPTY_STUB, aggUrlRecoveryCount: 3 }),
    { type: 'empty-body', recoverable: false });
});

test('flag-excluded empty stub over the retry cap is still REPORTED (2026-07-18: thestage paywall stubs vanished from the audit unresolved)', () => {
  assert.deepEqual(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'stub', incompleteReason: 'paywall', aggUrlRecoveryCount: 3,
  }), { type: 'empty-body', recoverable: false });
});

test('roundup page-as-review husk is NOT a gap (2026-07-19: shifters playbill what-are-the-reviews page)', () => {
  assert.equal(classify({
    ...TIMES_EMPTY_STUB,
    outletId: 'playbill',
    url: 'https://playbill.com/article/what-are-the-reviews-for-shifters-off-broadway',
    contentTier: 'stub',
  }), null);
});

test('contentTier=invalid garbage is NOT an empty-body gap (re-ingest can only re-fetch garbage)', () => {
  assert.equal(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'invalid', aggUrlRecoveryCount: 3,
  }), null);
});

test('star-scored textless stub is not a gap; junk originalScore stub still is', () => {
  // First-party page stars (stage-star-svg pattern) — rebuild will score it.
  assert.equal(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'stub',
    originalScore: '3/5 stars', originalScoreNormalized: 60, aggUrlRecoveryCount: 3,
  }), null);
  // Letter grade parses via isUnambiguousRatingString — also a valid score.
  assert.equal(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'stub', originalScore: 'B+', aggUrlRecoveryCount: 3,
  }), null);
  // Unparseable originalScore is NOT a score — must stay visible as a gap.
  assert.deepEqual(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'stub', originalScore: 'N/A', aggUrlRecoveryCount: 3,
  }), { type: 'empty-body', recoverable: false });
});

test('alert dedupe: never-alerted fires, recent alert suppresses, 8-day-old re-fires', () => {
  assert.equal(shouldAlertGap(null, NOW), true);
  assert.equal(shouldAlertGap('2026-07-17T12:00:00Z', NOW), false);
  assert.equal(shouldAlertGap('2026-07-10T11:00:00Z', NOW), true);
  assert.equal(shouldAlertGap('garbage', NOW), true);
});

test('dispatch policy: never-dispatched dispatches; <6h suppresses; 7h-old re-dispatches; garbage dispatches', () => {
  assert.equal(shouldDispatchScoring(null, NOW), true);
  assert.equal(shouldDispatchScoring('2026-07-18T08:00:00Z', NOW), false); // 4h ago
  assert.equal(shouldDispatchScoring('2026-07-18T05:00:00Z', NOW), true); // 7h ago
  assert.equal(shouldDispatchScoring('garbage', NOW), true);
});

test('unscored email policy: never-dispatched never emails; fresh dispatch suppresses; stale failed dispatch escalates; corrupt stamp escalates', () => {
  assert.equal(shouldEmailUnscoredGap(null, NOW), false);
  // Present-but-corrupt stamp escalates — silent forever-redispatch guard.
  assert.equal(shouldEmailUnscoredGap('garbage', NOW), true);
  assert.equal(shouldEmailUnscoredGap('2026-07-18T08:00:00Z', NOW), false); // 4h ago — scoring still in flight
  assert.equal(shouldEmailUnscoredGap('2026-07-18T05:00:00Z', NOW), true); // 7h ago and still gapped
});

// Real incident: School Girls nydailynews--chris-jones.json sat as a phantom
// "unscored" gap for 12 days (and got an hourly scoring dispatch that found
// nothing) because the classifier could not see the chicagotribune primary
// next to it. The scorer and rebuild skip the secondary on purpose.
test('known-syndication secondary beside its live primary is not a gap when filePath is given', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synd-'));
  const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: the director shapes scene ${i} with a different comic rhythm and the ensemble answers each beat.`).join(' ');
  const secondary = {
    showId: 's', outletId: 'nydailynews', outlet: 'New York Daily News', criticName: 'Chris Jones',
    url: 'https://www.nydailynews.com/2026/09/28/school-girls-african-mean-girls-play-review-broadway/', fullText: body, isFullReview: true,
    contentTier: 'complete', textStatus: 'complete', textQuality: 'full', llmScore: null,
    textFetchedAt: '2026-09-29T07:01:15.894Z',
  };
  const primary = { ...secondary, outletId: 'chicagotribune', outlet: 'Chicago Tribune',
    url: 'https://www.chicagotribune.com/2026/09/28/school-girls-review-broadway/', llmScore: { score: 80 } };
  fs.writeFileSync(path.join(dir, 'nydailynews--chris-jones.json'), JSON.stringify(secondary));
  const fp = path.join(dir, 'nydailynews--chris-jones.json');
  const args = { file: secondary, show: {}, tier: 2, outletScored: false, now: new Date('2026-10-11T12:00:00Z') };

  // no primary on disk yet: still a real gap
  assert.equal(classifySilentGap({ ...args, filePath: fp })?.type, 'unscored');
  fs.writeFileSync(path.join(dir, 'chicagotribune--chris-jones.json'), JSON.stringify(primary));
  assert.equal(classifySilentGap({ ...args, filePath: fp }), null);
  // a primary that will not itself be scored must not hide the secondary
  fs.writeFileSync(path.join(dir, 'chicagotribune--chris-jones.json'), JSON.stringify({ ...primary, wrongShow: true }));
  assert.equal(classifySilentGap({ ...args, filePath: fp })?.type, 'unscored');
});

// Real incident shape (2026-10-11): a BWW 'Video-...-Trailer-Released' news item
// filed as a T2 broadwayworld review sat as an 'unscored' gap for good: the
// scorer skips it (terminal text gate), so nothing would ever classify it.
// Existing regression tests keep non-review pieces flagged while the scorer CAN
// still classify them, so the exclusion is limited to the never-classifiable case.
test('non-review URL the scorer will never take (and no verdict ever recorded) is a correct absence', () => {
  const body = Array.from({ length: 30 }, (_, i) => `Trailer note ${i}: the cast and creative team are announced for the new run.`).join(' ');
  const LATER = { tier: 2, now: new Date('2026-10-11T12:00:00Z') };
  const video = {
    url: 'https://www.broadwayworld.com/westend/article/Video-MILLION-DOLLAR-QUARTET-Trailer-Released-20260908',
    outletId: 'broadwayworld', criticName: 'BWW News Desk', fullText: body, contentTier: 'complete',
    textStatus: 'complete', textFetchedAt: '2026-09-09T07:00:00.000Z', llmScore: null,
  };
  const blocked = { rescoreBlockedReason: 'input_validation_failed:body_too_short',
    rescoreBlockedTextLength: body.length, rescoreBlockedHadExcerpt: false };
  // scorer can still take it: stays a gap (it will be classified not_a_review)
  assert.equal(classify(video, LATER)?.type, 'unscored');
  // scorer will never take it and nothing was ever judged: correct absence
  assert.equal(classify({ ...video, ...blocked }, LATER), null);
  // the same block on a real review URL is still a gap
  const real = { ...video, ...blocked, outletId: 'nydailynews', criticName: 'Jane Doe',
    url: 'https://www.nydailynews.com/2026/09/08/million-dollar-quartet-review-west-end/' };
  assert.equal(classify(real, LATER)?.type, 'unscored');
});

test('BRO-5166: empty-body file at a listing page (BWW regional show page) is not a gap; a manual clear restores it', () => {
  const listing = {
    showId: 'the-humanities-regional-2026', outletId: 'broadwayworld', criticName: 'Unknown',
    url: 'https://www.broadwayworld.com/chicago/regional/The-Humanities',
    source: 'submit-review-form', contentTier: 'truncated', incompleteReason: 'partial_text',
  };
  assert.equal(classify(listing), null);
  assert.notEqual(classify({ ...listing, listingPageUrlManualClear: true }), null);
  // A real BWW regional review article still reports.
  assert.notEqual(classify({ ...listing, url: 'https://www.broadwayworld.com/chicago/article/Review-THE-HUMANITIES-at-Steppenwolf-20261010' }), null);
});

test('BRO-5863: unscored cbsnews /video/ file is not a gap AND its card state is terminal no-review (so the backstop card closes)', () => {
  const f = {
    showId: 'other-desert-cities-2026', outletId: 'cbsnews', criticName: 'Unknown',
    url: 'https://www.cbsnews.com/video/other-desert-cities-on-broadway-family-secrets-laid-bare/',
    source: 'submit-review-form', contentTier: 'truncated', incompleteReason: 'bot_blocked',
    fullText: 'Your web browser is not fully supported by CBS News and CBSNews.com. For optimal experience and full features, please upgrade to a modern browser. You can get the new Microsoft Edge at microsoft.com/edge, available to download on all versions of Windows in more than 90 languages. \'; document.getElementById(\'ieblock\').setAttribute(\'style\', \'background-color: #B60505; color: #F5F5F5; font-size: 20px; font-family: sans-serif; padding: 100px 100px\'); } Watch CBS News',
    textFetchedAt: '2026-10-20T01:24:49.591Z', contentTierReason: 'Short text (63 words)',
  };
  const args = { file: f, show: {}, tier: 2, outletScored: false, now: new Date('2026-10-23T12:00:00Z'), filePath: '/tmp/nonexistent/cbsnews--unknown.json' };
  assert.equal(classifySilentGap(args), null);
  assert.equal(classifyGapCardState(args), GAP_CARD_STATE.NO_REVIEW);
  // a real cbsnews /news/ article at the same state is NOT terminal
  assert.notEqual(classifyGapCardState({ ...args, file: { ...f, url: 'https://www.cbsnews.com/news/other-desert-cities-review/' } }), GAP_CARD_STATE.NO_REVIEW);
});

test('staleOpenGapKeys: only open keys whose file is gone from an existing show dir (BRO-5076)', () => {
  const { staleOpenGapKeys } = require('./t1-silent-gap.js');
  const ledger = { conditions: {
    'gap:a/gone.json': { status: 'open' },
    'backstop:a/gone.json': { status: 'open' },
    'gap:a/here.json': { status: 'open' },
    'gap:a/done.json': { status: 'resolved' },
    'gap:nodir/x.json': { status: 'open' },
    'other:thing': { status: 'open' },
  } };
  const io = { dirExists: (s) => s === 'a', fileExists: (s, f) => f === 'here.json' };
  assert.deepEqual(staleOpenGapKeys(ledger, io), ['gap:a/gone.json', 'backstop:a/gone.json']);
  assert.deepEqual(staleOpenGapKeys(null, io), []);
});
