// BRO-4430: real reviews of the right production dropped because a date, URL
// or byline on the file was wrong, or a stale file blocked the outlet's slot.
// Every assertion require()s the production function (CLAUDE.md rule 15).
// Fixtures are the verified cases from the 2026-09-30 coverage audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  isAggregatorPageUrl, isStaleNonReviewSlot, urlOwnedByOtherCritic,
  isDatelessRevivalHold, shouldRetryDatelessHoldFetch,
} = require('./review-slot-guards.js');
const { detectIngestCollision } = require('./manual-review-fields.js');
const { maybeUpgradeUrl, mergeReviews } = require('./review-normalization.js');
const { updateFileUrlWithInvariant } = require('./url-change-invariant.js');
const { filledTextIsOtherArticle, filledDateOutsideWindow, discardWrongPageFill } = require('./flagged-recovery.js');
const { stripTrailingJunk } = require('./text-cleaning.js');
const { selectScorableText } = require('./scorable-text.js');
const { applyReviewFieldEdit, unexpectedChanges } = require('./review-field-edit.js');

const TM_CAST = 'https://www.theatermania.com/news/cast-announced-for-the-body-of-mary-a-play-in-three-acts-of-god_1848241/';
const TM_REVIEW = 'https://www.theatermania.com/news/review-the-body-of-mary-a-play-in-three-acts-of-god_1853803/';
const NYTG_SHOW = 'https://www.newyorktheatreguide.com/show/47271-the-pass';
const NYTG_REVIEW = 'https://www.newyorktheatreguide.com/reviews/the-pass-off-broadway-review';
const WET_ROUNDUP = 'https://www.westendtheatre.com/362643/news/how-the-other-half-loves-reviews-round-up/';
const NYSR_SCHECK = 'https://nystagereview.com/2026/08/11/an-american-daughter-wendy-wassersteins-play-shows-its-age/';
const NYSR_FINKLE = 'https://nystagereview.com/2026/08/11/an-american-daughter-wendy-wasserstein-revival-falters/';

const BODY_OF_MARY = {
  id: 'the-body-of-mary-a-play-in-three-acts-of-god-off-broadway-2026',
  title: 'The Body of Mary: A Play in Three Acts of God',
  openingDate: '2026-09-15', previewsStartDate: '2026-09-08', status: 'open', category: 'off-broadway',
};

const castFile = () => ({
  showId: BODY_OF_MARY.id, outletId: 'theatermania', outlet: 'TheaterMania', criticName: 'Unknown',
  url: TM_CAST, publishDate: '2026-08-06', fullText: 'x'.repeat(2040), contentTier: 'invalid',
  wrongProduction: true, wrongProductionNote: 'Date guard: review 2026-08-06 is 12d before 2026-09-08',
});

function tmpShowDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4430-'));
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  }
  return dir;
}

// ── Stale non-review slot (The Body of Mary TheaterMania, The Pass NYTG) ──

test('a flagged non-review page is a stale slot for a real review url', () => {
  assert.equal(isStaleNonReviewSlot(castFile(), TM_REVIEW), true);
  const nytg = { url: NYTG_SHOW, wrongShow: true, isNonReview: true, contentTier: 'invalid', criticName: 'Unknown' };
  assert.equal(isStaleNonReviewSlot(nytg, NYTG_REVIEW), true);
});

test('a flagged real review url is NOT a stale slot (Beaches protection holds)', () => {
  const priorProduction = { ...castFile(), url: 'https://www.theatermania.com/news/review-the-body-of-mary_1000001/' };
  assert.equal(isStaleNonReviewSlot(priorProduction, TM_REVIEW), false);
  // Unflagged, duplicate, locked and same-url records never qualify.
  assert.equal(isStaleNonReviewSlot({ ...castFile(), wrongProduction: false }, TM_REVIEW), false);
  assert.equal(isStaleNonReviewSlot({ ...castFile(), duplicateOf: 'x.json' }, TM_REVIEW), false);
  assert.equal(isStaleNonReviewSlot({ ...castFile(), _locked: true }, TM_REVIEW), false);
  assert.equal(isStaleNonReviewSlot(castFile(), TM_CAST), false);
  // The incoming must itself be a review candidate.
  assert.equal(isStaleNonReviewSlot(castFile(), NYTG_SHOW), false);
});

