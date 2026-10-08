// BRO-4849: the four classes of "found reviews that never reach the site", one predicate each, on fixtures.
// Real predicates from scripts/lib/coverage-holes.js (CLAUDE.md section 15); the audit script runs the same ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const h = require('../../scripts/lib/coverage-holes.js');
const { sweep, summary } = require('../../scripts/audit-coverage-holes.js');

const SHOW = { id: 'fixture-show-2026', title: 'The Fixture Show', category: 'broadway', status: 'open', openingDate: '2026-03-01' };
const longText = `${'The staging builds slowly and the second act earns its ending. '.repeat(12)}The Fixture Show`;
const base = (over = {}) => ({ showId: SHOW.id, outletId: 'variety', outlet: 'Variety', criticName: 'Frank Rizzo', url: 'https://variety.com/2026/legit/reviews/fixture-show-review-1/', publishDate: '2026-03-02', ...over });

// ---- A: the rebuild drops it for lack of text and score signal (explainExclusion is the judge)
const { explainExclusion, hasValidScore } = require('../../scripts/lib/review-guards.js');
test('A noUsableText: a stub with no text and no score signal is a hole, bucketed by reason; anything the rebuild keeps is not', () => {
  for (const r of h.NO_TEXT_REASONS) {
    const d = base({ incompleteReason: r, contentTier: 'stub' });
    assert.ok(h.NO_SIGNAL_RULES.includes(explainExclusion(d, SHOW)), `${r}: the fixture really is dropped for no signal (${explainExclusion(d, SHOW)})`);
    assert.equal(h.noUsableText(d, SHOW), r);
  }
  assert.equal(h.noUsableText(base({ incompleteReason: 'paywall_weird', contentTier: 'stub' }), SHOW), 'other');
  assert.equal(h.noUsableText(base({ contentTier: 'stub' }), SHOW), 'other', 'a bare stub with no reason is still a hole');
  assert.equal(h.noUsableText(base({ fullText: longText }), SHOW), null, 'usable text');
  assert.equal(h.noUsableText(base({ incompleteReason: 'scraper_timeout', aggregatorStars: '4/5 stars' }), SHOW), null, 'a relayed rating is a score signal');
  // assignedScore alone is NOT a signal to the rebuild (it only counts aggregatorStars, originalScore or llmScore): a hole.
  assert.equal(h.noUsableText(base({ incompleteReason: 'scraper_timeout', assignedScore: 80 }), SHOW), 'scraper_timeout');
  assert.equal(h.noUsableText(base({ incompleteReason: 'scraper_timeout', llmScore: { score: 70 } }), SHOW), null);
  assert.equal(h.noUsableText(base({ incompleteReason: 'scraper_garbage', wrongProduction: true }), SHOW), null, 'an earlier rule already explains it: a decision, not a hole');
  assert.equal(h.noUsableText(base({ incompleteReason: 'scraper_garbage', scoreStatus: 'TO_BE_CALCULATED' }), SHOW), null, 'queued for calculation is not a hole');
  assert.equal(h.noUsableText(null), null);
});

test('A never disagrees with the rebuild: noUsableText is non-null exactly when explainExclusion says no text or score signal', () => {
  const fixtures = [
    base({ incompleteReason: 'scraper_timeout', contentTier: 'stub' }), base({ fullText: longText }), base({ bwwThumb: 'Up', contentTier: 'stub' }),
    base({ dtliThumb: 'Down', contentTier: 'stub' }), base({ starRating: 4, contentTier: 'stub' }), base({ wetStars: '3/5', contentTier: 'stub' }),
    base({ originalScore: '4/5', contentTier: 'stub' }), base({ aggregatorStars: '3/5 stars' }), base({ incompleteReason: 'no_url', url: null }),
    base({ isNonReview: true, contentTier: 'stub' }), base({ rejectionReason: 'not_a_review', contentTier: 'stub' }), base({ duplicateOf: 'x.json', contentTier: 'stub' }),
  ];
  for (const d of fixtures) {
    const ruled = h.NO_SIGNAL_RULES.includes(explainExclusion(d, SHOW));
    assert.equal(h.noUsableText(d, SHOW) !== null, ruled, JSON.stringify(d).slice(0, 120));
  }
});

