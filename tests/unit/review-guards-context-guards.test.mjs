/**
 * BRO-3179: the rebuild's three show-context exclusion guards (late date, URL
 * year reroute, director cross-check) live in review-guards.js as pure helpers
 * that rebuild-all-reviews.js and explainExclusion() both call.
 *
 * BRO-3584: a wrongProduction clear lifts an invalid content tier only when the
 * tier is not from garbage text, or a human verified the file.
 *
 * Pattern: require() the real functions, never copy logic into tests (§15).
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const g = require('../../scripts/lib/review-guards.js');
const { classifyContentTier } = require('../../scripts/lib/content-quality.js');

const SHOWS = [
  { id: 'foo-2001', title: 'Foo', category: 'broadway', status: 'closed', openingDate: '2001-03-01', closingDate: '2015-01-01',
    creativeTeam: [{ role: 'Director', name: 'Alice Old' }] },
  { id: 'foo-2025', title: 'Foo', category: 'broadway', status: 'open', openingDate: '2025-04-01',
    creativeTeam: [{ role: 'Director', name: 'Bob New' }] },
  { id: 'bar-2010', title: 'Bar', category: 'broadway', status: 'closed', openingDate: '2010-01-10', closingDate: '2010-06-01' },
];
const [OLD, NEW, BAR] = SHOWS;
const PAGE_404 = 'Page Not Found. We are sorry, but the page you requested could not be located on this server. Please check the address or return to the homepage to browse our latest theater coverage, news and reviews. '.repeat(2);

const base = (over = {}) => ({
  showId: 'foo-2001', outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Ben Brantley',
  url: 'https://www.nytimes.com/2001/03/02/theater/foo-review.html', publishDate: '2001-03-02', assignedScore: 75,
  fullText: 'Foo is a delightful evening of theater with Alice Old directing a strong cast. '.repeat(30),
  ...over,
});

let guards;
before(() => { guards = g.setMultiProdGuardShows(SHOWS); });

describe('baseline fixture', () => {
  test('is includable', () => assert.strictEqual(g.explainExclusion(base(), OLD), null));
});

describe('evaluateLateDateGuard', () => {
  const late = (over) => base({ showId: 'bar-2010', url: 'https://x.com/2011/03/01/bar', publishDate: '2011-03-01', ...over });
  test('URL date >6 months after closing excludes', () => {
    const r = g.evaluateLateDateGuard(late(), BAR);
    assert.strictEqual(r.exclude, true);
    assert.strictEqual(r.dateSource, 'url');
    assert.strictEqual(g.explainExclusion(late(), BAR), 'lateDateMismatch');
  });
  test('within 6 months is kept', () => {
    assert.strictEqual(g.evaluateLateDateGuard(late({ url: 'https://x.com/2010/09/01/bar' }), BAR).exclude, false);
  });
  test('allowLateDate bypasses', () => {
    assert.strictEqual(g.evaluateLateDateGuard(late({ allowLateDate: true }), BAR).exclude, false);
  });
  test('plain publishDate without a timestamp is not trusted', () => {
    assert.strictEqual(g.evaluateLateDateGuard(late({ url: 'https://x.com/bar' }), BAR).exclude, false);
  });
  test('timestamped publishDate is trusted', () => {
    const r = g.evaluateLateDateGuard(late({ url: 'https://x.com/bar', publishDate: '2011-03-01T10:00:00Z' }), BAR);
    assert.strictEqual(r.exclude, true);
    assert.strictEqual(r.dateSource, 'publishDate');
  });
  test('open show never fires', () => {
    assert.strictEqual(g.evaluateLateDateGuard(late({ showId: 'foo-2025' }), NEW).exclude, false);
  });
});

describe('evaluateUrlYearGuard', () => {
  const reroute = (over) => base({ showId: 'foo-2025', url: 'https://x.com/2001/03/foo', publishDate: '2001-03-02',
    fullText: 'A fine revival. '.repeat(40), ...over });
  test('year near the older sibling reroutes', () => {
    const r = g.evaluateUrlYearGuard(reroute(), NEW, guards.year['foo-2025']);
    assert.strictEqual(r.decision.action, 'reroute');
    assert.strictEqual(r.decision.targetShowId, 'foo-2001');
    assert.strictEqual(r.yearSource, 'publishDate');
    assert.strictEqual(g.explainExclusion(reroute(), NEW), 'urlYearReroute');
  });
  test('mid-run review of a long-running show stays (run window)', () => {
    const r = g.evaluateUrlYearGuard(base({ publishDate: '2014-05-01' }), OLD, guards.year['foo-2001']);
    assert.notStrictEqual(r.decision.action, 'reroute');
  });
  for (const flag of ['wrongProductionManualClear', 'wrongProductionOverride', 'allowEarlyDate', 'allowLateDate', 'routedFromShowId']) {
    test(`${flag} bypasses`, () => {
      assert.strictEqual(g.evaluateUrlYearGuard(reroute({ [flag]: flag === 'routedFromShowId' ? 'foo-2001' : true }), NEW, guards.year['foo-2025']), null);
    });
  }
  test('single-production show has no guard entry', () => {
    assert.strictEqual(g.evaluateUrlYearGuard(base({ showId: 'bar-2010' }), BAR, guards.year['bar-2010']), null);
  });
});

describe('evaluateDirectorGuard', () => {
  // No publishDate: nothing shows it predates the newer production, so the
  // guard holds (a dated post-2025 copy would be caught first by the URL-year guard).
  const contaminated = (over) => base({ fullText: 'Bob New brings fresh energy to this staging of Foo. '.repeat(10),
    publishDate: null, ...over });
  test('older production naming the newer director is excluded', () => {
    assert.deepStrictEqual(g.evaluateDirectorGuard(contaminated(), OLD, guards.director['foo-2001']),
      { dirName: 'bob new', newerId: 'foo-2025' });
    assert.strictEqual(g.explainExclusion(contaminated(), OLD), 'directorMismatch');
  });
  test('own director is fine', () => {
    assert.strictEqual(g.evaluateDirectorGuard(base(), OLD, guards.director['foo-2001']), null);
  });
  test('routedFromShowId and humanReviewedWrongProduction=false bypass', () => {
    assert.strictEqual(g.evaluateDirectorGuard(contaminated({ routedFromShowId: 'foo-2025' }), OLD, guards.director['foo-2001']), null);
    assert.strictEqual(g.evaluateDirectorGuard(contaminated({ humanReviewedWrongProduction: false }), OLD, guards.director['foo-2001']), null);
  });
  test('wrongProductionOverride deliberately does NOT bypass', () => {
    assert.ok(g.evaluateDirectorGuard(contaminated({ wrongProductionOverride: true }), OLD, guards.director['foo-2001']));
  });
  test('text under 30 chars is skipped', () => {
    assert.strictEqual(g.evaluateDirectorGuard(contaminated({ fullText: 'Bob New.' }), OLD, guards.director['foo-2001']), null);
  });  // BRO-5373: same-director returns whose older entry lists no director.
  const NO_DIR = { ...OLD, creativeTeam: [] };
  test('no director on file: published inside its own run and before the newer production began is kept', () => {
    assert.strictEqual(g.evaluateDirectorGuard(contaminated({ publishDate: '2001-03-02' }), NO_DIR, guards.director['foo-2001']), null);
    assert.strictEqual(g.evaluateDirectorGuard(contaminated({ publishDate: 'March 2nd, 2001' }), NO_DIR, guards.director['foo-2001']), null);
  });
  test('older production names its own director: an in-window date does not lift the exclusion', () => {
    // Reviews of later productions misfiled with publishDate defaulted to the old opening date.
    assert.ok(g.evaluateDirectorGuard(contaminated({ publishDate: '2001-03-01' }), OLD, guards.director['foo-2001']));
    assert.strictEqual(g.explainExclusion(contaminated({ publishDate: '2001-03-01' }), OLD), 'directorMismatch');
  });
  test('a date outside its own run window keeps the exclusion', () => {
    assert.ok(g.evaluateDirectorGuard(contaminated({ publishDate: '1990-01-01' }), NO_DIR, guards.director['foo-2001']));
  });
  test('published after the newer production began keeps the exclusion', () => {
    assert.ok(g.evaluateDirectorGuard(contaminated({ publishDate: '2025-04-03' }), NO_DIR, guards.director['foo-2001']));
  });
  test('a missing or unparseable publishDate keeps the exclusion', () => {
    assert.ok(g.evaluateDirectorGuard(contaminated({ publishDate: null }), NO_DIR, guards.director['foo-2001']));
    assert.ok(g.evaluateDirectorGuard(contaminated({ publishDate: 'sometime' }), NO_DIR, guards.director['foo-2001']));
  });
});

describe('BRO-3584: invalid tier vs wrongProduction clear', () => {
  const invalid = (over) => base({ contentTier: 'invalid', wrongProductionManualClear: true, ...over });
  test('garbage tier without human verification stays excluded', () => {
    const d = invalid({ contentTierReason: 'Garbage content: Error/404 page' });
    assert.strictEqual(g.isGarbageTierReason(d), true);
    assert.strictEqual(g.wrongProductionClearLiftsInvalidTier(d), false);
    assert.strictEqual(g.explainExclusion(d, OLD), 'contentTierInvalid');
  });
  test('garbage tier with human verification is lifted', () => {
    const d = invalid({ contentTierReason: 'Garbage content: paywall', contentVerification: { verifiedBy: 'human-2026' } });
    assert.strictEqual(g.invalidTierHumanVerified(d), true);
    assert.strictEqual(g.wrongProductionClearLiftsInvalidTier(d), true);
  });
  test('non-garbage invalid reason is still lifted by the clear', () => {
    assert.strictEqual(g.wrongProductionClearLiftsInvalidTier(invalid({ contentTierReason: 'Wrong production' })), true);
  });
  test('manualContentTier never hides a real 404 page', () => {
    const r = classifyContentTier({ manualContentTier: 'complete', fullText: PAGE_404 });
    if (r.contentTier === 'invalid') assert.match(r.tierReason, /^Garbage content: Error\/404 page/);
    else assert.fail(`expected invalid, got ${r.contentTier}`);
  });
  test('chained: a 404 page under a manual tier plus a wrongProduction clear stays excluded', () => {
    const fullText = PAGE_404;
    const t = classifyContentTier({ manualContentTier: 'complete', fullText });
    const d = invalid({ fullText, contentTierReason: t.tierReason });
    assert.strictEqual(g.explainExclusion(d, OLD), 'contentTierInvalid');
  });
});

describe('evaluateShowMentionGuard human clear (BRO-5395)', () => {
  const text = 'word '.repeat(400);
  const failing = { valid: false, confidence: 'high', reason: 'Show not mentioned' };
  test('without a clear the guard nulls an unscored review', () => {
    assert.strictEqual(g.evaluateShowMentionGuard({}, text, 400, failing).action, 'null-text');
  });
  test('a recorded human clear makes the guard skip', () => {
    assert.strictEqual(g.evaluateShowMentionGuard({ showNotMentionedManualClear: 'url, venue and dates match' }, text, 400, failing).action, 'skip');
    assert.strictEqual(g.evaluateShowMentionGuard({ showNotMentionedManualClear: '  ' }, text, 400, failing).action, 'null-text');
  });
});
