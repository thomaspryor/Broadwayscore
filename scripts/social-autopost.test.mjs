// Unit tests for scripts/social-autopost/ (BRO-6242): which posts fire, when,
// that every caption fits its network, and that the card's badge CSS is the
// site's. Offline: no Buffer, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sel = require('./social-autopost/select.js');
const { buildCaptions, postMarkers, showUrl, LIMITS } = require('./social-autopost/captions.js');
const { isUsablePoster, artVerdict, originalUrl, candidatesFor, sameTitle } = require('./social-autopost/art.js');
const { buildCardHtml, SITE_CSS } = require('./social-autopost/render.js');
const { metadataFor } = require('./social-autopost/buffer.js');
const { breakdownFor, pendingRetries, abandonRetries, postsToVerify } = require('./social-autopost/run.js');

const getOutletTier = id => Number(id.split('-')[0].slice(1));
const reviews = (t1, t2, t3) => [
  ...Array.from({ length: t1 }, (_, i) => ({ outletId: `t1-${i}`, assignedScore: 85, scoreConfidence: 'high' })),
  ...Array.from({ length: t2 }, (_, i) => ({ outletId: `t2-${i}`, assignedScore: 80, scoreConfidence: 'high' })),
  ...Array.from({ length: t3 }, (_, i) => ({ outletId: `t3-${i}`, assignedScore: 75, scoreConfidence: 'high' })),
];
const show = over => ({ id: 'x-2026', slug: 'x', title: 'X', category: 'broadway', type: 'musical', status: 'open', venue: 'Palace Theatre', openingDate: '2026-11-05', ...over });
const empty = { posts: [] };
const base = (s, over = {}) => ({ shows: [s], ledger: empty, slim: { [s.id]: { cs: 81.6, rc: 14 } }, getOutletTier, reviewsByShow: { [s.id]: reviews(3, 3, 8) }, ...over });

test('zonedTime handles both sides of a DST change', () => {
  assert.equal(sel.zonedTime('2026-07-01', 10, 'America/New_York').toISOString(), '2026-07-01T14:00:00.000Z');
  assert.equal(sel.zonedTime('2026-12-01', 10, 'America/New_York').toISOString(), '2026-12-01T15:00:00.000Z');
  assert.equal(sel.zonedTime('2026-07-01', 10, 'Europe/London').toISOString(), '2026-07-01T09:00:00.000Z');
});

test('the post is due at 10:00 local the morning after opening night', () => {
  assert.equal(new Date(sel.morningAfter(show())).toISOString(), '2026-11-06T15:00:00.000Z'); // 10:00 EST
  assert.equal(new Date(sel.morningAfter(show({ category: 'west-end', openingDate: '2026-11-05' }))).toISOString(), '2026-11-06T10:00:00.000Z');
});

test('nothing is created more than ~1h before the slot; at the slot it is due', () => {
  const s = show();
  assert.equal(sel.findScoreEvents({ ...base(s), now: Date.parse('2026-11-06T13:30:00Z') }).length, 0, '90 min early');
  const ev = sel.findScoreEvents({ ...base(s), now: Date.parse('2026-11-06T14:00:00Z') });
  assert.equal(ev.length, 1, '60 min early: created now');
  assert.equal(ev[0].dueAt.toISOString(), '2026-11-06T15:00:00.000Z');
  assert.equal(sel.findScoreEvents({ ...base(s), now: Date.parse('2026-11-06T14:00:00Z'), ledger: { posts: [{ type: 'score', showId: s.id }] } }).length, 0, 'already posted');
});

test('a score that settles later posts in the daytime window, within 10 days', () => {
  const s = show();
  const late = sel.findScoreEvents({ ...base(s), now: Date.parse('2026-11-08T03:00:00Z') }); // 22:00 New York
  assert.equal(late[0].dueAt.toISOString(), '2026-11-08T14:00:00.000Z'); // next 09:00 local
  assert.equal(sel.findScoreEvents({ ...base(s), now: Date.parse('2026-11-15T15:00:00Z') }).length, 1, 'day 9');
  assert.equal(sel.findScoreEvents({ ...base(s), now: Date.parse('2026-11-16T16:00:00Z') }).length, 0, 'too old');
});

test('every score is posted, but only once the gate passes and the site shows a score', () => {
  const s = show();
  const now = Date.parse('2026-11-06T15:00:00Z');
  const low = sel.findScoreEvents({ ...base(s, { reviewsByShow: { [s.id]: reviews(3, 3, 8).map(r => ({ ...r, assignedScore: 30 })) }, slim: { [s.id]: { cs: 31, rc: 14 } } }), now });
  assert.equal(low.length, 1, 'low scores post too');
  assert.equal(sel.findScoreEvents({ ...base(s, { reviewsByShow: { [s.id]: reviews(2, 3, 9) } }), now }).length, 0, 'T1 short');
  assert.equal(sel.findScoreEvents({ ...base(s, { slim: {} }), now }).length, 0, 'no site score yet');
});

test('Off-Broadway uses the London floors; Off-West End needs 10 reviews with 5 tier-1', () => {
  const now = Date.parse('2026-11-06T15:00:00Z');
  const ob = show({ category: 'off-broadway' });
  assert.equal(sel.findScoreEvents({ ...base(ob, { reviewsByShow: { [ob.id]: reviews(3, 2, 3) } }), now }).length, 1);
  const owe = show({ category: 'off-west-end' });
  const ow = { ...base(owe), now: Date.parse('2026-11-06T10:00:00Z') };
  assert.equal(sel.findScoreEvents({ ...ow, reviewsByShow: { [owe.id]: reviews(4, 3, 5) } }).length, 0);
  assert.equal(sel.findScoreEvents({ ...ow, reviewsByShow: { [owe.id]: reviews(5, 3, 4) } }).length, 1);
});

test('opera, provisional and cancelled shows never post', () => {
  const now = Date.parse('2026-11-06T15:00:00Z');
  for (const over of [{ type: 'opera' }, { provisional: true }, { status: 'cancelled' }]) {
    const s = show(over);
    assert.equal(sel.findScoreEvents({ ...base(s), now }).length, 0, JSON.stringify(over));
  }
});

test('a transfer needs reviews of this run, not its earlier run', () => {
  const prior = show({ id: 'p-2025', openingDate: '2025-03-01', closingDate: '2025-06-01', category: 'west-end', venue: 'Apollo Theatre' });
  const s = show({ id: 't-2026', category: 'west-end', openingDate: '2026-10-20', venue: 'Gielgud Theatre', priorRuns: [{ id: 'p-2025', venue: 'Apollo Theatre', openingDate: '2025-03-01', closingDate: '2025-06-01' }] });
  const args = { shows: [prior, s], ledger: empty, now: Date.parse('2026-10-25T12:00:00Z'), slim: { [s.id]: { cs: 80, rc: 14 } }, getOutletTier };
  const old = reviews(3, 3, 8).map(r => ({ ...r, showId: s.id, publishDate: '2025-03-05' }));
  assert.equal(sel.findScoreEvents({ ...args, reviewsByShow: { [s.id]: old } }).length, 0, 'only old-run reviews');
  const fresh = reviews(3, 3, 8).map(r => ({ ...r, showId: s.id, publishDate: '2026-10-21' }));
  assert.equal(sel.findScoreEvents({ ...args, reviewsByShow: { [s.id]: fresh } }).length, 1, 'reviews of this run');
});

test('same-morning posts are spaced 90 min apart and only the first is created now', () => {
  const now = Date.parse('2026-11-06T14:00:00Z');
  const evs = ['a', 'b', 'c'].map(id => ({ type: 'score', show: show({ id }), dueAt: new Date('2026-11-06T15:00:00Z') }));
  const ready = sel.scheduleEvents(evs, empty, now);
  assert.deepEqual(ready.map(e => e.show.id), ['a']);
  const t = evs.map(e => e.dueAt.getTime()).sort();
  assert.ok(t[1] - t[0] >= 90 * 6e4 && t[2] - t[1] >= 90 * 6e4);
});