test('detectIngestCollision lets the real review past a flagged cast-announcement file', () => {
  const dir = tmpShowDir({ 'theatermania--unknown.json': castFile() });
  const res = detectIngestCollision({
    showDir: dir, outletId: 'theatermania', criticName: 'Unknown', url: TM_REVIEW,
    publishDate: null, show: BODY_OF_MARY,
  });
  assert.deepEqual(res, { ok: true });
});

test('detectIngestCollision still blocks against a flagged prior-production REVIEW', () => {
  const prior = { ...castFile(), url: 'https://www.theatermania.com/news/review-the-body-of-mary_1000001/' };
  const dir = tmpShowDir({ 'theatermania--unknown.json': prior });
  const res = detectIngestCollision({
    showDir: dir, outletId: 'theatermania', criticName: 'Unknown', url: TM_REVIEW,
    publishDate: null, show: BODY_OF_MARY,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'stale-flag-on-existing-file');
});

test('maybeUpgradeUrl moves a flagged non-review slot onto the real review url', () => {
  const rec = castFile();
  assert.equal(maybeUpgradeUrl(rec, TM_REVIEW, 'test'), true);
  assert.equal(rec.url, TM_REVIEW);
  assert.notEqual(rec.wrongProduction, true, 'the page flag leaves with the page url');
  // A flagged REAL review stays refused (#1695).
  const prior = { ...castFile(), url: 'https://www.theatermania.com/news/review-the-body-of-mary_1000001/' };
  assert.equal(maybeUpgradeUrl(prior, TM_REVIEW, 'test'), false);
});

test('a url change clears the old article\'s "not a review" verdict', () => {
  const { applyUrlChangeInvariant } = require('./url-change-invariant.js');
  const before = { url: NYTG_SHOW, isNonReview: true, isNonReviewReason: 'CV-promoted (not a review): show page', criticName: 'Unknown' };
  const after = { ...before, url: NYTG_REVIEW };
  const inv = applyUrlChangeInvariant(before, after, { fileLabel: 'nytg--unknown.json' });
  assert.ok(inv.cleared.includes('isNonReview'));
  assert.equal(after.isNonReview, undefined);
  assert.equal(after.isNonReviewReason, undefined);
});

// ── Aggregator url backfill (How the Other Half Loves FT) ──

test('aggregator and round-up pages are recognised; outlet review urls are not', () => {
  assert.equal(isAggregatorPageUrl(WET_ROUNDUP), true);
  assert.equal(isAggregatorPageUrl('https://www.ft.com/content/0b3c-review'), false);
  assert.equal(isAggregatorPageUrl(NYSR_FINKLE), false);
  assert.equal(isAggregatorPageUrl(''), false);
});

test('updateFileUrlWithInvariant refuses an aggregator page into an empty-url Theatre Record file', () => {
  const ft = {
    showId: 'how-the-other-half-loves-west-end-2026', outletId: 'financialtimes', criticName: 'Sarah Hemming',
    url: '', fullText: 'y'.repeat(3507), contentTier: 'complete', source: 'theatre-record',
  };
  const dir = tmpShowDir({ 'financialtimes--sarah-hemming.json': ft });
  const fp = path.join(dir, 'financialtimes--sarah-hemming.json');
  assert.equal(updateFileUrlWithInvariant(fp, WET_ROUNDUP, {}, { stampOnNoop: true }), null);
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).url, '');
});

// ── NYSR repoint onto another critic's url ──

test('urlOwnedByOtherCritic names the sibling holding the url for a different critic', () => {
  const dir = tmpShowDir({
    'nysr--frank-scheck.json': { outletId: 'nysr', criticName: 'Frank Scheck', url: NYSR_SCHECK },
    'nysr--david-finkle.json': { outletId: 'nysr', criticName: 'David Finkle', url: NYSR_FINKLE },
    'nysr--unknown.json': { outletId: 'nysr', criticName: 'Unknown', url: 'https://nystagereview.com/2026/08/11/other/' },
  });
  const owner = urlOwnedByOtherCritic({ showDir: dir, url: NYSR_SCHECK, selfFilename: 'nysr--david-finkle.json', selfCriticName: 'David Finkle' });
  assert.equal(owner && owner.filename, 'nysr--frank-scheck.json');
  // Its own url, an Unknown sibling, or an Unknown self: no conflict.
  assert.equal(urlOwnedByOtherCritic({ showDir: dir, url: NYSR_FINKLE, selfFilename: 'nysr--david-finkle.json', selfCriticName: 'David Finkle' }), null);
  assert.equal(urlOwnedByOtherCritic({ showDir: dir, url: 'https://nystagereview.com/2026/08/11/other/', selfFilename: 'nysr--david-finkle.json', selfCriticName: 'David Finkle' }), null);
  assert.equal(urlOwnedByOtherCritic({ showDir: dir, url: NYSR_SCHECK, selfFilename: 'nysr--unknown.json', selfCriticName: 'Unknown' }), null);
});

