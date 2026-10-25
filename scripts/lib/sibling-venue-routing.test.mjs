// BRO-5386: The Stage's RSC review of As You Like It (Stratford, opened 2026-10-06)
// shipped on the Shakespeare's Globe page (opened 2026-08-21). Two concurrent
// same-title productions: the review sat 47 days from the Globe, inside Guard A's
// 90-day "current show is far" gate, and the venue-substring signal skips
// cross-pool siblings. Venue named in the URL is the deterministic fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSiblingIndex, classifyMarketRouting, venuePhrases } = require('./market-routing.js');
const { isCurrentRunRoundup } = require('./gap-reference-sources.js');

const globe = {
  id: 'as-you-like-it-globe-west-end-2026', title: 'As You Like It', category: 'off-west-end',
  venue: "Shakespeare's Globe", openingDate: '2026-08-21', closingDate: '2026-10-25',
};
const rsc = {
  id: 'all-male-as-you-like-it-regional-2026', title: 'As You Like It', category: 'regional',
  venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', openingDate: '2026-10-06', closingDate: '2026-11-07',
};
const delacorte = {
  id: 'as-you-like-it-off-broadway-2022', title: 'As You Like It', category: 'off-broadway',
  venue: 'Delacorte Theater', openingDate: '2022-08-30', closingDate: '2022-09-25',
};
const shows = [globe, rsc, delacorte];
const siblingIndex = buildSiblingIndex(shows);
const STAGE_RSC = 'https://www.thestage.co.uk/reviews/as-you-like-it-review-royal-shakespeare-theatre-stratford-upon-avon-daniel-evans-jonathan-groff';
const STAGE_GLOBE = 'https://www.thestage.co.uk/reviews/as-you-like-it-review-shakespeares-globe-london';

const route = (showId, url, publishDate, category) =>
  classifyMarketRouting({ showId, url, outletId: 'thestage', publishDate, category, siblingIndex });

test('venuePhrases keeps distinctive venue names and drops generic ones', () => {
  assert.deepEqual(venuePhrases('Royal Shakespeare Theatre, Stratford-upon-Avon'), ['royal-shakespeare', 'royal-shakespeare-theatre']);
  assert.deepEqual(venuePhrases("Shakespeare's Globe"), ['shakespeares-globe']);
  assert.deepEqual(venuePhrases('Lyceum Theatre'), []); // GENERIC_VENUE_SLUGS
  assert.deepEqual(venuePhrases(null), []);
});

test('venuePhrases ignores cities, ordinary words and a mid-name "theatre" that collapses onto another company', () => {
  // later comma parts are cities/regions
  assert.ok(!venuePhrases('Chicago Shakespeare Theater, Chicago').includes('chicago'));
  assert.deepEqual(venuePhrases("A.R.T.'s Loeb Drama Center, Cambridge, MA").filter(p => p === 'cambridge'), []);
  // one-word names that are ordinary words in URLs (Olivier Award, National Theatre origin)
  assert.deepEqual(venuePhrases('Olivier Theatre'), []);
  assert.deepEqual(venuePhrases('National Theatre'), []);
  assert.deepEqual(venuePhrases('The Public Theater'), []);
  // "Shakespeare Theatre Company" must not become "shakespeare-company" (the RSC's name)
  assert.deepEqual(venuePhrases('Shakespeare Theatre Company (Harman Hall), Washington, DC'), ['shakespeare-theatre-company']);
  // a distinctive one-word house still counts
  assert.ok(venuePhrases('Duchess Theatre').includes('duchess'));
});

test('the RSC review filed under the Globe reroutes to the RSC show (the reported page)', () => {
  const r = route(globe.id, STAGE_RSC, '2026-10-07', globe.category);
  assert.equal(r.action, 'reroute');
  assert.equal(r.targetShowId, rsc.id);
  assert.match(r.reason, /^sibling-venue-in-url/);
});

test('the Globe review filed under the Globe stays; the RSC review filed under the RSC stays', () => {
  assert.equal(route(globe.id, STAGE_GLOBE, '2026-08-24', globe.category).action, 'accept');
  assert.equal(route(rsc.id, STAGE_RSC, '2026-10-07', rsc.category).action, 'accept');
});

test('a URL naming both venues is not rerouted (the filed-under venue wins)', () => {
  const both = 'https://example.com/as-you-like-it-shakespeares-globe-vs-royal-shakespeare-theatre';
  assert.equal(route(globe.id, both, '2026-10-07', globe.category).action, 'accept');
});