test('a late post waits only until 90 min after the previous post, not 90 min after now', () => {
  // 2026-10-26: The Imaginary Invalid (due now+10 min) sat behind a 15:29:53 post and was
  // pushed to now+100 min on every run, outside the 70-min creation lead.
  const now = Date.parse('2026-10-26T16:21:40Z');
  const ledger = { posts: [{ type: 'score', showId: 'm', dueAt: '2026-10-26T15:29:53.000Z' }] };
  const evs = [{ type: 'score', show: show({ id: 'late' }), dueAt: new Date('2026-10-26T16:31:40Z') }];
  const ready = sel.scheduleEvents(evs, ledger, now);
  assert.deepEqual(ready.map(e => e.show.id), ['late']);
  assert.equal(ready[0].dueAt.toISOString(), '2026-10-26T16:59:53.000Z');
});

test('a post moved past a clash never lands less than 10 min from now', () => {
  const now = Date.parse('2026-10-26T16:00:00Z');
  const ledger = { posts: [{ type: 'score', showId: 'm', dueAt: new Date(now - 89 * 6e4).toISOString() }] };
  const evs = [{ type: 'score', show: show({ id: 'late' }), dueAt: new Date(now + 10 * 6e4) }];
  const ready = sel.scheduleEvents(evs, ledger, now);
  assert.ok(ready[0].dueAt.getTime() >= now + 10 * 6e4, ready[0].dueAt.toISOString());
});

test('a TodayTix poster is used only when its show name matches the title', () => {
  assert.equal(sameTitle('Derren Brown: Only Human', 'Derren Brown: Only Human'), true);
  assert.equal(sameTitle('The Great Gatsby', 'Great Gatsby'), true);
  assert.equal(sameTitle('Hadestown', 'The Imaginary Invalid'), false, 'recycled id');
  assert.equal(sameTitle('', 'X'), false);
});

test('first live run skips shows that opened more than 3 days ago', () => {
  const now = Date.parse('2026-11-10T15:00:00Z');
  const old = { type: 'score', show: show({ id: 'old', openingDate: '2026-11-01' }) };
  const fresh = { type: 'score', show: show({ id: 'fresh', openingDate: '2026-11-08' }) };
  const r = sel.splitBacklog([old, fresh], empty, now);
  assert.deepEqual(r.skip.map(e => e.show.id), ['old']);
  assert.deepEqual(r.post.map(e => e.show.id), ['fresh']);
  assert.equal(sel.splitBacklog([old], { posts: [{ showId: 'z' }] }, now).post.length, 1, 'only the very first run skips');
});

test('captions fit every network, carry the site numbers, link the right site, no em dashes', () => {
  const p = { show: show({ title: 'The Extraordinarily Long-Winded Musical Adventure of Somebody and Everybody Else', venue: 'Lunt-Fontanne Theatre' }), score: 86, tierId: 'must-see', tierLabel: 'Critical Gold', reviewCount: 38, breakdown: { rave: 25, positive: 11, mixed: 1, negative: 1 } };
  const c = buildCaptions(p);
  for (const net of Object.keys(LIMITS)) {
    assert.ok(c[net].length <= LIMITS[net], `${net} ${c[net].length}`);
    assert.ok(!c[net].includes('—'), `${net} em dash`);
    for (const m of postMarkers(p.show)) assert.ok(m.test(c[net]), `${net} lacks dedupe marker ${m}`);
  }
  for (const net of ['twitter', 'bluesky']) {
    assert.ok(c[net].length <= 270);
    assert.match(c[net], /has a Critic Score of 86 \(Critical Gold\) from 38 critics' reviews\./);
  }
  assert.match(c.facebook, /25 raves, 11 positive, 1 mixed, 1 negative/);
  assert.ok(!/https?:\/\//.test(c.instagram), 'Instagram captions cannot link');
  assert.match(showUrl(show({ category: 'west-end', slug: 'y' }), 'x'), /^https:\/\/westendscorecard\.com\/show\/y\?/);
  assert.match(showUrl(show({ category: 'off-broadway', slug: 'y' }), 'x'), /^https:\/\/broadwayscorecard\.com\/show\/y\?/);
});

test('dedupe path marker does not match a longer slug', () => {
  const [path] = postMarkers({ slug: 'proof' });
  assert.equal(path.test('see /show/proof-2000?utm_source=x'), false);
  assert.equal(path.test('see /show/proof?utm_source=x'), true);
  assert.equal(path.test('Full reviews: broadwayscorecard.com/show/proof (link in bio)'), true);
});

test('breakdown uses the site bar buckets with the market gold threshold', () => {
  const r = s => s;
  assert.deepEqual(breakdownFor([r(83), r(84.6), r(70), r(69), r(55), r(54), r(null)], 'broadway'), { rave: 2, positive: 1, mixed: 2, negative: 1 });
  assert.deepEqual(breakdownFor([r(84), r(85)], 'west-end'), { rave: 1, positive: 1, mixed: 0, negative: 0 }); // London gold is 85
});

test('poster rules: a portrait at least 440 px wide, confirmed by the vision check', () => {
  assert.equal(isUsablePoster({ width: 480, height: 720 }), true);
  assert.equal(isUsablePoster({ width: 300, height: 450 }), false, 'too small');
  assert.equal(isUsablePoster({ width: 1080, height: 1080 }), false, 'square key art');
  assert.equal(artVerdict({ match: true }).ok, true);
  assert.equal(artVerdict({ match: false, confidence: 'low' }).ok, false, 'a low-confidence no still fails');
  assert.equal(artVerdict({ skipped: true }).ok, false, 'unverified art is not used');
  assert.equal(originalUrl('https://images.ctfassets.net/a/b/c/x.jpg?w=1920&fm=webp'), 'https://images.ctfassets.net/a/b/c/x.jpg');
  const show = { id: 's', todaytixId: 48323, images: { poster: '/images/shows/s/poster.jpg' } };
  const order = c => c.url ? 'source' : c.todaytixId ? 'todaytix' : 'local';
  assert.deepEqual(candidatesFor(show, { s: { poster: 'https://images.ctfassets.net/a/b/c/p.jpg?w=300' } }).map(order), ['source', 'todaytix', 'local']);
  assert.deepEqual(candidatesFor({ ...show, todaytixId: null }, {}).map(order), ['local'], 'no TodayTix id: site copy only');
});

test("the card's badge CSS is exactly the site's (src/app/globals.css)", () => {
  const css = fs.readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  const norm = s => s.replace(/\s+/g, ' ').replace(/\s*([:;,()])\s*/g, '$1').trim();
  for (const [cls, body] of Object.entries(SITE_CSS)) {
    const m = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `.${cls} not found in globals.css`);
    assert.equal(norm(body), norm(m[1]), `.${cls} drifted from globals.css`);
  }
});

test('card HTML escapes text, uses the market logo, crowns only gold, lists non-zero buckets', () => {
  const card = { market: 'west-end', title: '<b>Tom & Jerry</b>', venue: 'Gielgud', score: 88, tierId: 'must-see', tierLabel: 'Critical Gold', breakdown: { rave: 3, positive: 0, mixed: 1, negative: 0 }, poster: null };
  const html = buildCardHtml(card);
  assert.ok(html.includes('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;'));
  assert.ok(html.includes('class="score-must-see"') && html.includes('<svg'), 'gold badge with crown');
  assert.ok(html.includes('#f472b6'), 'West End pink');
  assert.ok(html.includes('3 Rave') && html.includes('1 Mixed') && !html.includes('0 Positive'));
  const green = buildCardHtml({ ...card, market: 'broadway', score: 78, tierId: 'recommended', tierLabel: 'Recommended' });
  assert.ok(green.includes('class="score-great"') && !green.includes('<svg'));
});

test('retries and read-backs pick the right ledger entries', () => {
  const now = Date.parse('2026-11-06T16:00:00Z');
  const e = over => ({ showId: 'x', dueAt: '2026-11-06T15:00:00Z', pending: { bluesky: 't' }, attempts: 1, channels: { instagram: { postId: 'p1' } }, ...over });
  assert.equal(pendingRetries({ posts: [e()] }, now).length, 1);
  assert.equal(pendingRetries({ posts: [e({ attempts: 3 })] }, now).length, 0, 'gave up');
  assert.equal(pendingRetries({ posts: [e({ dueAt: '2026-11-05T01:00:00Z' })] }, now).length, 0, 'stale');
  assert.equal(postsToVerify({ posts: [e()] }, now).length, 1, '1h after due');
  assert.equal(postsToVerify({ posts: [e({ dueAt: '2026-11-06T15:45:00Z' })] }, now).length, 0, 'not yet due + 30 min');
  assert.equal(postsToVerify({ posts: [e({ channels: { instagram: { postId: 'p1', result: 'sent' } } })] }, now).length, 0, 'already read back');
  const ledger = { posts: [e(), e({ showId: 'y', attempts: 3 })] };
  const gaveUp = abandonRetries(ledger, now);
  assert.equal(gaveUp.length, 1, 'a network out of attempts is reported once');
  assert.match(gaveUp[0], /^y: gave up on bluesky/);
  assert.equal(ledger.posts[1].pending, undefined);
  assert.deepEqual(ledger.posts[1].abandoned, ['bluesky']);
  assert.ok(ledger.posts[0].pending, 'still owed a retry');
  assert.equal(abandonRetries(ledger, now).length, 0, 'not reported again');
});

test('Buffer metadata: Instagram and Facebook get the required post type', () => {
  assert.deepEqual(metadataFor('instagram'), { instagram: { type: 'post', shouldShareToFeed: true } });
  assert.deepEqual(metadataFor('facebook'), { facebook: { type: 'post' } });
  assert.equal(metadataFor('bluesky'), undefined);
});

// ---------------------------------------------------------------------------
// Brief posts (BRO-6368): compare template, approval hash, cross-lane rule.
const briefs = require('./social-autopost/briefs.js');
const cap = require('./social-autopost/captions.js');
const bufferLib = require('./social-autopost/buffer.js');
const { buildCompareHtml } = require('./social-autopost/render.js');
const { publishEvent, entryMarkers } = require('./social-autopost/run.js');

const NOW = Date.parse('2026-10-26T15:00:00Z');
const london = show({ id: 'tc-west-end-2024', slug: 'tc-west-end-2024', title: 'The Curious Case', category: 'west-end', status: 'closed', openingDate: null, previewsStartDate: '2024-10-10' });
const offb = show({ id: 'tc-off-broadway-2026', slug: 'tc-off-broadway', title: 'The Curious Case', category: 'off-broadway', openingDate: '2026-10-21' });
const desc = (s, score, reviewCount) => ({ show: s, score, reviewCount, tierId: 'must-see' });
// X counts any link as 23 characters (t.co); every other network counts it in full.
const xLength = (net, text) => [...(net === 'twitter' ? text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)) : text)].length;
const compare = (hook = '') => briefs.buildCompare({ descA: desc(london, 85, 26), descB: desc(offb, 77, 24), hook, now: NOW });