test("updateFileUrlWithInvariant refuses to repoint Finkle's file onto Scheck's review", () => {
  const dir = tmpShowDir({
    'nysr--frank-scheck.json': { showId: 'an-american-daughter-off-broadway-2026', outletId: 'nysr', criticName: 'Frank Scheck', url: NYSR_SCHECK },
    'nysr--david-finkle.json': { showId: 'an-american-daughter-off-broadway-2026', outletId: 'nysr', criticName: 'David Finkle', url: NYSR_FINKLE, showNotMentioned: true },
  });
  const fp = path.join(dir, 'nysr--david-finkle.json');
  assert.equal(updateFileUrlWithInvariant(fp, NYSR_SCHECK, { urlDiscoveryMethod: 'show-not-mentioned-recovery' }, { stampOnNoop: true }), null);
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).url, NYSR_FINKLE);
});

// ── Dateless-revival hold (An American Daughter NY Sun) ──

const SUN = {
  showId: 'an-american-daughter-off-broadway-2026', outletId: 'new-york-sun', criticName: 'Elysa Gardner',
  url: 'https://www.nysun.com/article/an-american-daughter-still-not-quite-of-age',
  publishDate: null, wrongProduction: true, wrongProductionReason: 'dateless-revival',
  wrongProductionNote: 'Dateless revival guard: no publishDate on multi-production title that has not yet opened',
  incompleteReason: 'wrong_content', serpDiscoveryAbandoned: true,
};

test('a dateless-revival hold with an abandoned SERP still gets its stored url fetched', () => {
  assert.equal(isDatelessRevivalHold(SUN), true);
  assert.equal(shouldRetryDatelessHoldFetch(SUN, Date.parse('2026-09-30')), true);
});

test('the dateless-hold fetch is cooled down and ends once a date or no url', () => {
  const now = Date.parse('2026-09-30');
  assert.equal(shouldRetryDatelessHoldFetch({ ...SUN, wrongShowRetryAt: '2026-09-25T00:00:00Z' }, now), false);
  assert.equal(shouldRetryDatelessHoldFetch({ ...SUN, wrongShowRetryAt: '2026-09-01T00:00:00Z' }, now), true);
  assert.equal(shouldRetryDatelessHoldFetch({ ...SUN, publishDate: '2026-08-11' }, now), false);
  assert.equal(shouldRetryDatelessHoldFetch({ ...SUN, url: '' }, now), false);
  // Other wrongProduction reasons are not this hold.
  assert.equal(isDatelessRevivalHold({ ...SUN, wrongProductionReason: 'x', wrongProductionNote: 'Date guard: x' }), false);
});

test('collect-review-texts skips SERP rediscovery for a dateless hold', () => {
  const src = fs.readFileSync(new URL('../collect-review-texts.js', import.meta.url), 'utf8');
  assert.match(src, /const needsSerpDiscovery = !review\._datelessDateRetry/);
  assert.match(src, /_datelessDateRetry: data\._datelessDateRetry === true/);
});

// ── Wrong page served for the right url (Golden Boy BroadwayWorld) ──

test('a fill dated outside the window on an in-window-dated url is a wrong page, not a wrong production', () => {
  const url = 'https://www.broadwayworld.com/westend/article/Review-GOLDEN-BOY-starring-Josh-OConnor-Almeida-Theatre-20260916';
  assert.equal(filledDateOutsideWindow('2026-02-11', '2026-09-15'), true);
  assert.equal(filledTextIsOtherArticle('2026-02-11', url, '2026-09-15'), true);
  // A url dated in the other production's era keeps the wrongProduction flag.
  assert.equal(filledTextIsOtherArticle('2021-05-01', 'https://www.broadwayworld.com/westend/article/Review-X-20210501', '2026-09-15'), false);
  // No url date: no contradiction, flag as before.
  assert.equal(filledTextIsOtherArticle('2026-02-11', 'https://www.example.com/review-golden-boy', '2026-09-15'), false);
});

