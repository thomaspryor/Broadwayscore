// Listing pages scored as reviews (2026 data audit, S1-T0).
//
// Four listing-page URL shapes were live-scored as reviews: Talkin' Broadway's
// review index (/page/world/index.html, on 3 shows), London Theatre Hub
// /shows/<slug>/ show pages ("Editorial Team" byline), a WhatsOnStage
// /shows/... show page (WOS reviews live under /reviews/) and a BWW
// /shows/<Title>-<id>.html show page (BWW reviews live under /article/).
// review-guards.js's explainExclusion() now returns 'listingPageUrl' for them
// via non-review-url-patterns.js's listingPageUrlReason(), which is
// HOST-SPECIFIC because didtheylikeit.com/shows/<show>/<review-slug>/ and
// broadwaybaby.com/shows/<slug>/<id> are real reviews under a /shows/ path.
//
// Per CLAUDE.md §15 this requires the REAL helper and the REAL rule chain —
// never a copy — and then asserts the chain is actually wired: a passing
// helper proves nothing if explainExclusion never calls it, or calls it after
// a rule that would have claimed the file first.
//
// Run: node --test tests/unit/listing-page-url.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { listingPageUrlReason } = require(join(ROOT, 'scripts/lib/non-review-url-patterns.js'));
const { explainExclusion, isIncludableForRebuild } = require(join(ROOT, 'scripts/lib/review-guards.js'));
const { PROTECTED_FIELDS } = require(join(ROOT, 'scripts/lib/review-write-guard.js'));

// The listing URLs found live-scored (reviews.json scan, 2026-09-28).
const LISTING_URLS = {
  'talkinbroadway review index': 'https://www.talkinbroadway.com/page/world/index.html',
  'londontheatrehub show page (equus)': 'https://londontheatrehub.co.uk/shows/equus/',
  'londontheatrehub show page (heathers)': 'https://londontheatrehub.co.uk/shows/heathers-the-musical/',
  'whatsonstage show page': 'https://www.whatsonstage.com/shows/london-theatre/west-end-theatre/war-horse_1712421/',
  'broadwayworld show page': 'https://www.broadwayworld.com/shows/Grangeville-334944.html',
};
// Real review URLs that also sit under /shows/ — the guard must be host-specific.
const REVIEW_URLS_UNDER_SHOWS = {
  'didtheylikeit review': 'https://didtheylikeit.com/shows/hamlet/new-york-times-review/',
  'broadwaybaby review': 'https://www.broadwaybaby.com/shows/hamlet/78901',
};
// The same hosts' real article shapes.
const REVIEW_URLS_SAME_HOSTS = [
  'https://www.whatsonstage.com/reviews/war-horse-review_1712500/',
  'https://www.broadwayworld.com/article/Review-GRANGEVILLE-Signature-Theatre-20260301',
  'https://www.talkinbroadway.com/page/world/celebrityautobiography.html',
];

const FULL_TEXT = 'A thoughtful, substantial review of the production that runs on for a while. '.repeat(30);
assert.ok(FULL_TEXT.length >= 2000, 'fixture text must be at least 2000 chars');

const SHOW = {
  id: 'war-horse-west-end-2026', title: 'War Horse', category: 'west-end', status: 'open',
  previewsStartDate: '2026-02-20', openingDate: '2026-03-05',
};

function fixture(url, extra = {}) {
  return { url, criticName: 'Some Critic', fullText: FULL_TEXT, publishDate: '2026-03-06T12:00:00Z', ...extra };
}