test('compare: orders by date, states only the facts, "so far" for a new opening, both links, every limit', () => {
  const c = compare();
  assert.equal(c.older.show.id, london.id);
  assert.equal(c.newer.show.id, offb.id);
  assert.deepEqual(c.facts, { [london.id]: { score: 85, reviewCount: 26 }, [offb.id]: { score: 77, reviewCount: 24 } });
  assert.equal(c.delta, 8);
  for (const [net, text] of Object.entries(c.captions)) {
    if (net === 'altText') continue;
    assert.ok(xLength(net, text) <= LIMITS[net], `${net} over its limit`);
    assert.ok(!/[—–]/.test(text), `${net} has a dash`);
    assert.ok(!/transfer/i.test(text), `${net} says transfer`);
    assert.match(text, /77 from 24 critics so far/);
    assert.match(text, /85 from 26 critics(?! so far)/);
    assert.ok(cap.compareMarkers(offb).every(m => m.test(text)), `${net} misses a compare marker`);
    assert.ok(!cap.SCORE_SENTENCE.test(text), `${net} reuses the score-post sentence`);
    assert.deepEqual(cap.strayNumbers(text, [85, 26, 77, 24, 8, 2024, 2026]), []);
  }
  assert.match(c.captions.facebook, /broadwayscorecard\.com\/show\/tc-off-broadway\?/);
  assert.match(c.captions.facebook, /westendscorecard\.com\/show\/tc-west-end-2024\?/);
  assert.match(c.captions.instagram, /was also reviewed in London/);
  // A score post never matches a compare post's markers, and the reverse.
  const score = buildCaptions({ show: offb, score: 77, reviewCount: 24, breakdown: { rave: 5, positive: 10, mixed: 5, negative: 4 } });
  assert.ok(!cap.compareMarkers(offb).every(m => m.test(score.twitter)));
});

const SHORT_CAVEAT = 'Two years apart, different cities and critics.';
const CAVEAT = "Two years apart, in different cities, with different critics, so the scores aren't a like-for-like comparison.";

test('compare caveat: on all five networks after the score lines, computed in words, no digits or dashes', () => {
  const c = compare('A new cast takes it on');
  for (const net of ['instagram', 'facebook', 'threads']) {
    const text = c.captions[net];
    assert.ok(text.includes(CAVEAT), `${net} misses the caveat`);
    assert.ok(text.indexOf(CAVEAT) > text.search(/85 from 26 critics/), `${net} caveat before the scores`);
  }
  // X keeps the short form when the full one has no room; Bluesky (links counted in full) keeps it if it fits.
  assert.ok(c.captions.twitter.includes(CAVEAT), 'X has room for the full caveat with a short title');
  const real = 'The Curious Case of Benjamin Button';
  const x = briefs.buildCompare({ descA: desc({ ...london, title: real }, 85, 26), descB: desc({ ...offb, title: real }, 77, 24), hook: '', now: NOW }).captions.twitter;
  assert.ok(x.includes(SHORT_CAVEAT) && !x.includes(CAVEAT) && x.includes(real), 'X falls back to the short caveat before shortening the title');
  assert.ok(x.indexOf(SHORT_CAVEAT) > x.search(/85 from 26 critics/));
  assert.equal(cap.compareCaveat(offb, london, { short: true }), SHORT_CAVEAT);
  assert.equal(cap.compareCaveat({ ...offb, openingDate: '2024-03-01' }, london, { short: true }), 'Different cities and critics.');
  assert.equal(cap.compareCaveat({ ...offb, openingDate: '2021-01-01' }, offb, { short: true }), 'Five years apart, different critics.');
  assert.equal(cap.compareCaveat(offb, offb, { short: true }), null);
  assert.equal(cap.compareCaveat(offb, london), CAVEAT);
  assert.equal(cap.compareCaveat({ ...offb, openingDate: '2025-03-01' }, london), "A year apart, in different cities, with different critics, so the scores aren't a like-for-like comparison.");
  assert.equal(cap.compareCaveat({ ...offb, openingDate: '2024-03-01' }, london), "In different cities, with different critics, so the scores aren't a like-for-like comparison.");
  assert.equal(cap.compareCaveat({ ...offb, category: 'broadway' }, offb), "In different markets, with different critics, so the scores aren't a like-for-like comparison.");
  assert.equal(cap.compareCaveat({ ...offb, openingDate: '2021-01-01' }, offb), "Five years apart, with different critics, so the scores aren't a like-for-like comparison.");
  assert.equal(cap.compareCaveat({ ...offb }, offb), null, 'same year, same market: no caveat');
  for (const s of [cap.compareCaveat(offb, { ...london, previewsStartDate: '1990-01-01' })]) assert.ok(!/\d|[\u2013\u2014]/.test(s), s);
});

