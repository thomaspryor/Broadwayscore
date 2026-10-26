// Unit tests for scripts/social-autopost/ (BRO-6242): which posts fire, when,
// that every caption fits its network, and that the card's badge CSS is the
// site's. Offline: no Buffer, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// ---- per-market channel routing (BRO-6378) ----
const routing = require('./social-autopost/routing.js');
const SETS_BOTH = { broadway: { instagram: 'b1' }, 'west-end': { instagram: 'w1' } };
const gateT1 = t1 => ({ counts: { t1 } });

test('routing: West End and Off-West End go to West End channels only, Broadway and Off-Broadway to Broadway only', () => {
  for (const [category, want] of [['west-end', 'west-end'], ['off-west-end', 'west-end'], ['broadway', 'broadway'], ['off-broadway', 'broadway']]) {
    assert.deepEqual(routing.targetSets(show({ category }), gateT1(3), SETS_BOTH, []), [want], category);
  }
});

test('routing: a high-profile show (T1 count or cross-market transfer) also posts to the other market', () => {
  assert.deepEqual(routing.targetSets(show({ category: 'west-end' }), gateT1(8), SETS_BOTH, []), ['west-end', 'broadway']);
  assert.deepEqual(routing.targetSets(show({ category: 'broadway' }), gateT1(7), SETS_BOTH, []), ['broadway']);
  const lon = show({ id: 'lon', category: 'west-end' });
  const nyc = show({ id: 'nyc', category: 'broadway', transferOf: 'lon' });
  assert.deepEqual(routing.targetSets(nyc, gateT1(3), SETS_BOTH, [lon, nyc]), ['broadway', 'west-end']);
  // a transfer within the same market (Off-Broadway -> Broadway) is not cross-market
  const ob = show({ id: 'ob', category: 'off-broadway' });
  assert.deepEqual(routing.targetSets(show({ id: 'bw', transferOf: 'ob' }), gateT1(3), SETS_BOTH, [ob]), ['broadway']);
});

test('routing: West End channels not configured yet -> unchanged behaviour (everything to Broadway)', () => {
  const none = { broadway: { instagram: 'b1' }, 'west-end': {} };
  assert.deepEqual(routing.targetSets(show({ category: 'west-end' }), gateT1(20), none, []), ['broadway']);
  assert.deepEqual(routing.targetSets(show({ category: 'broadway' }), gateT1(20), none, []), ['broadway'], 'no cross-post to an unconfigured set');
});

test('routing: channels are tagged by set; the Broadway ledger key stays the bare service name', () => {
  const tagged = routing.tagChannels([{ id: 'b1', service: 'instagram' }, { id: 'w1', service: 'instagram' }, { id: 'z', service: 'tiktok' }], SETS_BOTH);
  assert.deepEqual(tagged.map(c => [c.set, c.key]), [['broadway', 'instagram'], ['west-end', 'instagram@west-end'], [null, null]]);
});

test('routing: the live config has Broadway channels and routes every eligible category somewhere', () => {
  const C = require('./social-autopost/config.js');
  assert.ok(Object.keys(C.CHANNEL_SETS.broadway).length >= 5);
  for (const cat of C.ELIGIBLE_CATEGORIES) assert.ok(routing.targetSets(show({ category: cat }), gateT1(0)).length >= 1, cat);
});

test('routing: a partly filled West End set is not active; duplicate ids across sets are rejected', () => {
  const part = { broadway: { instagram: 'b1', facebook: 'b2' }, 'west-end': { instagram: 'w1' } };
  assert.deepEqual(routing.targetSets(show({ category: 'west-end' }), gateT1(20), part, []), ['broadway']);
  const dup = { broadway: { instagram: 'b1' }, 'west-end': { instagram: 'b1' } };
  assert.throws(() => routing.tagChannels([{ id: 'b1', service: 'instagram' }], dup), /both 'broadway' and 'west-end'/);
});

test('routing: a transfer link on either end makes both shows high profile', () => {
  const lon = show({ id: 'lon', category: 'west-end' });
  const nyc = show({ id: 'nyc', category: 'broadway', transferOf: 'lon' });
  assert.deepEqual(routing.targetSets(lon, gateT1(3), SETS_BOTH, [lon, nyc]), ['west-end', 'broadway']);
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