// ---- B: rejected although the verification says review
const cv = (over = {}) => ({ articleType: 'review', articleTypeConfidence: 'high', verifiedAt: '2026-09-30T00:00:00Z', ...over });
test('B rejectedYetVerified: a review verdict at high confidence under an exclusion is a hole; wrong-article ones are URL repairs', () => {
  const genuine = h.rejectedYetVerified(base({ isNonReview: true, classifiedAt: '2026-09-30T00:00:00Z', contentVerification: cv({ verifiedAt: '2026-06-01T00:00:00Z' }), fullText: longText }), SHOW);
  assert.deepEqual(genuine, { urlOtherShow: false, how: 'isNonReview', blockedBy: 'nonReview' }, 'older CV than the flag: the flag stands, a human should read it');
  const viaEnsemble = h.rejectedYetVerified(base({ rejectionReason: 'not_a_review', contentVerification: cv() }), SHOW);
  assert.equal(viaEnsemble.how, 'rejectionReason');
  assert.equal(viaEnsemble.urlOtherShow, false);
  assert.ok(viaEnsemble.blockedBy, 'names the rule that really keeps it off the site');
  const alsoWrongProd = h.rejectedYetVerified(base({ isNonReview: true, wrongProduction: true, classifiedAt: '2026-09-30T00:00:00Z', contentVerification: cv({ verifiedAt: '2026-06-01T00:00:00Z' }), fullText: longText }), SHOW);
  assert.notEqual(alsoWrongProd.blockedBy, null, 'clearing the non-review flag alone would not publish it: the row says which other rule holds it');
  const wrongUrl = h.rejectedYetVerified(base({ isNonReview: true, classifiedAt: '2026-10-01T00:00:00Z', contentVerification: cv({ wrongArticle: true }) }), SHOW);
  assert.equal(wrongUrl.urlOtherShow, true, 'the verification itself says the stored URL is another article');
  const slug = h.rejectedYetVerified(base({ rejectionReason: 'not_a_review', url: 'https://www.whatsonstage.com/reviews/wendy-and-peter-pan-review_123/', contentVerification: cv() }), { ...SHOW, title: 'My Neighbour Totoro' });
  assert.equal(slug.urlOtherShow, true, 'a slug naming a different show says the same');
});

test('B: not a hole when the verdict is not a confident review, a human cleared it, or the rebuild already demotes the stale flag', () => {
  assert.equal(h.rejectedYetVerified(base({ isNonReview: true, contentVerification: cv({ articleType: 'preview' }) }), SHOW), null);
  assert.equal(h.rejectedYetVerified(base({ isNonReview: true, contentVerification: cv({ articleTypeConfidence: 'medium', confidence: 'medium' }) }), SHOW), null);
  assert.equal(h.rejectedYetVerified(base({ isNonReview: true, nonReviewManualClear: true, contentVerification: cv() }), SHOW), null);
  assert.equal(h.rejectedYetVerified(base({ contentVerification: cv() }), SHOW), null, 'nothing rejects it');
  assert.equal(h.rejectedYetVerified(base({ isNonReview: true }), SHOW), null, 'no verification at all');
  // A classifier flag OLDER than a fresh high-confidence review verdict is demoted by the rebuild (isNonReviewDemotedByFreshCV): it ships.
  const stale = base({ isNonReview: true, classifiedAt: '2026-06-01T00:00:00Z', contentVerification: cv(), fullText: longText });
  assert.equal(h.rejectedYetVerified(stale, SHOW), null);
  assert.equal(h.cvSaysReview(stale), true);
  assert.equal(h.cvSaysReview({ contentVerification: { articleType: 'review', confidence: 'high' } }), true, 'older field name');
  assert.equal(h.cvSaysReview({}), false);
});