test('compare caveat: a short network drops it before any number, link or the title', () => {
  const longTitle = 'The Extraordinarily Long Title Of A Musical About Many Things';
  const a = { ...london, title: longTitle }, b = { ...offb, title: longTitle };
  const c = briefs.buildCompare({ descA: desc(a, 85, 26), descB: desc(b, 77, 24), hook: '', now: NOW });
  for (const net of ['twitter', 'bluesky']) {
    const text = c.captions[net];
    assert.ok(xLength(net, text) <= LIMITS[net], `${net} over its limit`);
    assert.match(text, /77 from 24 critics so far/);
    assert.match(text, /85 from 26 critics/);
    assert.match(text, /\/show\/tc-off-broadway\?/);
    if (!text.includes(SHORT_CAVEAT)) assert.ok(text.includes(longTitle), `${net} dropped the caveat but still shortened the title`);
    assert.ok(!text.includes(CAVEAT) || !text.includes(SHORT_CAVEAT));
  }
});

test('compare: refuses mismatched titles, same city, digits or links in the hook, stray numbers', () => {
  assert.throws(() => briefs.orderCompare(london, { ...offb, title: 'Other' }), /same title/);
  assert.throws(() => briefs.orderCompare(london, { ...offb, category: 'off-west-end' }), /one New York and one London/);
  assert.throws(() => compare('Now 10 points higher'), /hook/);
  assert.throws(() => compare('See https://x.com'), /hook/);
  assert.throws(() => compare('It is better than London'), /hook/);
  assert.equal(cap.validateHook('Two cities, one strange story.'), null);
  // The hook rides where there is room; on X the caveat outranks it.
  const hooked = compare('Two cities, one strange story.').captions;
  assert.ok(hooked.instagram.startsWith('Two cities') && hooked.facebook.startsWith('Two cities'));
  assert.ok(hooked.twitter.includes(CAVEAT) || hooked.twitter.includes(SHORT_CAVEAT));
  assert.deepEqual(cap.strayNumbers('Score 77 from 24, see broadwayscorecard.com/show/x-2026 #Theatre2026', [77, 24]), []);
  assert.deepEqual(cap.strayNumbers('Score 78 from 24', [77, 24]), ['78']);
});

test('brief hash: stable across key order, changes with any fact; facts-changed lines', () => {
  const m = { a: 1, b: { c: [1, 2], d: 'x' } };
  assert.equal(briefs.hashManifest(m), briefs.hashManifest({ b: { d: 'x', c: [1, 2] }, a: 1 }));
  assert.notEqual(briefs.hashManifest(m), briefs.hashManifest({ ...m, a: 2 }));
  assert.match(briefs.hashManifest(m), briefs.HASH_RE);
  const was = { a: { score: 77, reviewCount: 24 } };
  assert.deepEqual(briefs.factChanges(was, { a: { score: 77, reviewCount: 24 } }), []);
  assert.deepEqual(briefs.factChanges(was, { a: { score: 77, reviewCount: 25 } }), ['a: reviewCount was 24, is now 25']);
  assert.equal(briefs.factChanges(was, {}).length, 1);
});

test('brief dedupe: same hash ever, same pair within 30 days', () => {
  const pair = briefs.pairKey([offb.id, london.id]);
  assert.equal(pair, briefs.pairKey([london.id, offb.id]));
  const ledger = { posts: [{ type: 'brief', hash: 'aaaaaaaaaaaa', pair, dueAt: '2026-10-10T14:00:00Z' }] };
  assert.ok(briefs.briefConflicts(ledger, { hash: 'aaaaaaaaaaaa', pair }, NOW).sameHash);
  assert.ok(briefs.briefConflicts(ledger, { hash: 'bbbbbbbbbbbb', pair }, NOW).samePair);
  assert.equal(briefs.briefConflicts(ledger, { hash: 'bbbbbbbbbbbb', pair }, NOW + 30 * 864e5).samePair, null);
  assert.equal(briefs.briefConflicts(ledger, { hash: 'bbbbbbbbbbbb', pair: 'x+y' }, NOW).samePair, null);
});

test('cross-lane rule: busy days per show, failed posts ignored, an empty-but-expected listing fails closed', () => {
  const tz = 'America/New_York';
  const posts = [
    { id: '1', text: 'x https://broadwayscorecard.com/show/tc-off-broadway?utm_source=x', status: 'sent', sentAt: '2026-10-26T14:00:00Z' },
    { id: '2', text: 'x https://broadwayscorecard.com/show/tc-off-broadway?utm_source=x', status: 'error', dueAt: '2026-10-27T14:00:00Z' },
    { id: '3', text: 'x https://broadwayscorecard.com/show/tc-off-broadway-2?utm_source=x', status: 'scheduled', dueAt: '2026-10-28T14:00:00Z' },
  ];
  assert.deepEqual([...bufferLib.busyDays(posts, { marker: cap.pathMarker(offb), tz })], ['2026-10-26']);
  assert.equal(bufferLib.listingProblem([], []), null);
  assert.equal(bufferLib.listingProblem(posts, ['3']), null);
  assert.match(bufferLib.listingProblem([], ['9']), /none of the 1/);
});

test('brief busy days: a ledger post the listing missed still blocks its day; a cancelled one does not', async () => {
  const run = require('./social-autopost/run.js');
  const ch = { service: 'bluesky', key: 'bluesky' };
  const listed = { id: 'a', text: 'x', status: 'scheduled', dueAt: '2026-10-27T14:00:00Z' };
  const fake = { ...bufferLib, listChannelPosts: async () => [listed] };
  const entry = (id, showId, dueAt, result) => ({ showId, dueAt, channels: { bluesky: { postId: id, ...(result ? { result } : {}) } } });
  const ledger = { posts: [entry('a', 'other', '2026-10-27T14:00:00Z'), entry('b', offb.id, '2026-10-29T14:00:00Z'), entry('c', offb.id, '2026-10-30T14:00:00Z', 'cancelled')] };
  const [r] = await run.briefBusyDays({ shows: [offb], channels: [ch], buffer: fake, ledger, now: NOW });
  assert.ok(r.busy.has('2026-10-29'));
  assert.ok(!r.busy.has('2026-10-30'));
});

test('brief channels: the newer production\'s home set only, never cross-posted', () => {
  const run = require('./social-autopost/run.js');
  const C = require('./social-autopost/config.js');
  const all = require('./social-autopost/routing.js').tagChannels([...Object.entries(C.CHANNEL_SETS.broadway).map(([service, id]) => ({ service, id })), { service: 'tiktok', id: 'not-ours' }], C.CHANNEL_SETS);
  assert.deepEqual(run.briefChannels(all, offb).map(c => c.key).sort(), Object.keys(C.CHANNEL_SETS.broadway).sort());
  // West End accounts not configured yet: a London-newer brief keeps to Broadway, like score posts.
  assert.deepEqual(run.briefChannels(all, london).map(c => c.set), Object.keys(C.CHANNEL_SETS.broadway).map(() => 'broadway'));
  assert.ok(run.briefChannels(all, offb).every(c => c.set === 'broadway'));
});

test('compare: digits in the title are allowed, an over-limit or em-dash caption is refused', () => {
  const ny = show({ id: 's39-bway', slug: 's39-bway', title: 'The 39 Steps', category: 'broadway', openingDate: '2008-01-15' });
  const ld = show({ id: 's39-we', slug: 's39-we', title: 'The 39 Steps', category: 'west-end', openingDate: '2024-06-01' });
  const built = briefs.buildCompare({ descA: desc(ny, 70, 20), descB: desc(ld, 60, 15), now: NOW });
  assert.match(built.captions.twitter, /39 Steps/);
  assert.ok(briefs.allowedNumbers([ny, ld], built.facts, built.delta).includes('39'));
  const dashed = show({ id: 'd-we', slug: 'd-we', title: 'A \u2014 B', category: 'west-end', openingDate: '2024-06-01' });
  const dashedNy = show({ id: 'd-ny', slug: 'd-ny', title: 'A \u2014 B', category: 'broadway', openingDate: '2020-06-01' });
  assert.throws(() => briefs.buildCompare({ descA: desc(dashedNy, 70, 20), descB: desc(dashed, 60, 15), now: NOW }), /em dash/);
});

