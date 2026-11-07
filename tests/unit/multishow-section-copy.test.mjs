// BRO-5325: copy one show's section of a multi-review column into its own row.
// Invented placeholder prose, not review text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planSectionCopy, markersMatch } = require('../../scripts/lib/multishow-section-copy.js');

const SECTION = 'If this little comedy works at all it is because the lead is fearless. ' + 'The staging is quick and the jokes land. '.repeat(25) + 'Go see it before the run ends on Sunday.';
const START = 'If_this_little_comedy_works';
const END = 'before_the_run_ends_on_Sunday';
const source = () => ({
  showId: 'col-show', outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'Pat Critic',
  url: 'https://www.wsj.com/article/SB123.html', publishDate: '2011-11-11', contentTier: 'complete',
  fullText: 'other show text ' + SECTION, llmScore: { score: 84 },
});
const ok = { ok: true, text: SECTION, reason: 'venue-box section (2 boxes)', boxes: 2 };
const base = (over = {}) => ({ source: source(), sourceShowId: 'col-show', section: ok, target: null, targetShowId: 'target-show', expectStart: START, expectEnd: END, now: '2026-10-14T00:00:00Z', ...over });

test('creates the target row as a split child and marks the column row as its split parent', () => {
  const r = planSectionCopy(base());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.action, 'create');
  assert.equal(r.row.showId, 'target-show');
  assert.equal(r.row.fullText, SECTION);
  assert.equal(r.row.url, source().url);
  assert.equal(r.row.publishDate, '2011-11-11');
  assert.equal(r.row.criticName, 'Pat Critic');
  assert.equal(r.row.contentTier, 'complete');
  assert.equal(r.row.multiShowSplitChild, true);
  assert.equal(r.row.multiShowSplitParentShowId, 'col-show');
  assert.deepEqual(r.row.multiShowSource, {
    showId: 'col-show', outletId: 'wsj', criticName: 'Pat Critic',
    url: source().url, method: 'venue-box',
  });
  assert.equal(r.row.needsRescore, true);
  assert.equal(r.parent.multiShowSplitParent, true);
  assert.deepEqual(r.parent.multiShowSplitChildShowIds, ['target-show']);
  assert.equal(r.parent.fullText, source().fullText, 'the column row keeps its whole text');
  assert.equal(r.parent.multiShowSplitProcessed, undefined, 'no processed marker: the fan-out must not treat the column as trimmed');
  assert.equal(r.parent.multiShowSplitMethod, 'venue-box');
});

test('the BRO-4431 fan-out leaves a venue-box column whole (it would re-cut godspell-2011 at the wrong place)', () => {
  const { planMultiShowFanout } = require('../../scripts/lib/multi-show-review-fanout.js');
  const r = planSectionCopy(base());
  assert.equal(planMultiShowFanout(r.parent, [{ id: 'col-show', title: 'Col Show' }, { id: 'target-show', title: 'Target Show' }]), null);
});