// ---- C: scoreable, never scored (hasValidScore is the judge)
test('C neverScored: includable, scoreable, no valid score by the rebuild\'s own definition; queued ones are counted apart', () => {
  const full = base({ fullText: longText, contentTier: 'complete' });
  assert.deepEqual(h.neverScored(full, SHOW), { queued: false });
  assert.deepEqual(h.neverScored({ ...full, needsRescore: true }, SHOW), { queued: true });
  for (const scored of [{ assignedScore: 80 }, { llmScore: { score: 70 } }, { humanReviewScore: 60 }, { adjudicatedScore: 55 }, { aggregatorStars: '4/5 stars' }, { originalScore: '4/5 stars' }]) {
    assert.equal(h.neverScored({ ...full, ...scored }, SHOW), null, `${JSON.stringify(scored)} is a score the rebuild uses`);
    assert.equal(hasValidScore({ ...full, ...scored }), true, 'and the rebuild agrees');
  }
  assert.equal(h.neverScored({ ...full, wrongProduction: true }, SHOW), null, 'excluded files are not scoreable');
  assert.equal(h.neverScored(base({ contentTier: 'stub' }), SHOW), null, 'no text to score');
});

// ---- D: blocked host, no exclusion
test('D blockedUrlUnflagged: a blocked host without an exclusion is a hole; a relayed rating is told apart from junk', () => {
  const tickets = base({ url: 'https://www.telecharge.com/shows/the-fixture-show' });
  assert.deepEqual(h.blockedUrlUnflagged(tickets), { kind: 'junk' });
  assert.deepEqual(h.blockedUrlUnflagged({ ...tickets, aggregatorStars: '4/5 stars' }), { kind: 'relay-star' });
  assert.deepEqual(h.blockedUrlUnflagged({ ...tickets, bwwThumb: 'Up' }), { kind: 'relay-star' });
  assert.equal(h.blockedUrlUnflagged({ ...tickets, isNonReview: true }), null, 'already excluded');
  assert.equal(h.blockedUrlUnflagged(base()), null, 'an outlet URL is fine');
  assert.equal(h.blockedUrlUnflagged(base({ url: null })), null);
});

test('classify returns every class a record falls in', () => {
  assert.deepEqual(h.classify(base({ incompleteReason: 'scraper_timeout', contentTier: 'stub' }), SHOW), { A: { bucket: 'scraper_timeout' } });
  const both = h.classify(base({ rejectionReason: 'not_a_review', contentVerification: cv(), url: 'https://www.telecharge.com/x' }), SHOW);
  assert.deepEqual(Object.keys(both).sort(), ['B'], 'an exclusion flag takes it out of D; the rejected-yet-verified shape stays in B');
  assert.deepEqual(h.classify(base({ fullText: longText, contentTier: 'complete' }), SHOW), { C: { queued: false } });
});

test('isCurrentShow: open and previews always, recently opened within the window, never announced or long closed', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  assert.equal(h.isCurrentShow({ id: 'a', status: 'open', openingDate: '2010-01-01' }, now), true);
  assert.equal(h.isCurrentShow({ id: 'a', status: 'previews' }, now), true);
  assert.equal(h.isCurrentShow({ id: 'a', status: 'closed', openingDate: '2026-08-01' }, now), true, 'closed 60 days after opening is inside the window');
  assert.equal(h.isCurrentShow({ id: 'a', status: 'closed', openingDate: '2025-01-01' }, now), false);
  assert.equal(h.isCurrentShow({ id: 'a', status: 'announced', openingDate: '2026-10-05' }, now), false);
  assert.equal(h.isCurrentShow({ id: 'a', status: 'closed', openingDate: '2026-04-01' }, now, 400), true, 'the window is a parameter');
  assert.equal(h.isCurrentShow(null, now), false);
});