test('brief slot: skips a busy local day for either show, keeps 90 min from other posts, null past MAX_SLOT_DAYS', () => {
  const tz = 'America/New_York';
  const args = { now: NOW, tz, inWindow: sel.inWindow, nextWindowSlot: sel.nextWindowSlot, zonedTime: sel.zonedTime, localDay: bufferLib.localDay };
  const free = briefs.pickBriefSlot({ ...args, shows: [], taken: [] });
  assert.ok(free >= NOW + 10 * 60e3 && sel.inWindow(free, tz));
  const busy = briefs.pickBriefSlot({ ...args, shows: [{ tz: 'Europe/London', busy: new Set([bufferLib.localDay(free, 'Europe/London')]) }], taken: [] });
  assert.notEqual(bufferLib.localDay(busy, 'Europe/London'), bufferLib.localDay(free, 'Europe/London'));
  const spaced = briefs.pickBriefSlot({ ...args, shows: [], taken: [free] });
  assert.ok(spaced - free >= 90 * 60e3);
  const allBusy = new Set(Array.from({ length: briefs.MAX_SLOT_DAYS + 2 }, (_, i) => bufferLib.localDay(NOW + i * 864e5, tz)));
  assert.equal(briefs.pickBriefSlot({ ...args, shows: [{ tz, busy: allBusy }], taken: [] }), null);
});

test('publishEvent: adopts an existing post, creates the rest, one failure does not stop the others', async () => {
  const made = [];
  const buffer = {
    findExistingPost: async ({ channel }) => (channel.service === 'twitter' ? { id: 'old' } : null),
    createImagePost: async ({ channel, text }) => { if (channel.service === 'bluesky') throw new Error('boom'); made.push([channel.service, text]); return { id: `new-${channel.service}` }; },
  };
  const channels = ['twitter', 'threads', 'bluesky'].map(s => ({ service: s, key: s, network: s }));
  const captions = { twitter: 't', threads: 'th', bluesky: 'b', altText: 'a' };
  const { posted, errors } = await publishEvent({ channels, buffer, captions, imageUrl: 'u', markers: [], dueAt: new Date(NOW), label: 'brief:x', now: NOW });
  assert.deepEqual(posted, { twitter: { postId: 'old' }, threads: { postId: 'new-threads' } });
  assert.deepEqual(Object.keys(errors), ['bluesky']);
  assert.deepEqual(made, [['threads', 'th']]);
  // Retries use the brief's own markers, not the score post's.
  assert.ok(entryMarkers({ type: 'brief', slug: 'tc-off-broadway', category: 'off-broadway' }).length >= 1);
});

test('compare card HTML: both sides, crown only on gold, "so far", delta, escaped title', () => {
  const html = buildCompareHtml({ title: 'A & B', market: 'off-broadway', delta: 8, sides: [
    { market: 'west-end', label: 'London 2024', score: 85, tierId: 'must-see', reviewCount: 26, soFar: false, poster: null },
    { market: 'off-broadway', label: 'Off-Broadway 2026', score: 77, tierId: 'recommended', reviewCount: 24, soFar: true, poster: null },
  ] });
  assert.match(html, /A &amp; B/);
  assert.match(html, /London 2024/);
  assert.match(html, /24 critics so far/);
  assert.match(html, /26 critics</);
  assert.match(html, /8 points apart/);
  assert.equal((html.match(/fill="#FFD700"/g) || []).length, 1);
});

// ---- per-market channel routing (BRO-6378) ----
const routing = require('./social-autopost/routing.js');
const SETS_BOTH = { broadway: { instagram: 'b1' }, 'west-end': { instagram: 'w1' } };
const NONE = [];
const by = (...outlets) => outlets.map(outletId => ({ outletId }));

test('routing: West End and Off-West End go to West End channels only, Broadway and Off-Broadway to Broadway only', () => {
  for (const [category, want] of [['west-end', 'west-end'], ['off-west-end', 'west-end'], ['broadway', 'broadway'], ['off-broadway', 'broadway']]) {
    assert.deepEqual(routing.targetSets(show({ category }), NONE, SETS_BOTH, []), [want], category);
  }
});

test('routing: a high-profile show (other-market critics, same show there, or transfer) also posts to the other market', () => {
  assert.deepEqual(routing.targetSets(show({ category: 'west-end' }), by('nytimes'), SETS_BOTH, []), ['west-end', 'broadway']);
  assert.deepEqual(routing.targetSets(show({ category: 'broadway' }), by('telegraph'), SETS_BOTH, []), ['broadway', 'west-end']);
  // a market's own critics do not count, however many: London's nationals review nearly every West End opening
  assert.deepEqual(routing.targetSets(show({ category: 'west-end' }), by('telegraph', 'times-uk', 'financialtimes', 'thestage', 'independent', 'sunday-times', 'guardian', 'evening-standard'), SETS_BOTH, []), ['west-end']);
  assert.deepEqual(routing.targetSets(show({ category: 'broadway' }), by('nytimes', 'variety', 'vulture'), SETS_BOTH, []), ['broadway']);
  const lon = show({ id: 'lon', category: 'west-end' });
  const nyc = show({ id: 'nyc', category: 'broadway', transferOf: 'lon' });
  assert.deepEqual(routing.targetSets(nyc, NONE, SETS_BOTH, [lon, nyc]), ['broadway', 'west-end']);
  // a transfer within the same market (Off-Broadway -> Broadway) is not cross-market
  const ob = show({ id: 'ob', category: 'off-broadway' });
  assert.deepEqual(routing.targetSets(show({ id: 'bw', transferOf: 'ob' }), NONE, SETS_BOTH, [ob]), ['broadway']);
});

test('routing: the same title on the other main stage within 3 years is high profile; Off- markets and old runs are not', () => {
  const we = show({ id: 'we', category: 'west-end', title: 'Oh, Mary!', openingDate: '2026-01-27' });
  const bw = show({ id: 'bw', category: 'broadway', title: 'Oh, Mary!', openingDate: '2024-07-11' });
  assert.deepEqual(routing.targetSets(we, NONE, SETS_BOTH, [we, bw]), ['west-end', 'broadway']);
  assert.deepEqual(routing.targetSets(bw, NONE, SETS_BOTH, [we, bw]), ['broadway', 'west-end']);
  const old = { ...bw, openingDate: '2019-01-01' };
  assert.deepEqual(routing.targetSets(we, NONE, SETS_BOTH, [we, old]), ['west-end'], 'more than 3 years apart');
  const owe = { ...we, category: 'off-west-end' };
  assert.deepEqual(routing.targetSets(owe, NONE, SETS_BOTH, [owe, bw]), ['west-end'], 'Off-West End is not main stage');
  assert.equal(routing.titleKey('The Phantom of the Opéra'), routing.titleKey('Phantom of the Opera'));
});

test('routing: rival productions of one play (different directors) are not twins; a missing or bad date never matches', () => {
  const dir = name => [{ role: 'Director', name }];
  const we = show({ id: 'we', category: 'west-end', title: 'Othello', openingDate: '2025-06-01', creativeTeam: dir('Tom Morris') });
  const bw = show({ id: 'bw', category: 'broadway', title: 'Othello', openingDate: '2025-03-23', creativeTeam: [...dir('Kenny Leon'), { role: 'Music Direction', name: 'Tom Morris' }] });
  assert.equal(routing.isHighProfile(we, NONE, [we, bw]), false, 'different directors');
  const same = { ...bw, creativeTeam: [{ role: 'Director & Choreographer', name: 'Tom Morris' }] };
  assert.equal(routing.isHighProfile(we, NONE, [we, same]), true, 'same director: the production transferred');
  assert.equal(routing.isHighProfile(we, NONE, [we, { ...bw, creativeTeam: [] }]), true, 'unknown director: title + date decide');
  assert.equal(routing.isHighProfile(we, NONE, [we, { ...bw, openingDate: 'TBA' }]), false);
  assert.equal(routing.isHighProfile({ ...we, openingDate: undefined }, NONE, [we, bw]), false);
});