test('a sibling whose run window does not hold the review date cannot claim it (Broadway review citing the London venue it came from)', () => {
  const bw = { id: 'betrayal-2019', title: 'Betrayal', category: 'broadway', venue: 'Bernard B. Jacobs Theatre', openingDate: '2019-09-05', closingDate: '2019-12-08' };
  const we = { id: 'betrayal-west-end-2019', title: 'Betrayal', category: 'west-end', venue: 'Harold Pinter Theatre', openingDate: '2019-03-13', closingDate: '2019-06-08' };
  const idx = buildSiblingIndex([bw, we]);
  const r = classifyMarketRouting({
    showId: bw.id, category: 'broadway', siblingIndex: idx, outletId: 'deadline',
    url: 'https://deadline.com/2019/09/betrayal-broadway-review-tom-hiddleston-charlie-cox-zawe-ashton-harold-pinter-affair-to-remember-1202711669/',
    publishDate: 'September 5, 2019',
  });
  assert.notEqual(r.action, 'reroute');
});

test('a sibling with no opening date has no window and cannot claim a review', () => {
  const a = { id: 'x-west-end-2026', title: 'X Show', category: 'west-end', venue: 'London Palladium', openingDate: '2026-07-07', closingDate: '2026-09-05' };
  const b = { id: 'x-off-west-end-2026', title: 'X Show', category: 'off-west-end', venue: 'Drury Lane, Theatre Royal', openingDate: null, closingDate: '2027-01-09' };
  const idx = buildSiblingIndex([a, b]);
  const r = classifyMarketRouting({
    showId: a.id, category: 'west-end', siblingIndex: idx, outletId: 'londontheatre',
    url: 'https://www.londontheatre.co.uk/reviews/x-show-review-theatre-royal-drury-lane', publishDate: '2026-07-07',
  });
  assert.equal(r.action, 'accept');
});

test('an undated review naming the sibling venue still reroutes (Standard/Telegraph stubs carry no date)', () => {
  const r = route(globe.id, STAGE_RSC, undefined, globe.category);
  assert.equal(r.action, 'reroute');
  assert.equal(r.targetShowId, rsc.id);
});

// The same incident one step upstream: the gap audit handed the RSC roundup to both shows
// because it sat inside the Globe's [-30d, +90d] roundup window.
test('the RSC roundup (2026-10-07) is the RSC show\'s, not the Globe\'s', () => {
  assert.equal(isCurrentRunRoundup('2026-10-07', rsc, shows), true);
  assert.equal(isCurrentRunRoundup('2026-10-07', globe, shows), false);
  assert.equal(isCurrentRunRoundup('2026-08-22', globe, shows), true); // the Globe's own roundup
});

test('a roundup inside the own show\'s opening week stays current even with a sibling nearby', () => {
  const a = { id: 'a', title: 'Same Title', category: 'west-end', openingDate: '2026-10-01' };
  const b = { id: 'b', title: 'Same Title', category: 'regional', openingDate: '2026-10-06' };
  assert.equal(isCurrentRunRoundup('2026-10-05', a, [a, b]), true);
  assert.equal(isCurrentRunRoundup('2026-10-07', a, [a, b]), true); // within OWN_FAR_DAYS of its own opening
});

test('tour siblings never claim a roundup', () => {
  const a = { id: 'a', title: 'Same Title', category: 'broadway', openingDate: '2026-01-10' };
  const t = { id: 't', title: 'Same Title', category: 'tour', openingDate: '2026-02-20' };
  assert.equal(isCurrentRunRoundup('2026-02-21', a, [a, t]), true);
});

// Cases from the BRO-5386 ship-check replay. These assert the NEW rule stayed out of it: older
// date-vote guards may still (rightly) reroute the same review for their own reasons.
const notVenueRule = r => assert.ok(!(r.reason || '').startsWith('sibling-venue-in-url'), `venue rule fired: ${r.reason}`);
const classify = (a, b, url, publishDate, extra = {}) => {
  const idx = buildSiblingIndex([a, b]);
  return classifyMarketRouting({ showId: a.id, category: a.category, siblingIndex: idx, outletId: 'x', url, publishDate, ...extra });
};