test('discarding a wrong-page fill also drops the rating lifted off that page', () => {
  const rec = discardWrongPageFill({
    url: 'https://www.broadwayworld.com/westend/article/Review-GOLDEN-BOY-20260916',
    fullText: 'Review: MAN AND BOY ...', publishDate: '2026-02-11',
    originalScore: '4/5', originalRating: '4 stars', scoreSource: 'bww-stars', assignedScore: 80,
  });
  assert.equal(rec.fullText, null);
  assert.equal(rec.wrongFullText, 'Review: MAN AND BOY ...');
  for (const f of ['publishDate', 'originalScore', 'originalRating', 'scoreSource', 'assignedScore']) assert.equal(rec[f], undefined, f);
  assert.equal(rec.needsRefetch, true);
  assert.notEqual(rec.wrongProduction, true, 'the url is not flagged');
});

test('a dateless-hold fetch stamps its cooldown on success and failure, and bypasses the good-text skip', () => {
  const src = fs.readFileSync(new URL('../collect-review-texts.js', import.meta.url), 'utf8');
  assert.equal((src.match(/if \(review\._datelessDateRetry && review\.filePath\) stampDatelessRetry/g) || []).length, 2);
  assert.match(src, /!urlCorrectedRefetch && !data\._datelessDateRetry/);
});

test('a flagged prior-production review on a playbill /news/article/ url still blocks', () => {
  const prior = { url: 'https://www.playbill.com/news/article/review-the-body-of-mary-123', wrongProduction: true, criticName: 'Unknown' };
  assert.equal(isStaleNonReviewSlot(prior, TM_REVIEW), false);
});

test('a duplicate sibling cannot own a url', () => {
  const dir = tmpShowDir({
    'nysr--frank-scheck.json': { outletId: 'nysr', criticName: 'Frank Scheck', url: NYSR_SCHECK, duplicateOf: 'x.json' },
  });
  assert.equal(urlOwnedByOtherCritic({ showDir: dir, url: NYSR_SCHECK, selfFilename: 'nysr--david-finkle.json', selfCriticName: 'David Finkle' }), null);
});

test('maybeUpgradeUrl refuses any aggregator host, not only round-up shapes', () => {
  const rec = { outletId: 'financialtimes', criticName: 'Sarah Hemming', url: '', fullText: '' };
  assert.equal(maybeUpgradeUrl(rec, 'https://www.stagedoor.com/show/how-the-other-half-loves', 'test'), false);
});

// ── Aggregator row about another article (Anansi the Spider, The Stage) ──

test("an aggregator row for a different article does not fill the file's date or byline", () => {
  const existing = {
    showId: 'anansi-the-spider-west-end-2026', outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/anansi-the-spider-review-picnic-lawn-regents-park-open-air-theatre-london',
    urlVerified: true, urlVerifiedAuto: true,
    previousUrl: 'https://www.thestage.co.uk/reviews/anansi-the-spider-review-at-unicorn-theatre-london-justin-audibert',
  };
  const incoming = {
    outletId: 'thestage', criticName: 'Anna James', publishDate: 'January 26th, 2023', source: 'show-score',
    url: 'https://www.thestage.co.uk/reviews/anansi-the-spider-review-at-unicorn-theatre-london-justin-audibert',
  };
  const merged = mergeReviews(existing, incoming, {}, { script: 'test', showId: existing.showId });
  assert.equal(merged.url, existing.url);
  assert.ok(!merged.publishDate, 'the 2023 date stays off the 2026 review');
  assert.equal(merged.criticName, 'Unknown');
  // A url this file never held is not proof of another article: fills as before.
  const variant = mergeReviews(existing, { ...incoming, url: existing.url + '?amp=1', publishDate: '2026-08-19' }, {}, { script: 'test' });
  assert.equal(variant.publishDate, '2026-08-19');
  // Same article: fills as before.
  const same = mergeReviews(existing, { ...incoming, url: existing.url, publishDate: '2026-08-19', criticName: 'Oliver Jones' }, {}, { script: 'test' });
  assert.equal(same.publishDate, '2026-08-19');
  assert.equal(same.criticName, 'Oliver Jones');
});