test('routing: West End channels not configured yet -> unchanged behaviour (everything to Broadway)', () => {
  const none = { broadway: { instagram: 'b1' }, 'west-end': {} };
  assert.deepEqual(routing.targetSets(show({ category: 'west-end' }), by('nytimes', 'telegraph'), none, []), ['broadway']);
  assert.deepEqual(routing.targetSets(show({ category: 'broadway' }), by('nytimes', 'telegraph'), none, []), ['broadway'], 'no cross-post to an unconfigured set');
});

test('routing: channels are tagged by set; the Broadway ledger key stays the bare service name', () => {
  const tagged = routing.tagChannels([{ id: 'b1', service: 'instagram' }, { id: 'w1', service: 'instagram' }, { id: 'z', service: 'tiktok' }], SETS_BOTH);
  assert.deepEqual(tagged.map(c => [c.set, c.key]), [['broadway', 'instagram'], ['west-end', 'instagram@west-end'], [null, null]]);
});

test('routing: the live config has Broadway channels and routes every eligible category somewhere', () => {
  const C = require('./social-autopost/config.js');
  assert.ok(Object.keys(C.CHANNEL_SETS.broadway).length >= 5);
  for (const cat of C.ELIGIBLE_CATEGORIES) assert.ok(routing.targetSets(show({ category: cat }), NONE).length >= 1, cat);
});

test('routing: a partly filled West End set is not active; duplicate ids across sets are rejected', () => {
  const part = { broadway: { instagram: 'b1', facebook: 'b2' }, 'west-end': { instagram: 'w1' } };
  assert.deepEqual(routing.targetSets(show({ category: 'west-end' }), by('nytimes', 'telegraph'), part, []), ['broadway']);
  const dup = { broadway: { instagram: 'b1' }, 'west-end': { instagram: 'b1' } };
  assert.throws(() => routing.tagChannels([{ id: 'b1', service: 'instagram' }], dup), /both 'broadway' and 'west-end'/);
});

test('routing: a transfer link on either end makes both shows high profile', () => {
  const lon = show({ id: 'lon', category: 'west-end' });
  const nyc = show({ id: 'nyc', category: 'broadway', transferOf: 'lon' });
  assert.deepEqual(routing.targetSets(lon, NONE, SETS_BOTH, [lon, nyc]), ['west-end', 'broadway']);
});

test('self-test: channels added after go-live (West End) are unvalidated; legacy ledgers cover the Broadway set', () => {
  const { unvalidated } = require('./social-autopost/run.js');
  const C = require('./social-autopost/config.js');
  const b = Object.values(C.CHANNEL_SETS.broadway).map(id => ({ id }));
  assert.equal(unvalidated({ _meta: { bufferValidatedAt: 'x' } }, b).length, 0);
  assert.deepEqual(unvalidated({ _meta: { bufferValidatedAt: 'x' } }, [...b, { id: 'w1' }]).map(c => c.id), ['w1']);
  assert.equal(unvalidated({ _meta: {} }, b).length, b.length);
  assert.equal(unvalidated({ _meta: { bufferValidatedAt: 'x', bufferValidatedChannels: ['w1'] } }, [{ id: 'w1' }]).length, 0);
});

