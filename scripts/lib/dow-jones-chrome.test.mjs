/**
 * BRO-5198: Dow Jones page chrome stored ahead of WSJ reviews.
 *
 * 2026-10-12: 26 broadway-review-texts files (WSJ Teachout, 2009-2012
 * archive.org captures) held the WSJ registration interstitial + nav rail as
 * the first ~2KB of fullText, and 167 more held the nav rail or the print
 * header. The weekly refresh wrote the same shape into the Addams Family WSJ
 * file; the splitter (correctly) made it a split parent of a combined column,
 * and the same-show branch of validate-added-review-ownership.js then read the
 * named copy as dead and let the unknown-byline duplicate back in (main red,
 * scripts/verify-addams-wsj-dedup-held.test.mjs).
 *
 * Review bodies here are synthetic; the chrome is verbatim WSJ page furniture.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cq = require('./content-quality.js');
const { safeWriteReview, isIntentionalClear } = require('./review-write-guard.js');
const { reconcileProtectedFields } = require('./restore-protected-fields.js');
const { _isLiveSameShowCopy, _resetUrlOwnershipIndex } = require('./url-ownership.js');
const { decideOwnershipDrops } = require('../validate-added-review-ownership.js');

const NAV = ['World', 'Europe', 'U.K.', 'U.S.', 'Business', 'Markets', 'Tech', 'Opinion']
  .map((s) => `${s}\n \n » More\n\n${s}\n » More`).join('\n\n');

const INTERSTITIAL = `WSJ.com is available in the following editions and languages:

Please click on the link inside the email to complete your registration

Please register to gain free access to WSJ tools.

An account already exists for the email address entered.

Forgot your username or password?

Privacy Policy | Terms & Conditions

As a registered user of The Wall Street Journal Online, you will be able to:

Setup and manage your portfolio

${NAV}

Dow Jones Reprints: This copy is for your personal, non-commercial use only. To order presentation-ready copies for distribution to your colleagues, clients or customers, use the Order Reprints tool at the bottom of any article or visit
www.djreprints.com

`;

const PRINT_HEADER = 'This copy is for your personal, non-commercial use only. Distribution and use of this material are governed by our Subscriber Agreement and by copyright law. For non-personal use or to order multiple copies, please contact Dow Jones Reprints at 1-800-843-0008 or visit www.djreprints.com. https://www.wsj.com/articles/example-review-11600000000\n\n';

const FLATTENED = 'Example Review - WSJ Skip to Main Content Explore Our Brands WSJ Barron\'s MarketWatch English Edition Print Edition Video Audio Latest Headlines World Business U.S. Opinion Arts Lifestyle Advertisement ' + PRINT_HEADER.replace(/\n/g, ' ');

const REVIEW = [
  'The star of this revival is the actress playing the long-suffering wife, whose performance in the second act is something else again.',
  'The director keeps the stage spare and the play moves briskly; the cast is uniformly fine, and the production earns its place on Broadway.',
  'The playwright wrote it in the early 1980s, and the theater has rarely seen a script that steers so clear of self-conscious speechifying.',
  'When you walk out of the theater, you will be so wrapped up in this world that it takes a long time to find your way back into your own.',
].join('\n\n').repeat(3);

describe('detector + stripper', () => {
  test('detector flags the WSJ registration interstitial', () => {
    const d = cq.detectWsjRegistrationInterstitial(INTERSTITIAL);
    assert.equal(d.detected, true);
    // markdown-link capture of the same banner (as quoted in the issue)
    assert.equal(cq.detectWsjRegistrationInterstitial('[WSJ.com](http://WSJ.com) is available in the following editions and languages:').detected, true);
    assert.equal(cq.detectWsjRegistrationInterstitial(REVIEW).detected, false);
  });

  test('interstitial with no review behind it is garbage', () => {
    const g = cq.isGarbageContent(INTERSTITIAL);
    assert.equal(g.isGarbage, true, g.reason);
    assert.match(g.reason, /WSJ registration interstitial/);
    // the interstitial page captured without the reprints marker
    const noMarker = INTERSTITIAL.split('Dow Jones Reprints')[0];
    assert.equal(cq.isGarbageContent(noMarker).isGarbage, true);
    // no marker = no known boundary: nothing is cut (a review could follow)
    assert.equal(cq.stripDowJonesReprintChrome(noMarker), noMarker);
    assert.equal(cq.stripDowJonesReprintChrome(noMarker + REVIEW), noMarker + REVIEW);
  });

  test('interstitial + nav + review: chrome cut, review kept, not garbage', () => {
    const out = cq.stripDowJonesReprintChrome(INTERSTITIAL + REVIEW);
    assert.equal(out, REVIEW.trim());
    assert.equal(cq.isGarbageContent(INTERSTITIAL + REVIEW).isGarbage, false);
  });

  test('print header (with trailing article url) is cut', () => {
    assert.equal(cq.stripDowJonesReprintChrome(PRINT_HEADER + REVIEW), REVIEW.trim());
  });

  test('flattened single-line wsj.com header is cut', () => {
    assert.equal(cq.stripDowJonesReprintChrome(FLATTENED + REVIEW), REVIEW.trim());
  });

  test('a reprints FOOTER after the review never cuts the review', () => {
    const t = REVIEW + '\n\n' + PRINT_HEADER;
    assert.equal(cq.stripDowJonesReprintChrome(t), t);
  });

  test('a short review + reprints footer is never erased', () => {
    const t = 'A tight, funny, beautifully acted revival. Go.\n\n' + PRINT_HEADER;
    assert.equal(cq.stripDowJonesReprintChrome(t), t);
  });

  test('toolbar chrome + short review + reprints FOOTER: review kept (old wsj.com layout)', () => {
    const shortReview = REVIEW.split('\n\n').slice(0, 3).join('\n\n');
    const t = 'Skip to Main Content Order Reprints World Business Opinion\n\n' + shortReview + '\n\n' + PRINT_HEADER;
    assert.equal(cq.stripDowJonesReprintChrome(t), t);
    const nav = NAV + '\n\n' + shortReview + '\n\n' + PRINT_HEADER + 'Most Popular';
    assert.equal(cq.stripDowJonesReprintChrome(nav), nav);
    assert.equal(cq.isGarbageContent(nav).isGarbage, false);
  });

  test('prose before the marker is not treated as chrome', () => {
    const t = REVIEW.slice(0, 600).replace(/\n/g, ' ') + '\n\n' + PRINT_HEADER + REVIEW;
    assert.equal(cq.stripDowJonesReprintChrome(t), t);
  });

  test('plain text and non-strings pass through', () => {
    assert.equal(cq.stripDowJonesReprintChrome(REVIEW), REVIEW);
    assert.equal(cq.stripDowJonesReprintChrome(''), '');
    assert.equal(cq.stripDowJonesReprintChrome(null), null);
  });

  test('stripExemptedChrome (collect-review-texts fetch path) cuts it', () => {
    assert.equal(cq.stripExemptedChrome(INTERSTITIAL + REVIEW), REVIEW.trim());
  });

  test('classifyContentTier: interstitial-only fullText is never complete', () => {
    const r = cq.classifyContentTier({ fullText: INTERSTITIAL, bwwExcerpt: REVIEW.slice(0, 300) });
    assert.notEqual(r.contentTier, 'complete');
  });
});

describe('safeWriteReview backstop', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-chrome-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('cuts the chrome, follows word counts, stamps the trim breadcrumb', () => {
    const fp = path.join(tmp, 'zz-test-show-2010', 'wsj--critic.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const chromed = INTERSTITIAL + REVIEW;
    const committed = { showId: 'zz-test-show-2010', outletId: 'wsj', criticName: 'Critic', url: 'https://online.wsj.com/article/x.html', fullText: chromed, wordCount: 999, textWordCount: 999 };
    fs.writeFileSync(fp, JSON.stringify(committed));
    const res = safeWriteReview(fp, { ...committed }, { force: true });
    assert.equal(res.wrote, true, JSON.stringify(res));
    const stored = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(stored.fullText, REVIEW.trim());
    assert.equal(stored.wordCount, REVIEW.trim().split(/\s+/).length);
    assert.equal(stored.fullTextTrimmed.fromLength, chromed.length);
    // The push restore must not put the chrome-bearing text back.
    assert.equal(isIntentionalClear('fullText', stored, committed), true);
    const local = JSON.parse(JSON.stringify(stored));
    reconcileProtectedFields(local, committed, committed, { staleCheckoutGuard: true });
    assert.equal(local.fullText, REVIEW.trim());
  });

  test('interstitial-only incoming text keeps the record\'s existing fullText', () => {
    const fp = path.join(tmp, 'zz-test-show-2010', 'wsj--critic.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const rec = { showId: 'zz-test-show-2010', url: 'https://online.wsj.com/article/x.html', fullText: '' };
    fs.writeFileSync(fp, JSON.stringify(rec));
    safeWriteReview(fp, { ...rec, fullText: INTERSTITIAL.split('Dow Jones Reprints')[0] }, { force: true });
    assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).fullText, '');
  });
});

describe('same-show ownership: combined/split-parent named copy is live', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-own-')); _resetUrlOwnershipIndex(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); _resetUrlOwnershipIndex(); });

  const URL = 'https://online.wsj.com/article/SB10001424052702303411604575168152141751426.html';
  const SHOW = 'the-addams-family-2010';
  const named = {
    showId: SHOW, outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'Terry Teachout', url: URL,
    fullText: REVIEW, contentTier: 'complete', assignedScore: 60,
    isCombinedReview: true, multiShowSplitParent: true, combinedWith: ['lend-me-a-tenor-2010'],
  };

  test('_isLiveSameShowCopy: combined includable copy live; combined+wrongShow not', () => {
    assert.equal(_isLiveSameShowCopy(named, SHOW, `/x/${SHOW}/wsj--terry-teachout.json`), true);
    assert.equal(_isLiveSameShowCopy({ ...named, wrongShow: true }, SHOW, 'x'), false);
    assert.equal(_isLiveSameShowCopy({ ...named, isRoundupArticle: true }, SHOW, 'x'), false);
  });

  test('decideOwnershipDrops drops the re-created unknown-byline duplicate (Addams replay)', () => {
    fs.mkdirSync(path.join(tmp, SHOW), { recursive: true });
    fs.writeFileSync(path.join(tmp, SHOW, 'wsj--terry-teachout.json'), JSON.stringify(named));
    fs.writeFileSync(path.join(tmp, SHOW, 'wsj--unknown.json'), JSON.stringify({ showId: SHOW, outletId: 'wsj', criticName: 'Unknown', url: URL.replace('https', 'http'), fullText: '' }));
    const drops = decideOwnershipDrops([`${SHOW}/wsj--unknown.json`], tmp);
    assert.equal(drops.length, 1, JSON.stringify(drops));
    assert.equal(drops[0].kind, 'same-show');
  });
});

describe('chrome cut persists as a record-level signal', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-sig-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('an already-clean re-fetch of a chrome-bearing record gets the breadcrumb', () => {
    const fp = path.join(tmp, 'zz-test-show-2010', 'wsj--critic.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const committed = { showId: 'zz-test-show-2010', url: 'https://online.wsj.com/article/x.html', fullText: PRINT_HEADER + REVIEW };
    fs.writeFileSync(fp, JSON.stringify(committed));
    safeWriteReview(fp, { ...committed, fullText: REVIEW.trim() }, { force: true });
    const stored = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(stored.fullTextTrimmed.reason, cq.DOW_JONES_TRIM_REASON);
    assert.equal(isIntentionalClear('fullText', stored, committed), true);
  });

  test('a different article replacing a chrome-bearing record gets no breadcrumb', () => {
    const fp = path.join(tmp, 'zz-test-show-2010', 'wsj--critic.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const committed = { showId: 'zz-test-show-2010', url: 'https://online.wsj.com/article/x.html', fullText: PRINT_HEADER + REVIEW };
    fs.writeFileSync(fp, JSON.stringify(committed));
    safeWriteReview(fp, { ...committed, fullText: 'An entirely different piece about another play. '.repeat(30) }, { force: true });
    assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).fullTextTrimmed, undefined);
  });

  test('classifyContentTier keeps the full-capture signal after the chrome is gone', () => {
    // ~200-word terse capsule: Path 1 needs 300 words, Path 3 needs opinion
    // keywords OR a trusted full-page capture.
    const capsule = 'Cort Theatre, 138 W. 48th St. The musical tells its tale across two decades in the mountains of North Carolina. '
      + 'The book is trite, the dialogue stiff and the songs forgettable, and the cast works hard to little effect in a staging that plods. '.repeat(7)
      + 'If the star name were not on the marquee, it would not have gotten anywhere near Broadway.';
    const base = { fullText: capsule, outletId: 'wsj' };
    const withChrome = cq.classifyContentTier({ ...base, fullText: PRINT_HEADER + capsule });
    const cleaned = cq.classifyContentTier({ ...base, fullTextTrimmed: { reason: cq.DOW_JONES_TRIM_REASON, fromLength: 1, toLength: capsule.length } });
    // a later, different body does not inherit the signal
    const replaced = cq.classifyContentTier({ ...base, fullText: capsule + ' More.', fullTextTrimmed: { reason: cq.DOW_JONES_TRIM_REASON, fromLength: 1, toLength: capsule.length } });
    assert.notEqual(replaced.contentTier, 'complete');
    const neither = cq.classifyContentTier(base);
    assert.equal(withChrome.contentTier, cleaned.contentTier);
    assert.equal(cleaned.contentTier, 'complete', cleaned.tierReason);
    assert.notEqual(neither.contentTier, 'complete', 'fixture must actually depend on the signal');
  });
});

describe('codex review hardening', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-hard-')); _resetUrlOwnershipIndex(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); _resetUrlOwnershipIndex(); });

  test('a truncated re-fetch of a chrome-bearing record gets no breadcrumb', () => {
    const fp = path.join(tmp, 'zz-test-show-2010', 'wsj--critic.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const committed = { showId: 'zz-test-show-2010', url: 'https://online.wsj.com/article/x.html', fullText: PRINT_HEADER + REVIEW };
    fs.writeFileSync(fp, JSON.stringify(committed));
    safeWriteReview(fp, { ...committed, fullText: REVIEW.slice(0, 700) }, { force: true });
    const stored = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(stored.fullTextTrimmed, undefined);
    assert.equal(isIntentionalClear('fullText', stored, committed), false);
  });

  test('a stale breadcrumb does not block restoring text after a later fetch replaced the body', () => {
    const local = { fullText: 'short later fetch', fullTextTrimmed: { reason: cq.DOW_JONES_TRIM_REASON, fromLength: 5000, toLength: 4000 } };
    const committed = { fullText: 'x'.repeat(5000) };
    assert.equal(isIntentionalClear('fullText', local, committed), false);
  });

  test('interstitial with no marker is not stored over existing text', () => {
    const fp = path.join(tmp, 'zz-test-show-2010', 'wsj--critic.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const rec = { showId: 'zz-test-show-2010', url: 'https://online.wsj.com/article/x.html', fullText: REVIEW };
    fs.writeFileSync(fp, JSON.stringify(rec));
    safeWriteReview(fp, { ...rec, fullText: INTERSTITIAL.split('Dow Jones Reprints')[0] + REVIEW }, { force: true });
    assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).fullText, REVIEW);
  });

  test('_isLiveSameShowCopy fails closed when the show is unknown', () => {
    assert.equal(_isLiveSameShowCopy({ criticName: 'X', isCombinedReview: true, fullText: REVIEW }, 'zz-no-such-show-1900', 'x'), false);
  });

  test('a human-locked record is left alone by the backstop', () => {
    const fp = path.join(tmp, 'zz-test-show-2010', 'wsj--critic.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const rec = { showId: 'zz-test-show-2010', url: 'https://online.wsj.com/article/x.html', fullText: PRINT_HEADER + REVIEW, wordCount: 7, _locked: true };
    fs.writeFileSync(fp, JSON.stringify(rec));
    safeWriteReview(fp, { ...rec }, { force: true });
    const stored = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.equal(stored.fullTextTrimmed, undefined);
    assert.equal(stored.wordCount, 7);
  });
});