// ── Site chrome made a real review unscoreable (Tru, London Theatre) ──

const TRU_REVIEW = "'Tru' review — Jesse Tyler Ferguson is captivating as the troubled, complex Truman Capote. "
  + 'Read our review of Jay Presson Allen’s play Tru, now at the Menier Chocolate Factory. '
  + 'Ferguson is captivating in the role: camp, catty, and totally unapologetic. '.repeat(12)
  + 'Is Tru good? A powerhouse solo performance and an intimate character study.';
const LT_CHROME = ' Originally published on Sep 27, 2026 23:00 Tru 19 September 2026 - 14 November 2026 Tickets '
  + 'Latest News 1 Everything you need to know about ‘Charlie and the Chocolate Factory’ in the West End '
  + '2 Jesus Christ Superstar returns 3 The Life extends 4 Charlotte d’Amboise joins 5 The First Wives Club '
  + '6 Nanny McPhee 7 Affluenza 8 Triumph 9 Abba Voyage 10 The Devil Wears Prada 11 Hamilton 12 Wicked 13 Les Misérables '
  + 'Related articles Learn about the real history behind ‘Tru’';

test('London Theatre trailing chrome is stripped at "Originally published on"', () => {
  const out = stripTrailingJunk(TRU_REVIEW + LT_CHROME);
  assert.equal(out, TRU_REVIEW.trim());
});

// BRO-4584 made "Tru" count as a show mention (curated properNounTitles), so the
// Tru text with chrome now passes on its own: a mentioned show's other-show
// references are not multi-show junk. The strip-and-retry path below is still
// needed for titles the mention check cannot see; "Da" (2 letters, not curated)
// stands in for that case.
const DA_REVIEW = TRU_REVIEW.replace(/\bTru\b/g, 'Da');
const DA_CHROME = LT_CHROME.replace(/\bTru\b/g, 'Da');

test('stored text with that chrome is still scoreable on its stripped form', () => {
  const sel = selectScorableText({ showId: 'da-1978', fullText: DA_REVIEW + DA_CHROME }, { showTitle: 'Da' });
  assert.ok(sel && sel.isExcerpt === false);
  assert.ok(!sel.text.includes('Latest News'));
  // Text that already passes is returned unchanged.
  const clean = selectScorableText({ showId: 'da-1978', fullText: DA_REVIEW }, { showTitle: 'Da' });
  assert.equal(clean.text, DA_REVIEW);
  // The Tru review itself is scoreable as stored (show mention recognized).
  const tru = selectScorableText({ showId: 'tru-off-west-end-2026', fullText: TRU_REVIEW + LT_CHROME }, { showTitle: 'Tru' });
  assert.ok(tru && tru.isExcerpt === false);
});

// ── Repair route: guarded url edit for execute-approved-fix ──

const STAMP = { fixId: 'test-plan', at: '2026-09-30T00:00:00Z' };

test('review-field-edit url: a non-review page url is replaced by the real review url', () => {
  const rec = { outletId: 'nytg', criticName: 'Unknown', url: NYTG_SHOW, wrongShow: true };
  const res = applyReviewFieldEdit(rec, { field: 'url', oldValue: NYTG_SHOW, newValue: NYTG_REVIEW }, STAMP);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.url, NYTG_REVIEW);
  assert.equal(res.record.needsRefetch, true);
  assert.equal(res.record.urlCorrectedFrom, NYTG_SHOW);
});

test('review-field-edit url: an aggregator url clears to "" (Theatre Record shape)', () => {
  const rec = { outletId: 'financialtimes', criticName: 'Sarah Hemming', url: WET_ROUNDUP };
  const res = applyReviewFieldEdit(rec, { field: 'url', oldValue: WET_ROUNDUP, newValue: '' }, STAMP);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.url, '');
  assert.equal(res.record.needsRefetch, undefined, 'no refetch: the text did not come from a url');
});