// ---- the audit script over a tiny corpus
function corpus(files, shows = [SHOW], reviews = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4849-'));
  fs.mkdirSync(path.join(root, 'data', 'review-texts', SHOW.id), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify({ shows }));
  fs.writeFileSync(path.join(root, 'data', 'reviews.json'), JSON.stringify({ reviews }));
  for (const [name, d] of Object.entries(files)) fs.writeFileSync(path.join(root, 'data', 'review-texts', SHOW.id, name), JSON.stringify(d));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

test('sweep counts each class once per file, joins published, and lists the shows affected', () => {
  const c = corpus({
    'a.json': base({ incompleteReason: 'url_content_mismatch', contentTier: 'stub', criticName: 'A' }),
    'b.json': base({ rejectionReason: 'not_a_review', contentVerification: cv(), criticName: 'B', url: 'https://variety.com/b' }),
    'c.json': base({ fullText: longText, contentTier: 'complete', criticName: 'C', url: 'https://variety.com/c' }),
    'd.json': base({ url: 'https://www.telecharge.com/shows/x', criticName: 'D', aggregatorStars: '4/5 stars' }),
    'ok.json': base({ fullText: longText, assignedScore: 80, criticName: 'OK', url: 'https://variety.com/ok' }),
    'failed-fetches.json': { not: 'a review' },
  }, [SHOW], [{ showId: SHOW.id, url: 'https://www.telecharge.com/shows/x' }]);
  try {
    const out = sweep({ root: c.root, now: Date.parse('2026-10-08T00:00:00Z') });
    assert.equal(out.shows, 1);
    assert.equal(out.files, 5, 'failed-fetches.json is not a review');
    assert.equal(out.A.length, 1);
    assert.equal(out.A[0].bucket, 'url_content_mismatch');
    assert.equal(out.B.length, 1);
    assert.equal(out.C.length, 1);
    assert.equal(out.D.length, 1);
    assert.equal(out.D[0].published, true, 'D rows that are on the site are the ones doing harm');
    assert.equal(out.showsAffected, 1);
    assert.match(summary(out), /A noUsableText=1 .*\n.*B rejectedYetVerified=1 .*\n.*C neverScored=1 alreadyQueued=0\nD blockedUrlUnflagged=1 .* publishedOnSite=1/);
    assert.equal(sweep({ root: c.root, only: 'nope' }).files, 0, '--show narrows the sweep');
  } finally { c.cleanup(); }
});

test('the CLI is advisory by default and --strict fails on any hole; a clean corpus passes both', () => {
  const dirty = corpus({ 'a.json': base({ incompleteReason: 'scraper_timeout', contentTier: 'stub' }) });
  const clean = corpus({ 'ok.json': base({ fullText: longText, assignedScore: 80 }) });
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'audit-coverage-holes.js');
  // The script reads data/ relative to its own location, so run a copy placed inside each fake root.
  const run = (root, args) => {
    if (!fs.existsSync(path.join(root, 'scripts'))) {
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.cpSync(path.join(path.dirname(script), 'lib'), path.join(root, 'scripts', 'lib'), { recursive: true, dereference: true, filter: (s) => !/\.test\./.test(s) });
      fs.copyFileSync(script, path.join(root, 'scripts', 'audit-coverage-holes.js'));
      fs.symlinkSync(path.join(path.dirname(script), '..', 'node_modules'), path.join(root, 'node_modules'));
    }
    try { return { code: 0, out: execFileSync('node', [path.join(root, 'scripts', 'audit-coverage-holes.js'), ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
  };
  try {
    const plain = run(dirty.root, []);
    assert.equal(plain.code, 0, plain.out);
    assert.match(plain.out, /A noUsableText=1/);
    assert.equal(run(dirty.root, ['--strict']).code, 1);
    assert.equal(run(clean.root, ['--strict']).code, 0);
  } finally { dirty.cleanup(); clean.cleanup(); }
});