// ---- brief follow-ups: quota guard, poster sources, URL escaping (BRO-6368) ----
test('quota: reads the tightest Buffer rate limit and refuses a brief it cannot afford', () => {
  const h = { ratelimit: '"100-in-15min"; r=99; t=900, "250-in-1day"; r=0; t=408', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793051582' };
  const rate = bufferLib.parseRateHeaders(k => h[k], NOW);
  assert.equal(rate.remaining, 0);
  assert.equal(rate.resetAt, NOW + 408e3);
  const need = require('./social-autopost/run.js').briefQuotaNeed(5, 5);
  assert.equal(need, 30);
  assert.match(bufferLib.quotaProblem(rate, need), /0 request\(s\) left under its rate limit and this needs 30; .* retry after/);
  assert.equal(bufferLib.quotaProblem({ remaining: 30, resetAt: null }, need), null);
  assert.match(bufferLib.quotaProblem(null, need), /unknown/);
  assert.deepEqual(bufferLib.parseRateHeaders(() => null), null);
});

test('quota: every Buffer answer updates the remaining quota (fake server via BUFFER_API_URL)', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Ratelimit-Remaining': '42', 'X-Ratelimit-Reset': '1793051582' });
    res.end(JSON.stringify({ data: { account: { organizations: [] } } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = { url: process.env.BUFFER_API_URL, key: process.env.BUFFER_API_KEY };
  process.env.BUFFER_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.BUFFER_API_KEY = 'fake';
  try {
    await bufferLib.listChannels();
    assert.deepEqual(bufferLib.rateLimit(), { remaining: 42, resetAt: 1793051582e3 });
  } finally {
    for (const [k, v] of [['BUFFER_API_URL', saved.url], ['BUFFER_API_KEY', saved.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise(r => server.close(r));
  }
});

test('poster: the compare card accepts a narrower original (10% stretch at most); Mezzanine art is a candidate', () => {
  const art = require('./social-autopost/art.js');
  const { COMPARE_POSTER_PX } = require('./social-autopost/render.js');
  assert.equal(art.minPosterWidth(COMPARE_POSTER_PX), 346);
  assert.ok(art.minPosterWidth(COMPARE_POSTER_PX) * 1.1 >= COMPARE_POSTER_PX);
  assert.ok(art.isUsablePoster({ width: 400, height: 631 }, art.minPosterWidth(COMPARE_POSTER_PX)));
  assert.ok(!art.isUsablePoster({ width: 400, height: 631 }), 'the score card still needs 440');
  assert.ok(!art.isUsablePoster({ width: 189, height: 267 }, art.minPosterWidth(COMPARE_POSTER_PX)));
  const shows = require('../data/shows.json');
  const all = shows.shows || shows;
  const bb = all.find(s => s.id === 'the-curious-case-of-benjamin-button-west-end-2024');
  if (bb) {
    const urls = art.candidatesFor(bb, {}, all, { mezzanine: true }).map(c => c.url).filter(Boolean);
    assert.ok(urls.some(u => /ambassadors/i.test(u)), `the Ambassadors Theatre art is a candidate: ${urls}`);
    const rejected = { ...bb, rejectedImageUrls: urls };
    assert.ok(!art.candidatesFor(bb, {}, all).some(c => c.url && /ambassadors/i.test(c.url)), 'score cards never use Mezzanine art');
    assert.ok(!art.candidatesFor(rejected, {}, all, { mezzanine: true }).some(c => c.url && /ambassadors/i.test(c.url)), 'a rejected image is never a candidate');
  }
});

test('compare: caption links carry raw ampersands, never HTML-escaped ones', () => {
  for (const text of Object.values(compare().captions)) assert.ok(!/&amp;/.test(text));
  assert.match(compare().captions.facebook, /\?utm_source=facebook&utm_medium=social&utm_campaign=brief/);
});

test('compare dedupe: a second pair with the same newer production never adopts the first pair\'s post', () => {
  const cap = require('./social-autopost/captions.js');
  const text = compare().captions.twitter;
  const newer = offb;
  assert.ok(cap.compareMarkers(newer, cap.productionLabel(london)).every(m => m.test(text)));
  assert.ok(!cap.compareMarkers(newer, 'Broadway 2019').every(m => m.test(text)), 'another older production must not match');
  assert.ok(cap.compareMarkers(newer).every(m => m.test(text)), 'ledger entries from before olderLabel still match');
});

// ---- London comparison posts (BRO-6373): strict matcher, selection rules, posting ----
const td = require('./lib/transfer-detection.js');
const lshow = (id, title, category, type, openingDate, over = {}) => ({ id, slug: id, title, category, type, status: 'closed', venue: 'V', openingDate, ...over });
const scored = ids => ({ hasScore: id => ids.includes(id) });
const find = (s, all, ids = all.map(x => x.id)) => td.findLondonRun(s, all, scored(ids));

test('london matcher: one same-type London run 0-5 years earlier with scores matches; previews date is the fallback', () => {
  const ny = lshow('bb-off-broadway-2026', 'The Curious Case of Benjamin Button', 'off-broadway', 'musical', '2026-10-21');
  const we = lshow('bb-west-end-2024', 'The Curious Case of Benjamin Button', 'west-end', 'musical', null, { previewsStartDate: '2024-10-10' });
  const r = find(ny, [ny, we]);
  assert.equal(r.london && r.london.id, we.id);
  assert.deepEqual(td.detectLondonComparePairs([ny, we], scored([ny.id, we.id])), [{ showId: ny.id, londonId: we.id, reason: r.reason }]);
  // The same day, or a few days after New York, is still "0 years earlier"; a London run that comes later is not.
  assert.ok(find(ny, [ny, { ...we, openingDate: '2026-10-21' }]).london);
  assert.equal(find(ny, [ny, { ...we, openingDate: '2026-11-01' }]).london, null);
});

test('london matcher: more than one candidate, a different type, a revival, a long gap or a missing score match nothing', () => {
  const ny = lshow('medea-off-broadway-2026', 'Medea', 'off-broadway', 'play', '2026-09-01');
  const opera = lshow('medea-opera-west-end-2025', 'Medea', 'west-end', 'opera', '2025-06-01');
  assert.match(find(ny, [ny, opera]).reason, /different type \(play vs opera\)/);
  const play = lshow('medea-west-end-2025', 'Medea', 'west-end', 'play', '2025-03-01');
  assert.match(find(ny, [ny, opera, play]).reason, /ambiguous/); // the opera counts toward "exactly one"
  const many = ['2022', '2025', '2026'].map(y => lshow(`much-ado-we-${y}`, 'Much Ado About Nothing', y === '2026' ? 'off-west-end' : 'west-end', 'play', `${y}-05-01`));
  const ado = lshow('much-ado-2026', 'Much Ado About Nothing', 'broadway', 'play', '2026-10-01');
  assert.match(find(ado, [ado, ...many]).reason, /ambiguous/);
  const one = lshow('x-we', 'Giant', 'west-end', 'play', '2025-01-01');
  const gi = lshow('giant-2026', 'Giant', 'broadway', 'play', '2026-10-01');
  assert.ok(find(gi, [gi, one]).london);
  assert.match(find({ ...gi, isRevival: true }, [gi, one]).reason, /classic revival/);
  assert.match(find(gi, [gi, { ...one, originalProductionId: 'giant-1998' }]).reason, /classic revival/);
  assert.match(find(gi, [gi, { ...one, openingDate: '2019-01-01' }]).reason, /years earlier/);
  assert.match(find(gi, [gi, one], [gi.id]).reason, /no Critic Score/);
  assert.match(find(gi, [gi, one], [one.id]).reason, /no Critic Score/);
  assert.match(find({ ...gi, type: null }, [gi, one]).reason, /different type/);
  assert.match(find(gi, [gi, { ...one, openingDate: null, previewsStartDate: null }]).reason, /no opening or previews date/);
  // Only Broadway and Off-Broadway shows look for a London run; a different title never matches.
  assert.match(find(one, [gi, one]).reason, /not a Broadway/);
  assert.match(find(gi, [gi, { ...one, title: 'Giants' }]).reason, /no London run/);
});

test('london matcher on the real data: Benjamin Button matches, the known false-positive traps do not', { skip: !fs.existsSync(new URL('../data/shows.json', import.meta.url)) }, () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../data/shows.json', import.meta.url), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const hasScore = () => true; // the traps must fail on their own, not for want of a score
  const run = id => td.findLondonRun(shows.find(s => s.id === id), shows, { hasScore });
  assert.equal(run('the-curious-case-of-benjamin-button-off-broadway-2026').london.id, 'the-curious-case-of-benjamin-button-west-end-2024');
  for (const id of ['medea-off-broadway-2026', 'othello-off-broadway-2026', 'much-ado-about-nothing-2026', 'giant-2026', 'romeo-and-juliet-off-broadway-2026']) {
    const s = shows.find(x => x.id === id);
    if (s) assert.equal(run(id).london, null, `${id} must not match: ${run(id).reason}`);
  }
});

// ---- selection ----
const NYC = 'America/New_York';
const lc = {
  ny: lshow('lc-2026', 'Lc', 'broadway', 'play', '2026-10-01', { status: 'open' }),
  we: lshow('lc-west-end-2025', 'Lc', 'west-end', 'play', '2025-03-01'),
};
const lcSlim = { [lc.ny.id]: { cs: 80, rc: 20 }, [lc.we.id]: { cs: 84, rc: 30 } };
const scorePost = (over = {}) => ({ type: 'score', showId: lc.ny.id, dueAt: '2026-10-20T14:00:00.000Z', channels: { twitter: { postId: 'p1' } }, ...over });
const lcFind = (ledger, now) => sel.findLondonCompareEvents({ shows: [lc.ny, lc.we], ledger, now, slim: lcSlim });
const at = iso => Date.parse(iso);

test('london-compare is due 10:00 New York time the morning after the score post went out', () => {
  const ledger = { posts: [scorePost()] };
  assert.equal(lcFind(ledger, at('2026-10-20T20:00:00Z')).length, 0); // the day of the score post
  assert.equal(lcFind(ledger, at('2026-10-21T12:30:00Z')).length, 0); // 08:30 local: more than the 70-minute creation lead early
  const [ev] = lcFind(ledger, at('2026-10-21T14:00:00Z')); // 10:00 EDT
  assert.equal(ev.type, 'london-compare');
  assert.equal(ev.show.id, lc.ny.id);
  assert.equal(ev.london.id, lc.we.id);
  assert.equal(ev.dueAt.toISOString(), '2026-10-21T14:00:00.000Z');
});

test('london-compare waits for a score post that really went out, and is dropped after the lookback', () => {
  const t = at('2026-10-21T15:00:00Z');
  assert.equal(lcFind({ posts: [] }, t).length, 0);
  assert.equal(lcFind({ posts: [scorePost({ skipped: 'backlog at go-live', channels: undefined })] }, t).length, 0);
  assert.equal(lcFind({ posts: [scorePost({ channels: {} })] }, t).length, 0);
  assert.equal(sel.londonCompareDecision(lc.ny, { shows: [lc.ny, lc.we], ledger: { posts: [scorePost()] }, now: t, slim: {}, done: new Set() }).why, 'no-london-run'); // no Critic Score on the site
  assert.equal(lcFind({ posts: [scorePost()] }, at('2026-10-21T14:00:00Z') + 6 * 864e5).length, 0);
  assert.equal(lcFind({ posts: [scorePost()] }, at('2026-10-21T14:00:00Z') + 4 * 864e5).length, 1);
});

test('london-compare never repeats: its own ledger key, or a brief for the same pair, stops it', () => {
  const t = at('2026-10-21T15:00:00Z');
  const done = { posts: [scorePost(), { type: 'london-compare', id: `london-compare:${lc.ny.id}`, showId: lc.ny.id }] };
  assert.equal(lcFind(done, t).length, 0);
  assert.ok(sel.doneKeys(done).has(`london-compare:${lc.ny.id}`));
  const brief = { posts: [scorePost(), { type: 'brief', id: 'brief:abc', hash: 'abc', pair: briefs.pairKey([lc.ny.id, lc.we.id]), dueAt: '2026-09-01T14:00:00Z' }] };
  assert.equal(lcFind(brief, t).length, 0); // even a brief older than the 30-day pair dedupe
  assert.equal(sel.londonCompareDecision(lc.ny, { shows: [lc.ny, lc.we], ledger: brief, now: t, slim: lcSlim, done: sel.doneKeys(brief) }).why, 'brief-exists');
  const other = { posts: [scorePost(), { type: 'brief', id: 'brief:def', hash: 'def', pair: 'a+b' }] };
  assert.equal(lcFind(other, t).length, 1);
});

test('london-compare lookback lists matches with the score post state; only a sent score post would fire', () => {
  const now = at('2026-10-27T12:00:00Z');
  const rows = ledger => sel.londonCompareLookback({ shows: [lc.ny, lc.we], ledger, now, slim: lcSlim, days: 90 });
  assert.deepEqual(rows({ posts: [] }).map(r => [r.show.id, r.scorePost, r.wouldFire]), [[lc.ny.id, 'none', false]]);
  assert.equal(rows({ posts: [{ type: 'score', showId: lc.ny.id, skipped: 'backlog at go-live' }] })[0].scorePost, 'skipped (backlog at go-live)');
  assert.equal(rows({ posts: [scorePost()] })[0].wouldFire, true);
  assert.equal(sel.londonCompareLookback({ shows: [lc.ny, lc.we], ledger: { posts: [] }, now, slim: lcSlim, days: 10 }).length, 0); // opened 26 days ago
});

test('london-compare ledger entries use the compare markers, so a retry never adopts a score post', () => {
  const m = entryMarkers({ type: 'london-compare', slug: 'lc', olderLabel: 'London 2025' });
  assert.equal(m.length, 3);
  assert.ok(m.some(re => re.source === cap.COMPARE_SENTENCE.source));
  assert.ok(!m.some(re => re.source === cap.SCORE_SENTENCE.source));
});

// ---- posting through a fake Buffer server (never the live API: the quota is shared) ----
async function withFakeBuffer(remaining, existing, fn) {
  const http = require('http');
  const seen = { created: [], listings: 0, requests: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.requests++;
      const { query, variables } = JSON.parse(body);
      let data;
      if (/createPost/.test(query)) {
        seen.created.push(variables.input);
        data = { createPost: { post: { id: `new-${seen.created.length}`, dueAt: variables.input.dueAt, status: 'scheduled' } } };
      } else if (variables.input && variables.input.filter && variables.input.filter.dueAt) {
        seen.listings++;
        data = { posts: { edges: existing.map(node => ({ node })), pageInfo: { hasNextPage: false } } };
      } else if (/organizations/.test(query)) {
        data = { account: { organizations: [] } };
      } else {
        data = { channels: [] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Ratelimit-Remaining': String(remaining), 'X-Ratelimit-Reset': '1793051582' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = { url: process.env.BUFFER_API_URL, key: process.env.BUFFER_API_KEY };
  process.env.BUFFER_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.BUFFER_API_KEY = 'fake';
  try {
    await fn(seen);
  } finally {
    for (const [k, v] of [['BUFFER_API_URL', saved.url], ['BUFFER_API_KEY', saved.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise(r => server.close(r));
  }
}
const lcChannels = ['instagram', 'facebook', 'twitter', 'threads', 'bluesky'].map(s => ({ id: `ch-${s}`, key: s, service: s, network: s, set: 'broadway', organizationId: 'org' }));
const lcLedger = () => ({ _meta: { bufferValidatedChannels: lcChannels.map(c => c.id) }, posts: [scorePost()] });
const lcPost = async (ctxLedger, now = at('2026-10-21T14:05:00Z')) => {
  const run = require('./social-autopost/run.js');
  await bufferLib.listChannels().catch(() => {}); // lets the fake report its quota headers first, as allowedChannels does in a real run
  const built = briefs.buildCompare({ descA: desc(lc.we, 84, 30), descB: desc(lc.ny, 80, 20), hook: '', now });
  const summary = [], problems = [];
  await run.postCompare({
    label: `london-compare:${lc.ny.id}`, shows: [built.older.show, built.newer.show], newer: built.newer.show, olderLabel: cap.productionLabel(built.older.show),
    captions: built.captions, imageUrl: 'https://img.example/x.jpg', ctx: { ledger: ctxLedger, ledgerFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ledger-')), 'ledger.json') }, buffer: bufferLib, channels: lcChannels, now,
    earliest: at('2026-10-21T14:00:00Z'), summary, problems,
    entry: { type: 'london-compare', id: `london-compare:${lc.ny.id}`, showId: lc.ny.id, template: 'compare', pair: briefs.pairKey([lc.ny.id, lc.we.id]), auto: true },
  });
  return { summary, problems };
};

test('london-compare posts the compare card on all five networks and records london-compare:<showId>', async () => {
  const ledger = lcLedger();
  const run = require('./social-autopost/run.js');
  await withFakeBuffer(240, [{ id: 'p1', text: `Lc https://broadwayscorecard.com/show/${lc.ny.slug}?utm_source=twitter`, status: 'sent', dueAt: '2026-10-20T14:00:00.000Z' }], async seen => {
    await lcPost(ledger);
    assert.equal(seen.created.length, 5);
    const x = seen.created.find(i => i.channelId === 'ch-twitter');
    assert.match(x.text, /Lc was also reviewed in London\./);
    assert.doesNotMatch(x.text, /transfer/i);
    assert.match(x.text, /different cities, with different critics/);
    assert.match(x.text, /utm_campaign=brief/);
  });
  const entry = ledger.posts.find(p => p.type === 'london-compare');
  assert.equal(entry.id, `london-compare:${lc.ny.id}`);
  assert.equal(entry.showId, lc.ny.id);
  assert.deepEqual(entry.showIds, [lc.we.id, lc.ny.id]);
  assert.equal(entry.auto, true);
  assert.deepEqual(Object.keys(entry.channels).sort(), ['bluesky', 'facebook', 'instagram', 'threads', 'twitter']);
  assert.ok(sel.doneKeys(ledger).has(`london-compare:${lc.ny.id}`));
  // Next day, 10:00 New York time or later, never before the morning after the score post.
  assert.ok(Date.parse(entry.dueAt) >= at('2026-10-21T14:00:00Z'));

});

test('london-compare obeys the quota guard: too few Buffer requests left creates nothing', async () => {
  const ledger = lcLedger();
  await withFakeBuffer(5, [], async seen => {
    await assert.rejects(lcPost(ledger), e => e.code === 'QUOTA' && /left under its rate limit/.test(e.message));
    assert.equal(seen.created.length, 0);
    assert.equal(seen.listings, 0); // the guard runs before the cross-lane listing
  });
  assert.equal(ledger.posts.filter(p => p.type === 'london-compare').length, 0);
});

test('london-compare obeys the cross-lane rule: a day that already has a post for either show moves it to the next free day', async () => {
  const ledger = lcLedger();
  const day1 = { id: 'x1', text: `Lc https://broadwayscorecard.com/show/${lc.ny.slug}?utm_source=twitter`, status: 'scheduled', dueAt: '2026-10-21T14:00:00Z' };
  ledger.posts.push({ ...scorePost({ dueAt: '2026-10-21T14:00:00.000Z', channels: { twitter: { postId: 'x1' } } }), type: 'score' });
  await withFakeBuffer(240, [day1], async () => {
    await lcPost(ledger, at('2026-10-21T14:05:00Z'));
  });
  const entry = ledger.posts.find(p => p.type === 'london-compare');
  assert.ok(Date.parse(entry.dueAt) >= at('2026-10-22T13:00:00Z'), `moved off the busy day: ${entry.dueAt}`);
});

test('london-compare keeps the lane name in the social report', () => {
  const social = require('./lib/social-report.js');
  const lanes = social.laneNameOf ? social.laneNameOf('london-compare') : null;
  if (lanes) assert.equal(lanes, 'London comparison posts');
  assert.match(fs.readFileSync(new URL('./lib/social-report.js', import.meta.url), 'utf8'), /'london-compare': 'London comparison posts'/);
});