test('a city or an award word in a Broadway URL does not reroute to a regional sibling', () => {
  const art = { id: 'two-strangers-regional-2025', title: 'Two Strangers', category: 'regional', venue: "A.R.T.'s Loeb Drama Center, Cambridge, MA", openingDate: '2025-06-02', closingDate: null };
  const bw = { id: 'two-strangers-bway-2025', title: 'Two Strangers', category: 'broadway', venue: 'Longacre Theatre', openingDate: '2025-11-20', closingDate: null };
  notVenueRule(classify(bw, art, 'https://x.com/two-strangers-review-broadway-cambridge-transfer', '2025-11-21'));
  const stage = { id: 'a-west-end-2026', title: 'A Show', category: 'west-end', venue: 'Gielgud Theatre', openingDate: '2026-03-01', closingDate: null };
  const nt = { id: 'a-2022', title: 'A Show', category: 'west-end', venue: 'Olivier Theatre', openingDate: '2022-03-01', closingDate: '2022-06-01' };
  notVenueRule(classify(stage, nt, 'https://x.com/a-show-review-olivier-award-winner', '2022-03-02'));
});

test('a review closer to this show\'s opening than the sibling\'s stays put even inside the sibling\'s open-ended window', () => {
  const tryout = { id: 't-regional-2025', title: 'T Show', category: 'regional', venue: 'Goodspeed Opera House', openingDate: '2025-06-02', closingDate: null };
  const bw = { id: 't-bway-2025', title: 'T Show', category: 'broadway', venue: 'Longacre Theatre', openingDate: '2025-11-20', closingDate: null };
  notVenueRule(classify(bw, tryout, 'https://x.com/t-show-review-goodspeed-opera-house-to-broadway', '2025-11-21'));
  // but the tryout's own early review is rerouted by the venue rule
  const early = classify(bw, tryout, 'https://x.com/t-show-review-goodspeed-opera-house', '2025-06-05');
  assert.equal(early.action, 'reroute');
  assert.equal(early.reason.startsWith('sibling-venue-in-url'), true);
});

test('an undated review naming a venue two siblings share is left where it is', () => {
  const cur = { id: 'c-2026', title: 'C Show', category: 'off-west-end', venue: 'Soho Theatre', openingDate: '2026-02-01', closingDate: null };
  const s1 = { id: 'c-2022', title: 'C Show', category: 'off-west-end', venue: 'Old Vic', openingDate: '2022-11-01', closingDate: '2023-01-10' };
  const s2 = { id: 'c-2018', title: 'C Show', category: 'off-west-end', venue: 'Old Vic', openingDate: '2018-11-01', closingDate: '2019-01-10' };
  const idx = buildSiblingIndex([cur, s1, s2]);
  const r = classifyMarketRouting({ showId: cur.id, category: cur.category, siblingIndex: idx, outletId: 'x', url: 'https://x.com/c-show-review-old-vic', publishDate: undefined });
  notVenueRule(r);
});

test('a Date-object publishDate still enforces the run window', () => {
  const r = classify(globe, rsc, STAGE_RSC, new Date('2026-10-07T00:00:00Z'), { category: globe.category });
  assert.equal(r.action, 'reroute');
  const bw = { id: 'betrayal-2019', title: 'Betrayal', category: 'broadway', venue: 'Bernard B. Jacobs Theatre', openingDate: '2019-09-05', closingDate: '2019-12-08' };
  const we = { id: 'betrayal-west-end-2019', title: 'Betrayal', category: 'west-end', venue: 'Harold Pinter Theatre', openingDate: '2019-03-13', closingDate: '2019-06-08' };
  notVenueRule(classify(bw, we, 'https://x.com/betrayal-broadway-review-harold-pinter', new Date('2019-09-05T00:00:00Z')));
});

test('DISABLE_SIBLING_VENUE_ROUTING=true turns the rule off', () => {
  process.env.DISABLE_SIBLING_VENUE_ROUTING = 'true';
  try {
    assert.equal(route(globe.id, STAGE_RSC, '2026-10-07', globe.category).action, 'accept');
  } finally {
    delete process.env.DISABLE_SIBLING_VENUE_ROUTING;
  }
});

test('a London-only roundup source ignores non-London siblings (Paranormal Activity DC regional vs a WE roundup)', () => {
  const we = { id: 'p-we-2026', title: 'P Show', category: 'west-end', openingDate: '2026-01-02' };
  const dc = { id: 'p-dc-2026', title: 'P Show', category: 'regional', openingDate: '2026-01-28' };
  assert.equal(isCurrentRunRoundup('2026-01-29', we, [we, dc]), false);
  assert.equal(isCurrentRunRoundup('2026-01-29', we, [we, dc], { londonOnly: true }), true);
});

