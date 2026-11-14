import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSoft404Body, findDuplicateBodies } = require('../../scripts/lib/soft-404-body.js');
const { isPermanentlyFailed, isNonEvidenceFailure } = require('../../scripts/lib/failed-fetch-policy.js');
const { shouldRetryFetch, recordFetchAttempt } = require('../../scripts/lib/review-guards.js');

// The London Box Office soft-404 chrome from BRO-3116 (jane-eyre-off-west-end-2026).
const LBO_BODY =
  'Home Theatre News Document not found The document you are looking for does not exist. ' +
  'Search News & Reviews Latest News 08 Sep Reviews Review: CRYBABIES ' + 'Theatre News Reviews Features '.repeat(24);

const REAL_SHORT_REVIEW =
  'Jane Eyre at Southwark Playhouse Elephant is a bold, stripped back retelling. The cast is superb, ' +
  'the staging inventive, and the evening moves briskly. Four stars.';

test('soft-404 chrome is detected', () => {
  assert.equal(isSoft404Body(LBO_BODY), true);
  assert.equal(isSoft404Body('Page not found. Sorry, we could not find that page. Home Search Contact'), true);
  // McClatchy template (the-nance-2013 AP shipped it as a pull quote, 2026-10-19)
  assert.equal(isSoft404Body('404 | Tacoma News Tribune Log In | Subscribe Unfortunately, we are unable to locate the page you requested. Please check the web address you entered and try again.'), true);
});

test('a genuine short review is not flagged', () => {
  assert.equal(isSoft404Body(REAL_SHORT_REVIEW), false);
  assert.equal(isSoft404Body(''), false);
  assert.equal(isSoft404Body(null), false);
});

test('a long article quoting "page not found" is not flagged', () => {
  assert.equal(isSoft404Body('A great show. '.repeat(400) + ' page not found'), false);
});

test('byte-identical bodies across critics are grouped', () => {
  const groups = findDuplicateBodies([
    { file: 'a.json', fullText: LBO_BODY, url: 'https://x/a' },
    { file: 'b.json', fullText: LBO_BODY, url: 'https://x/b' },
    { file: 'd.json', fullText: LBO_BODY.replace('Home', 'Joint'), url: 'https://x/j' },
    { file: 'e.json', fullText: LBO_BODY.replace('Home', 'Joint'), url: 'https://x/j' },
    { file: 'c.json', fullText: REAL_SHORT_REVIEW + ' '.repeat(1) + 'x'.repeat(200) },
  ]);
  assert.deepEqual(groups, [['a.json', 'b.json']]);
});

test('soft_404 is never retired and only cools down', () => {
  assert.equal(isNonEvidenceFailure('soft_404'), true);
  assert.equal(isPermanentlyFailed({ failureReason: 'soft_404', failureCount: 99 }), false);
  const upd = recordFetchAttempt(null, {}, { failureReason: 'soft_404', failureCount: 99 });
  assert.ok(upd.fetchRetryAfter);
  assert.equal(upd.fetchDiscoveryAbandoned, undefined);
  const gate = shouldRetryFetch(null, { fetchRetryAfter: upd.fetchRetryAfter }, { failureReason: 'soft_404', failureCount: 99 });
  assert.equal(gate.shouldRetry, false);
  assert.equal(gate.reason, 'cooldown');
  const later = shouldRetryFetch(null, { fetchRetryAfter: new Date(Date.now() - 1000).toISOString() }, { failureReason: 'soft_404' });
  assert.equal(later.shouldRetry, true);
});

test('short real text containing a weak signature is not flagged', () => {
  assert.equal(isSoft404Body('Review: Error 404 at the Bush Theatre. The 404 error message becomes a motif. Four stars.'), false);
  assert.equal(isSoft404Body('Sorry, page not found? Not here: this short capsule review loves the show.'), false);
  assert.equal(isSoft404Body('Page not found. Home Search Menu Subscribe'), true);
});

// BRO-7171 corpus scan 2026-11-10: real saved bodies the rules missed (26 files),
// each then judged as a review (13 USA Today reviews dropped as "news").
// Openings copied from the files; padded with nav chrome to their real length.
const NAV = ' Home News Sports Entertainment Subscribe Sign in Search Menu Privacy Contact Latest News'.repeat(22);
const SAVED_ERROR_PAGES = {
  usatoday: "Page Not Found (404) | USA TODAY America's birthday 8-week series Discover PLAY Check home prices U.S. Politics Sports Entertainment Life Money Travel Opinion Crossword" + NAV, // guys-and-dolls-2009/usatoday--elysa-gardner.json
  newsday: 'The page you requested is not available. The page you are looking for might have been removed, had its name changed, or is temporarily unavailable. Please try the following:',
  seattletimes: 'The page you were looking for couldn’t be found, or may have been moved. Be sure to check your spelling in the address field in your browser.',
  inews: "Page Not Found We are sorry to say that you have found our 'sorry' page while visiting inews You may be attempting to get to a page that doesn't exist",
  dispatch: "404 PAGE NOT FOUND Sorry, the link you're trying to access is either broken or no longer exists. Please use the search bar or take a look at some of our trending stories below." + NAV.slice(0, 900),
  offoffonline: "We couldn't find the page you were looking for. This is either because: There is an error in the URL entered into your web browser.",
  victoriaadvocate: 'Page Not Found | The Victoria Advocate You are using an outdated browser. Please upgrade your browser or activate Google Chrome Frame to improve your experience. Log out Log in Register' + NAV,
  culturesauce: "Error 404 Oops! That page can't be found. It looks like nothing was found at this location. Maybe try one of the links below or a search?" + NAV,
  nytg: "404 Admit one Seat not found · row 404 Curtain's down on this page We couldn't find what you were after — but Broadway and Off-Broadway are still very much open.",
  nydailynews: 'Page not found &#8211; New York Daily News Skip to content All Sections Subscribe Now 46&deg;F Monday, April 27th 2026 Daily News e-Edition' + NAV,
};

test('saved error pages from the BRO-7171 corpus scan are detected', () => {
  for (const [site, body] of Object.entries(SAVED_ERROR_PAGES)) {
    assert.ok(body.length <= 2500, `${site} fixture within the detector's length cap`);
    assert.equal(isSoft404Body(body), true, site);
  }
});

test('real reviews that mention a missing page or open on "Page" are not flagged', () => {
  assert.equal(isSoft404Body('Page Not Found, the new comedy at the Public, is a sharp satire of internet life. The cast is terrific and the ending lands.'), false);
  assert.equal(isSoft404Body('The heroine discovers that the page you requested is gone from the ledger, and so begins a thriller. ' + 'A taut evening. '.repeat(100)), false);
});

test('soft_404 cooldown backs off by repeat count', () => {
  const a = recordFetchAttempt(null, { fetchSoft404Count: 0 }, { failureReason: 'soft_404' });
  const b = recordFetchAttempt(null, { fetchSoft404Count: 3 }, { failureReason: 'soft_404' });
  assert.equal(a.fetchSoft404Count, 1);
  assert.ok(new Date(b.fetchRetryAfter) - new Date(a.fetchRetryAfter) > 100 * 3600 * 1000);
});