test('fills a short stub row, moving excerpts that are not in the section aside', () => {
  const target = { showId: 'target-show', criticName: 'Pat Critic', url: 'https://www.wsj.com/articles/SB999', fullText: 'A wrong production excerpt about other actors.',
    assignedScore: 78, llmMetadata: { model: 'x' }, originalScore: '3/5',
    dtliExcerpt: 'A wrong production excerpt about other actors.', showScoreExcerpt: SECTION.slice(0, 120), rejectionReason: 'not_a_review', contentTier: 'truncated' };
  const r = planSectionCopy(base({ target }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.action, 'fill');
  assert.equal(r.row.fullText, SECTION);
  assert.equal(r.row.contentTier, 'complete');
  assert.equal(r.row.dtliExcerpt, null);
  assert.equal(r.row.showScoreExcerpt, SECTION.slice(0, 120), 'an excerpt found in the section stays');
  assert.equal(r.row.rejectionReason, null);
  assert.equal(r.row.assignedScore, null, 'the stub score must not publish against the new text');
  assert.equal(r.row.llmMetadata, null);
  assert.equal(r.row.originalScore, null);
  assert.equal(r.row.previousUrl, 'https://www.wsj.com/articles/SB999');
  assert.equal(r.row.multiShowSource.showId, 'col-show');
  assert.equal(r.row.multiShowSectionCopy.replaced.dtliExcerpt, target.dtliExcerpt);
  assert.equal(r.row.multiShowSectionCopy.replaced.fullText, target.fullText);
});

test('refuses when the section is ambiguous or the markers do not match', () => {
  assert.match(planSectionCopy(base({ section: { ok: false, reason: 'box cluster', boxes: 3 } })).reason, /no unambiguous section: box cluster/);
  assert.match(planSectionCopy(base({ expectEnd: 'before_the_run_ends' })).reason, /does not end/);
  assert.match(planSectionCopy(base({ expectStart: 'The_staging_is_quick' })).reason, /does not start/);
  assert.match(planSectionCopy(base({ expectStart: 'If_this' })).reason, /4\+ words/);
  assert.match(planSectionCopy(base({ expectEnd: undefined })).reason, /4\+ words/);
});

test('refuses an excluded or partial source', () => {
  for (const patch of [{ wrongAttribution: true }, { isNonReview: true }, { wrongProduction: true }, { duplicateOf: 'x.json' }, { multiShowSplitChild: true }, { contentTier: 'truncated' }]) {
    const r = planSectionCopy(base({ source: { ...source(), ...patch } }));
    assert.equal(r.ok, false, JSON.stringify(patch));
  }
});

test('never overwrites a real target text, a human verdict or another critic', () => {
  const t = (over) => ({ showId: 'target-show', criticName: 'Pat Critic', url: 'https://x/1', fullText: '', ...over });
  assert.match(planSectionCopy(base({ target: t({ fullText: 'y'.repeat(500) }) })).reason, /already holds 500 chars/);
  assert.match(planSectionCopy(base({ target: t({ humanReviewScore: 70 }) })).reason, /locked human score/);
  assert.equal(planSectionCopy(base({ target: t({ humanReviewScore: 70, humanReviewScoreProvisional: true }) })).ok, true);
  assert.match(planSectionCopy(base({ target: t({ _locked: true }) })).reason, /_locked/);
  assert.match(planSectionCopy(base({ target: t({ wrongProduction: true }) })).reason, /wrongProduction/);
  assert.match(planSectionCopy(base({ target: t({ wrongShow: true }) })).reason, /wrongShow/);
  assert.match(planSectionCopy(base({ target: t({ isNonReview: true }) })).reason, /isNonReview/);
  assert.match(planSectionCopy(base({ target: t({ criticName: 'Someone Else' }) })).reason, /differs/);
  assert.match(planSectionCopy(base({ targetShowId: 'col-show' })).reason, /must differ/);
});

test('markers compare words, ignoring case and punctuation', () => {
  assert.equal(markersMatch("If it's possible, to become a star.", 'If_it_s_possible', 'to_become_a_star').ok, true);
  assert.equal(markersMatch('Amélie opens the café scene and then the play ends.', 'Amelie_opens_the_cafe', 'and_then_the_play_ends').ok, true);
});

test('a filled web-search stub records the split as a source, so it is not an unverifiable web-search row (venus-in-fur-2011)', () => {
  const target = { showId: 'target-show', criticName: 'Pat Critic', url: 'https://www.wsj.com/articles/SB999', fullText: 'x', source: 'web-search', sources: ['web-search'] };
  const r = planSectionCopy(base({ target }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.row.sources, ['web-search', 'multi-show-split']);
  const { isUnverifiableWebSearchRow } = require('../../scripts/lib/review-guards.js');
  if (typeof isUnverifiableWebSearchRow === 'function') {
    assert.equal(isUnverifiableWebSearchRow({ ...target, fullText: 'y'.repeat(900) }), true, 'the stub alone is unverifiable');
    assert.equal(isUnverifiableWebSearchRow({ ...r.row, fullText: 'y'.repeat(900) }), false);
  }
});

test('a re-run on a row already filed from this column only refreshes its provenance', () => {
  const first = planSectionCopy(base({ target: { showId: 'target-show', criticName: 'Pat Critic', url: 'u', fullText: 'x', sources: ['web-search'] } }));
  const filed = { ...first.row, sources: ['web-search'], llmScore: { score: 80 } };
  delete filed.multiShowSource; // Rows recovered before this provenance field existed.
  const r = planSectionCopy(base({ target: filed }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.action, 'refresh');
  assert.deepEqual(r.row.sources, ['web-search', 'multi-show-split']);
  assert.deepEqual(r.row.llmScore, { score: 80 }, 'nothing else changes');
  assert.deepEqual(r.row.multiShowSource, first.row.multiShowSource);
  assert.equal(r.row.fullText, filed.fullText);
  assert.deepEqual(r.row.multiShowSectionCopy, filed.multiShowSectionCopy);
  assert.equal(r.parent.multiShowSplitMethod, 'venue-box');
  // A different section in that row is still refused.
  assert.match(planSectionCopy(base({ target: { ...filed, fullText: 'z'.repeat(900) } })).reason, /already holds/);
});

// BRO-6736: the fan-out split the joint article from the TARGET's copy and named
// the source show as its child, but the source slot already held the whole
// article, so it stayed whole. The held trim cuts only the source.
const OWN = 'The first play is a tight thriller about a farm town and its bully. ' + 'The two actors play every role with speed. '.repeat(25) + 'I wanted more of a point.';
const OWN_START = 'The_first_play_is';
const OWN_END = 'wanted_more_of_a_point';
const { sectionByMarkers, isHeldSplitSibling } = require('../../scripts/lib/multishow-section-copy.js');
const heldSource = (over = {}) => ({ ...source(), fullText: `${OWN} ${SECTION} Tags: newsletter footer`, ...over });
const heldTarget = (over = {}) => ({
  showId: 'target-show', url: 'https://wsj.com/article/SB123.html/', fullText: SECTION, contentTier: 'complete',
  multiShowSplitParent: true, multiShowSplitProcessed: '2026-05-01T00:00:00Z', multiShowSplitChildShowIds: ['col-show'], ...over,
});
const heldBase = (src, tgt, over = {}) => base({
  source: src, target: tgt, method: 'markers', targetTitle: 'Target Show',
  section: sectionByMarkers(src.fullText, START, END), ownSection: sectionByMarkers(src.fullText, OWN_START, OWN_END), ...over,
});

test('held trim: the target already holds its split section, so only the source is cut to its own section', () => {
  const r = planSectionCopy(heldBase(heldSource(), heldTarget()));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.action, 'held-trim');
  assert.equal(r.row, null, 'the target is not written');
  assert.equal(r.parent.fullText, OWN);
  assert.equal(r.parent.multiShowSplitMethod, 'markers');
  assert.equal(r.parent.multiShowSplitAnchorKind, 'markers');
  assert.deepEqual(r.parent.multiShowSplitChildShowIds, ['target-show']);
  assert.equal(r.parent.needsRescore, true);
  assert.equal(r.parent.llmScore, undefined, 'the whole-article score is dropped');
  assert.equal(r.parent.multiShowHeldTrim.targetShowId, 'target-show');
});

test('held trim needs the source\'s own section and a real held sibling', () => {
  assert.match(planSectionCopy(heldBase(heldSource(), heldTarget(), { ownSection: null })).reason, /own section/);
  // Not a split parent naming the source, or a different URL: the old refusal stands.
  assert.match(planSectionCopy(heldBase(heldSource(), heldTarget({ multiShowSplitChildShowIds: ['someone-else'] }))).reason, /already holds/);
  assert.match(planSectionCopy(heldBase(heldSource(), heldTarget({ url: 'https://www.wsj.com/article/OTHER.html' }))).reason, /already holds/);
  assert.equal(isHeldSplitSibling(heldTarget({ multiShowSplitChild: true }), heldSource(), 'col-show'), false);
});

test('held trim retires an automated whole-article verdict that names the target show (american-son-2018 shape)', () => {
  const src = heldSource({
    contentTier: 'invalid', contentTierReason: 'Wrong show', wrongShow: true, wrongProduction: true,
    wrongShowReason: 'CV-promoted: The scraped content is a review of "Target Show", not "Col Show".',
    contentVerification: { wrongArticle: true, wrongProduction: true },
  });
  const r = planSectionCopy(heldBase(src, heldTarget()));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.parent.wrongShow, undefined);
  assert.equal(r.parent.wrongProduction, undefined);
  assert.equal(r.parent.contentTier, 'complete');
  assert.equal(r.parent.contentVerification.staleWholePostVerdict, true);
  assert.equal(r.parent.multiShowHeldTrim.wholePostVerdict, true);
});

test('held trim keeps a verdict that names neither show, a human verdict, or a non-held source flagged wrong show', () => {
  const otherVerdict = heldSource({ wrongShow: true, wrongShowReason: 'review of "Unrelated Play"' });
  assert.match(planSectionCopy(heldBase(otherVerdict, heldTarget())).reason, /source is wrongShow/);
  const human = heldSource({ wrongShow: true, wrongShowReason: 'review of "Target Show"', wrongShowSource: 'manual' });
  assert.match(planSectionCopy(heldBase(human, heldTarget())).reason, /source is wrongShow/);
  const notHeld = heldSource({ wrongShow: true, wrongShowReason: 'review of "Target Show"' });
  assert.match(planSectionCopy(heldBase(notHeld, null)).reason, /source is wrongShow/);
});

test('held trim clears an automated round-up flag on a two-show joint review (chi-mt shape)', () => {
  const r = planSectionCopy(heldBase(heldSource({ isRoundupArticle: true }), heldTarget()));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.parent.isRoundupArticle, false);
  assert.match(planSectionCopy(heldBase(heldSource({ isRoundupArticle: true }), null)).reason, /source is isRoundupArticle/);
  assert.match(planSectionCopy(heldBase(heldSource({ isRoundupArticle: true, roundupFlagNote: 'owner checked' }), heldTarget())).reason, /source is isRoundupArticle/);
});
