// Unit tests for scripts/social-autopost/ (BRO-6242): which posts fire, when,
// and that every caption fits its network. Offline: no Buffer, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sel = require('./social-autopost/select.js');
const { buildCaptions, postMarkers, atVenue, LIMITS } = require('./social-autopost/captions.js');
const { chooseLayout, originalUrl } = require('./social-autopost/art.js');
const { buildCardHtml } = require('./social-autopost/render.js');
const { metadataFor } = require('./social-autopost/buffer.js');

const getOutletTier = id => Number(id.split('-')[0].slice(1));
const reviews = (t1, t2, t3) => [
  ...Array.from({ length: t1 }, (_, i) => ({ outletId: `t1-${i}`, assignedScore: 85, scoreConfidence: 'high' })),
  ...Array.from({ length: t2 }, (_, i) => ({ outletId: `t2-${i}`, assignedScore: 80, scoreConfidence: 'high' })),
  ...Array.from({ length: t3 }, (_, i) => ({ outletId: `t3-${i}`, assignedScore: 75, scoreConfidence: 'high' })),
];
const show = over => ({ id: 'x-2026', slug: 'x', title: 'X', category: 'broadway', type: 'musical', status: 'open', venue: 'Palace Theatre', openingDate: '2026-11-05', ...over });
const empty = { posts: [] };

test('zonedTime handles both sides of a DST change', () => {
  assert.equal(sel.zonedTime('2026-07-01', 12, 'America/New_York').toISOString(), '2026-07-01T16:00:00.000Z');
  assert.equal(sel.zonedTime('2026-12-01', 12, 'America/New_York').toISOString(), '2026-12-01T17:00:00.000Z');
  assert.equal(sel.zonedTime('2026-07-01', 12, 'Europe/London').toISOString(), '2026-07-01T11:00:00.000Z');
});

test('opening post: queued up to 6h ahead of noon local, dropped after 18:00 on the day', () => {
  const s = show();
  const at = iso => sel.findOpeningEvents({ shows: [s], history: empty, now: Date.parse(iso) });
  assert.equal(at('2026-11-05T10:00:00Z').length, 0, 'too early');
  const ev = at('2026-11-05T12:00:00Z');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].dueAt.toISOString(), '2026-11-05T17:00:00.000Z'); // noon EST
  assert.equal(at('2026-11-05T23:30:00Z').length, 0, 'after 18:00 local');
  assert.equal(sel.findOpeningEvents({ shows: [s], history: { posts: [{ type: 'opening', showId: s.id }] }, now: Date.parse('2026-11-05T12:00:00Z') }).length, 0, 'deduped');
});

test('off-Broadway openings post only at major houses; opera and provisional shows never', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const ids = sel.findOpeningEvents({ now, history: empty, shows: [
    show({ id: 'a', category: 'off-broadway', venue: 'The Public Theater/LuEsther Hall' }),
    show({ id: 'b', category: 'off-broadway', venue: 'SoHo Playhouse' }),
    show({ id: 'c', type: 'opera' }),
    show({ id: 'd', provisional: true }),
    show({ id: 'e', category: 'off-west-end', venue: 'Hampstead Theatre Downstairs' }),
    show({ id: 'f', category: 'off-west-end', venue: 'Almeida Theatre' }),
  ] }).map(e => e.show.id);
  assert.deepEqual(ids.sort(), ['a', 'f']);
});

test('score post needs the confidence gate, the slim score, and a recent opening', () => {
  const s = show({ openingDate: '2026-10-20' });
  const base = { shows: [s], history: empty, now: Date.parse('2026-10-25T15:00:00Z'), slim: { [s.id]: { cs: 81.6, rc: 14 } }, getOutletTier };
  assert.equal(sel.findScoreEvents({ ...base, reviewsByShow: { [s.id]: reviews(3, 3, 8) } }).length, 1);
  assert.equal(sel.findScoreEvents({ ...base, reviewsByShow: { [s.id]: reviews(2, 3, 9) } }).length, 0, 'T1 short');
  assert.equal(sel.findScoreEvents({ ...base, reviewsByShow: { [s.id]: reviews(3, 3, 8) }, slim: {} }).length, 0, 'no site score yet');
  assert.equal(sel.findScoreEvents({ ...base, now: Date.parse('2026-11-30T15:00:00Z'), reviewsByShow: { [s.id]: reviews(3, 3, 8) } }).length, 0, 'too old');
});

test('Off-West End score posts need 10 reviews with 5 from tier 1', () => {
  const s = show({ category: 'off-west-end', openingDate: '2026-10-20' });
  const base = { shows: [s], history: empty, now: Date.parse('2026-10-25T12:00:00Z'), slim: { [s.id]: { cs: 75, rc: 12 } }, getOutletTier };
  assert.equal(sel.findScoreEvents({ ...base, reviewsByShow: { [s.id]: reviews(4, 3, 5) } }).length, 0);
  assert.equal(sel.findScoreEvents({ ...base, reviewsByShow: { [s.id]: reviews(5, 3, 4) } }).length, 1);
});

test('score posts wait for daytime and are spaced apart', () => {
  // 03:00 New York -> next 09:00 local
  assert.equal(sel.nextScoreSlot(Date.parse('2026-10-25T07:00:00Z'), 'America/New_York').toISOString(), '2026-10-25T13:00:00.000Z');
  const now = Date.parse('2026-10-25T15:00:00Z');
  const evs = [show({ id: 'a' }), show({ id: 'b' }), show({ id: 'c' })].map(s => ({ type: 'score', show: s, dueAt: new Date(now + 6e5) }));
  sel.staggerEvents(evs, empty, now);
  const t = evs.map(e => e.dueAt.getTime()).sort();
  assert.ok(t[1] - t[0] >= 90 * 6e4 && t[2] - t[1] >= 90 * 6e4);
});