test('listingPageUrlReason names every live listing shape with a short reason', () => {
  for (const [label, url] of Object.entries(LISTING_URLS)) {
    const reason = listingPageUrlReason(url);
    assert.equal(typeof reason, 'string', `${label}: ${url}`);
    assert.ok(reason.length > 0 && reason.length < 40, `${label}: reason should be a short label, got ${JSON.stringify(reason)}`);
  }
  // The other host-specific shapes named in the rule, plus a bare host.
  assert.ok(listingPageUrlReason('https://www.theatermania.com/shows/new-york-city/hamlet_123/'));
  assert.ok(listingPageUrlReason('https://www.show-score.com/broadway-shows/hamlet'));
  assert.ok(listingPageUrlReason('https://www.show-score.com/off-broadway-shows/hamlet'));
  assert.ok(listingPageUrlReason('https://www.show-score.com/shows/hamlet'));
  assert.equal(listingPageUrlReason('https://deadline.com/'), 'bare-host');
  assert.equal(listingPageUrlReason('https://deadline.com'), 'bare-host');
});

test('listingPageUrlReason is host-specific: real reviews under /shows/ and the same hosts\' article paths are null', () => {
  for (const [label, url] of Object.entries(REVIEW_URLS_UNDER_SHOWS)) {
    assert.equal(listingPageUrlReason(url), null, `${label}: ${url}`);
  }
  for (const url of REVIEW_URLS_SAME_HOSTS) assert.equal(listingPageUrlReason(url), null, url);
  assert.equal(listingPageUrlReason('https://www.theatermania.com/news/review-hamlet_98765/'), null);
});

test('listingPageUrlReason: www-stripped and case-insensitive; WordPress ?p= permalinks are not bare hosts; unparsable input is null', () => {
  assert.ok(listingPageUrlReason('HTTPS://WWW.WhatsOnStage.com/SHOWS/london-theatre/x_1/'));
  assert.ok(listingPageUrlReason('https://WWW.TALKINBROADWAY.COM/page/world/INDEX.HTML'));
  // Critics' own WordPress sites publish reviews at "/?p=<id>" — a "/" path
  // with a query string is an article, not a homepage (three are live-scored).
  assert.equal(listingPageUrlReason('https://www.susangranger.com/?p=10339'), null);
  assert.equal(listingPageUrlReason('https://www.starwatchbyline.com/?p=15756'), null);
  assert.equal(listingPageUrlReason('not a url'), null);
  assert.equal(listingPageUrlReason(''), null);
  assert.equal(listingPageUrlReason(null), null);
  assert.equal(listingPageUrlReason(undefined), null);
  assert.equal(listingPageUrlReason(42), null);
});

test('a clean fixture (real article URL, 2000+ chars of text, open show) is includable — so the verdicts below are attributable to the URL alone', () => {
  for (const url of REVIEW_URLS_SAME_HOSTS) {
    assert.equal(explainExclusion(fixture(url), SHOW, undefined), null, url);
  }
});

test('explainExclusion returns listingPageUrl for every live listing URL', () => {
  for (const [label, url] of Object.entries(LISTING_URLS)) {
    const data = fixture(url);
    assert.equal(explainExclusion(data, SHOW, undefined), 'listingPageUrl', `${label}: ${url}`);
    assert.equal(isIncludableForRebuild(data, SHOW, undefined), false, `${label} must not be includable`);
  }
});

test('explainExclusion never names listingPageUrl for the DTLI / Broadway Baby review URLs', () => {
  for (const [label, url] of Object.entries(REVIEW_URLS_UNDER_SHOWS)) {
    assert.notEqual(explainExclusion(fixture(url), SHOW, undefined), 'listingPageUrl', `${label}: ${url}`);
  }
});

test('listingPageUrlManualClear: true bypasses the rule, and the breadcrumb is PROTECTED so a push-time restore cannot drop it', () => {
  for (const [label, url] of Object.entries(LISTING_URLS)) {
    const data = fixture(url, { listingPageUrlManualClear: true });
    assert.notEqual(explainExclusion(data, SHOW, undefined), 'listingPageUrl', `${label}: ${url}`);
    assert.equal(explainExclusion(data, SHOW, undefined), null, `${label}: nothing else should claim a manually-cleared clean fixture`);
  }
  // Only a literal true clears it.
  assert.equal(explainExclusion(fixture(LISTING_URLS['whatsonstage show page'], { listingPageUrlManualClear: 'yes' }), SHOW, undefined), 'listingPageUrl');
  assert.ok(PROTECTED_FIELDS.includes('listingPageUrlManualClear'), 'review-write-guard.js PROTECTED_FIELDS must carry the escape hatch');
});