test('a roundup dated before the sibling opened is not the sibling\'s', () => {
  const we = { id: 'p-we-2026', title: 'P Show', category: 'west-end', openingDate: '2026-01-02' };
  const dc = { id: 'p-dc-2026', title: 'P Show', category: 'regional', openingDate: '2026-01-28' };
  assert.equal(isCurrentRunRoundup('2026-01-25', we, [we, dc]), true);
});

// BRO-5397: a transfer declares its original run in priorRuns and inherits its reviews (Arcadia: Old Vic ->
// Duke of York's). 20 Old Vic reviews name the Old Vic in their urls; the venue rule must leave them where they are.
test('a sibling the entry lists in priorRuns (reviews inherited) never claims a review by venue', () => {
  const oldVic = { id: 'arcadia-west-end-2026', title: 'Arcadia', category: 'west-end', venue: 'The Old Vic', openingDate: '2026-02-04', closingDate: '2026-03-21' };
  const duke = {
    id: 'arcadia-duke-of-yorks-west-end-2026', title: 'Arcadia', category: 'west-end', venue: "Duke of York's Theatre",
    openingDate: '2026-07-01', closingDate: '2026-09-12',
    priorRuns: [{ id: 'arcadia-west-end-2026', venue: 'The Old Vic', openingDate: '2026-02-04', closingDate: '2026-03-21' }],
  };
  const r = classify(duke, oldVic, 'https://www.theguardian.com/stage/2026/feb/05/arcadia-review-tom-stoppard-old-vic-london', '2026-02-05');
  assert.ok(!(r.reason || '').startsWith('sibling-venue-in-url'), `venue rule fired: ${r.reason}`);
  // an opt-out (inheritReviews:false) is a different production again, so the rule applies
  const dukeOptOut = { ...duke, priorRuns: [{ ...duke.priorRuns[0], inheritReviews: false }] };
  const r2 = classify(dukeOptOut, oldVic, 'https://www.theguardian.com/stage/2026/feb/05/arcadia-review-tom-stoppard-old-vic-london', '2026-02-05');
  assert.equal(r2.action, 'reroute');
  assert.ok(r2.reason.startsWith('sibling-venue-in-url'));
});

test('regional <-> regional siblings are tour-family roll-ups, not venue matches', () => {
  const parent = { id: 'p-tour-regional-2025', title: 'P Show', category: 'regional', venue: 'U.S. National Tour (Chicago)', openingDate: '2025-10-01', closingDate: null };
  const la = { id: 'p-la-regional-2025', title: 'P Show', category: 'regional', venue: 'Ahmanson Theatre, Los Angeles', openingDate: '2025-11-12', closingDate: '2025-12-14' };
  const r = classify(parent, la, 'https://stageandcinema.com/2025/11/15/review-p-show-ahmanson-theatre', '2025-11-15');
  assert.ok(!(r.reason || '').startsWith('sibling-venue-in-url'), `venue rule fired: ${r.reason}`);
  // but a regional run filed under a West End show still reroutes (the RSC case)
  assert.equal(route(globe.id, STAGE_RSC, '2026-10-07', globe.category).action, 'reroute');
});

test('a declared prior run with no id is matched by its venue (39 of 52 real priorRuns carry no id)', () => {
  const oldVic = { id: 'arcadia-west-end-2026', title: 'Arcadia', category: 'west-end', venue: 'The Old Vic', openingDate: '2026-02-04', closingDate: '2026-03-21' };
  const duke = {
    id: 'arcadia-duke-of-yorks-west-end-2026', title: 'Arcadia', category: 'west-end', venue: "Duke of York's Theatre",
    openingDate: '2026-07-01', closingDate: '2026-09-12',
    priorRuns: [{ venue: 'The Old Vic', openingDate: '2026-02-04', closingDate: '2026-03-21' }],
  };
  const r = classify(duke, oldVic, 'https://www.theguardian.com/stage/2026/feb/05/arcadia-review-tom-stoppard-old-vic-london', '2026-02-05');
  assert.ok(!(r.reason || '').startsWith('sibling-venue-in-url'), `venue rule fired: ${r.reason}`);
});