test('first live run skips score backlog older than 3 days, keeps openings', () => {
  const now = Date.parse('2026-10-25T15:00:00Z');
  const old = { type: 'score', show: show({ id: 'old', openingDate: '2026-10-10' }) };
  const fresh = { type: 'score', show: show({ id: 'fresh', openingDate: '2026-10-23' }) };
  const opening = { type: 'opening', show: show({ id: 'op', openingDate: '2026-10-26' }) };
  const r = sel.splitBacklog([old, fresh, opening], empty, now);
  assert.deepEqual(r.skip.map(e => e.show.id), ['old']);
  assert.deepEqual(r.post.map(e => e.show.id), ['fresh', 'op']);
  const later = sel.splitBacklog([old], { posts: [{ type: 'score', showId: 'z' }] }, now);
  assert.equal(later.post.length, 1, 'only the very first run skips');
});

test('captions fit every network, carry the site numbers, and use no em dashes', () => {
  const s = show({ title: 'The Extraordinarily Long-Winded Musical Adventure of Somebody and Everybody Else Too', venue: 'Lunt-Fontanne Theatre' });
  for (const p of [
    { type: 'score', show: s, score: 86, tierId: 'must-see', tierLabel: 'Critical Gold', reviewCount: 38, breakdown: { positive: 30, mixed: 6, negative: 2 } },
    { type: 'opening', show: s },
  ]) {
    const c = buildCaptions(p);
    for (const net of Object.keys(LIMITS)) {
      assert.ok(c[net].length <= LIMITS[net], `${p.type} ${net} ${c[net].length}`);
      assert.ok(!c[net].includes('—'), `${net} em dash`);
    }
    assert.ok(c.twitter.length <= 270);
    if (p.type === 'score') {
      assert.match(c.facebook, /Critic Score of 86 \(Critical Gold\) from 38 critics' reviews/);
      assert.match(c.facebook, /30 positive, 6 mixed, 2 negative/);
    }
    assert.match(c.facebook, /https:\/\/broadwayscorecard\.com\/show\/x\?utm_source=facebook/);
    assert.ok(!/https?:\/\//.test(c.instagram), 'Instagram captions cannot link');
    for (const net of Object.keys(LIMITS)) {
      for (const m of postMarkers(p.type, s)) assert.ok(c[net].includes(m), `${net} lacks dedupe marker ${m}`);
    }
  }
});

test('venue phrasing', () => {
  assert.equal(atVenue('Palace Theatre'), 'at the Palace Theatre');
  assert.equal(atVenue('The Public Theater/LuEsther Hall'), 'at The Public Theater/LuEsther Hall');
  assert.equal(atVenue("Shakespeare's Globe"), "at Shakespeare's Globe");
  assert.equal(atVenue('Riverside Studios'), 'at Riverside Studios');
});

test('art layout never upscales: square key art >=1000px, else native-size inset, else type', () => {
  assert.equal(chooseLayout([{ role: 'square', width: 1080, height: 1080 }]).layout, 'keyart');
  assert.equal(chooseLayout([{ role: 'square', width: 540, height: 540 }, { role: 'poster', width: 480, height: 720 }]).layout, 'inset');
  assert.equal(chooseLayout([{ role: 'square', width: 540, height: 540 }, { role: 'poster', width: 480, height: 720 }]).pick.role, 'square');
  assert.equal(chooseLayout([{ role: 'poster', width: 300, height: 450 }]).layout, 'type');
  assert.equal(originalUrl('https://images.ctfassets.net/a/b/c/x.jpg?w=1920&h=800&fm=webp'), 'https://images.ctfassets.net/a/b/c/x.jpg');
});

test('card HTML escapes text and only scales inset art down', () => {
  const html = buildCardHtml({ event: 'score', market: 'broadway', title: '<b>Tom & Jerry</b>', score: 77, tierId: 'recommended', tierLabel: 'Recommended', reviewCount: 20,
    art: { layout: 'inset', dataUri: 'data:image/png;base64,AA', width: 400, height: 600 } });
  assert.ok(html.includes('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;'));
  assert.match(html, /width:400px;height:600px/);
});

test('Buffer metadata: Instagram and Facebook get the required post type', () => {
  assert.deepEqual(metadataFor('instagram'), { instagram: { type: 'post', shouldShareToFeed: true } });
  assert.deepEqual(metadataFor('facebook'), { facebook: { type: 'post' } });
  assert.equal(metadataFor('bluesky'), undefined);
});

test('a network that failed is retried, at most 3 attempts and within 12h of the slot', () => {
  const { pendingRetries } = require('./social-autopost/run.js');
  const now = Date.parse('2026-11-05T16:00:00Z');
  const e = over => ({ type: 'score', showId: 'x', dueAt: '2026-11-05T15:00:00Z', pending: { bluesky: 't' }, attempts: 1, ...over });
  assert.equal(pendingRetries({ posts: [e()] }, now).length, 1);
  assert.equal(pendingRetries({ posts: [e({ attempts: 3 })] }, now).length, 0, 'gave up');
  assert.equal(pendingRetries({ posts: [e({ dueAt: '2026-11-04T15:00:00Z' })] }, now).length, 0, 'stale');
  assert.equal(pendingRetries({ posts: [e({ pending: {} }), { type: 'score', showId: 'y', skipped: 'backlog' }] }, now).length, 0);
});