test("review-field-edit url: another critic's url is repairable only with the executor's sibling proof", () => {
  const rec = { outletId: 'nysr', criticName: 'David Finkle', url: NYSR_SCHECK };
  const action = { field: 'url', oldValue: NYSR_SCHECK, newValue: NYSR_FINKLE };
  assert.equal(applyReviewFieldEdit(rec, action, STAMP).ok, false);
  assert.equal(applyReviewFieldEdit(rec, action, STAMP, { currentUrlOwnedByOtherCritic: true }).ok, true);
});

test('review-field-edit url: refuses to replace a real url, to write a bad url, or to cross outlets', () => {
  const real = { outletId: 'nysr', criticName: 'David Finkle', url: NYSR_FINKLE };
  assert.equal(applyReviewFieldEdit(real, { field: 'url', oldValue: NYSR_FINKLE, newValue: NYSR_SCHECK }, STAMP).ok, false);
  const page = { outletId: 'nytg', criticName: 'Unknown', url: NYTG_SHOW };
  assert.equal(applyReviewFieldEdit(page, { field: 'url', oldValue: NYTG_SHOW, newValue: WET_ROUNDUP }, STAMP).ok, false);
  assert.equal(applyReviewFieldEdit(page, { field: 'url', oldValue: NYTG_SHOW, newValue: '' }, STAMP).ok, false);
  assert.equal(applyReviewFieldEdit(page, { field: 'url', oldValue: NYTG_SHOW, newValue: TM_REVIEW }, STAMP).ok, false);
});

test('an approved url repair back to a prior url is not blocked as a flip-flop', () => {
  const { safeWriteReview } = require('./review-write-guard.js');
  const disk = {
    showId: 'an-american-daughter-off-broadway-2026', outletId: 'nysr', criticName: 'David Finkle', url: NYSR_SCHECK,
    _urlChangedClear: { from: NYSR_FINKLE, to: NYSR_SCHECK, at: '2026-09-07T10:01:57Z', cleared: [] },
  };
  const dir = tmpShowDir({ 'nysr--david-finkle.json': disk });
  const fp = path.join(dir, 'nysr--david-finkle.json');
  // A poller swap-back is still refused and pinned (BRO-121)...
  safeWriteReview(fp, { ...disk, url: NYSR_FINKLE });
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).url, NYSR_SCHECK);
  // ...but the owner-approved repair lands.
  fs.writeFileSync(fp, JSON.stringify(disk));
  safeWriteReview(fp, { ...disk, url: NYSR_FINKLE }, { approvedUrlRepair: true });
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).url, NYSR_FINKLE);
});

test('unexpectedChanges tolerates exactly the url-change-invariant side effects of a url edit', () => {
  const before = { url: NYTG_SHOW, wrongShow: true, fullText: 'old', note: 'keep' };
  const after = {
    url: NYTG_REVIEW, fullText: null, note: 'keep', needsRefetch: true, urlCorrectedFrom: NYTG_SHOW,
    _urlChangedClear: { from: NYTG_SHOW, to: NYTG_REVIEW, cleared: ['wrongShow', 'fullText'] },
  };
  assert.deepEqual(unexpectedChanges(before, after, 'url'), []);
  assert.deepEqual(unexpectedChanges(before, { ...after, note: 'changed' }, 'url'), ['note']);
  // Other fields keep the strict comparison.
  assert.deepEqual(unexpectedChanges({ a: 1 }, { a: 1, needsRefetch: true }, 'criticName'), ['needsRefetch']);
});

test('a TheaterMania cast announcement is a named non-review url; its reviews are not', () => {
  const { namedNonReviewReason } = require('./non-review-url-patterns.js');
  assert.equal(namedNonReviewReason(TM_CAST), 'cast-announcement');
  assert.equal(namedNonReviewReason(TM_REVIEW), null);
});

test('the scorer scores the chrome-stripped text the selection chose', () => {
  const { strippedFullTextSelection } = require('./scorable-text.js');
  const data = { showId: 'da-1978', fullText: DA_REVIEW + DA_CHROME };
  const sel = selectScorableText(data, { showTitle: 'Da' });
  assert.equal(strippedFullTextSelection(data, sel.text), sel.text);
  // Raw text selected, or an excerpt: no override.
  assert.equal(strippedFullTextSelection({ fullText: TRU_REVIEW }, TRU_REVIEW), null);
  assert.equal(strippedFullTextSelection({ fullText: TRU_REVIEW }, 'an unrelated excerpt'), null);
});