test('isNotReview: true (the hand-set, PROTECTED "not a review" field) still returns nonReview when a fresh high-confidence contentVerification says review — unlike the classifier flag isNonReview, which that CV demotes', () => {
  const url = REVIEW_URLS_SAME_HOSTS[0];
  const cv = { articleType: 'review', isValid: true, confidence: 'high', verifiedAt: '2026-09-20T00:00:00.000Z' };
  const handSet = fixture(url, {
    isNotReview: true, isNotReviewReason: 'listing page, verified by hand', isNotReviewSetAt: '2026-09-01T00:00:00.000Z',
    classifiedAt: '2026-09-01T00:00:00.000Z', contentVerification: cv,
  });
  assert.equal(explainExclusion(handSet, SHOW, undefined), 'nonReview');
  assert.ok(PROTECTED_FIELDS.includes('isNotReview') && PROTECTED_FIELDS.includes('isNotReviewManualClear'));

  const classifierSet = fixture(url, {
    isNonReview: true, isNonReviewReason: 'gemini: listing page', classifiedAt: '2026-09-01T00:00:00.000Z', contentVerification: cv,
  });
  assert.notEqual(explainExclusion(classifierSet, SHOW, undefined), 'nonReview', 'a CV newer than classifiedAt demotes the classifier flag');
});

test('review-guards.js is wired: explainExclusion calls listingPageUrlReason after blockedReviewUrl and before the namedNonReviewUrl check, with the escape hatch', () => {
  const src = readFileSync(join(ROOT, 'scripts/lib/review-guards.js'), 'utf8');
  const fnStart = src.indexOf('function explainExclusion(');
  assert.ok(fnStart > 0, 'explainExclusion must exist');
  const blocked = src.indexOf("return 'blockedReviewUrl'", fnStart);
  const listingCall = src.indexOf("require('./non-review-url-patterns').listingPageUrlReason(data.url)", fnStart);
  const listingReturn = src.indexOf("return 'listingPageUrl'", fnStart);
  const named = src.indexOf("return 'namedNonReviewUrl'", fnStart);
  assert.ok(blocked > fnStart, 'blockedReviewUrl check must exist');
  assert.ok(listingCall > blocked, 'listingPageUrlReason must be called after the blockedReviewUrl check');
  assert.ok(listingReturn > listingCall && listingReturn < named, "return 'listingPageUrl' must sit between the call and the namedNonReviewUrl check");
  assert.ok(named > listingReturn, 'namedNonReviewUrl check must come after');
  const hatch = src.indexOf('data.listingPageUrlManualClear !== true', fnStart);
  assert.ok(hatch > blocked && hatch < listingReturn, 'the escape hatch must guard the listingPageUrl return');
});

test('BRO-4956: a path ending in a reviews/press hub segment is a hub on any host', () => {
  for (const u of [
    'https://www.timcrouchtheatre.co.uk/shows-2/an-oak-tree/reviews',
    'https://letterboxd.com/film/shakespeares-globe-as-you-like-it/reviews/',
    'https://www.theaterinthenow.com/search/label/Review',
    'https://www.example-producer.com/shows/x/press-quotes',
  ]) assert.ok(listingPageUrlReason(u), u);
  for (const u of [
    'https://www.thestage.co.uk/reviews/an-oak-tree-review-the-other-palace-tim-crouch-gwyneth-keyworth',
    'https://www.newyorkcitytheatre.com/reviews/1234',
    'https://www.timeout.com/london/theatre/an-oak-tree-review',
    'https://www.londontheatre1.com/reviews/rent-at-tom-stoppard-theatre-review/',
    'https://example.com/review',
  ]) assert.equal(listingPageUrlReason(u), null, u);
});
