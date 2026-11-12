// BRO-7413: the Broadway accounts post Broadway and notable Off-Broadway shows only; official-account tags.
// Offline and hermetic: every show, slim file and handle below is a fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sel = require('./select.js');
const C = require('./config.js');
const { targetSets } = require('./routing.js');
const { socialNotable } = require('./notable.js');
const { withShowTags } = require('./tags.js');

const getOutletTier = id => Number(id.split('-')[0].slice(1));
const reviews = (t1, t2, t3) => [
  ...Array.from({ length: t1 }, (_, i) => ({ outletId: `t1-${i}`, assignedScore: 85, scoreConfidence: 'high' })),
  ...Array.from({ length: t2 }, (_, i) => ({ outletId: `t2-${i}`, assignedScore: 80, scoreConfidence: 'high' })),
  ...Array.from({ length: t3 }, (_, i) => ({ outletId: `t3-${i}`, assignedScore: 75, scoreConfidence: 'high' })),
];
const show = over => ({ id: 'x-2026', slug: 'x', title: 'X', category: 'broadway', type: 'musical', status: 'open', venue: 'Palace Theatre', openingDate: '2026-11-05', ...over });
// The site's public show file, as notable.js reads it: rc, cs, rv[].t, au.sources[].c.
const pub = (t1, t2, t3, audience = 0) => ({ cs: 81.6, rc: t1 + t2 + t3, rv: [...Array(t1).fill({ t: 1 }), ...Array(t2).fill({ t: 2 }), ...Array(t3).fill({ t: 3 })], au: { sources: { ss: { c: audience } } } });
const NOW = Date.parse('2026-11-06T15:00:00Z');
const events = (s, counts, audience) => sel.findScoreEvents({
  shows: [s], ledger: { posts: [] }, now: NOW, getOutletTier,
  slim: { [s.id]: pub(...counts, audience) }, reviewsByShow: { [s.id]: reviews(...counts) },
});

test('a Broadway show posts', () => {
  assert.equal(events(show(), [3, 3, 8]).length, 1);
});

test('an off-Broadway show posts only with 4+ tier-1 critics or 500+ audience (BRO-7423)', () => {
  const ob = (id, over) => show({ id, category: 'off-broadway', venue: 'The Public Theater', openingDate: '2026-11-05', ...over });
  assert.equal(events(ob('four-t1-2026'), [4, 2, 4]).length, 1, '4 tier-1');
  assert.equal(events(ob('big-aud-2026'), [2, 4, 12], 658).length, 1, '2 tier-1, 658 audience (In the Heights)');
  assert.equal(events(ob('edge-aud-2026'), [1, 3, 6], 500).length, 1, '500 audience is the bar');
  assert.equal(events(ob('slam-2026'), [2, 4, 17], 369).length, 0, '23 reviews, 2 tier-1, 369 audience (Slam Frank)');
  assert.equal(events(ob('many-reviews-2026'), [3, 4, 14], 0).length, 0, '21 reviews, 3 tier-1: review count no longer counts');
  assert.equal(events(ob('revival-2026', { isRevival: true }), [1, 3, 6], 300).length, 0, 'known property with 300 audience no longer posts');
  assert.equal(events(ob('acclaimed-2026', { isRevival: true }), [1, 3, 0], 0).length, 0, 'acclaimed revival no longer posts');
});

test('homepageInclude and homepageExclude still decide off-Broadway posting', () => {
  const ob = over => show({ id: 'ob-2026', category: 'off-broadway', ...over });
  assert.equal(socialNotable(ob({ homepageInclude: true }), { 'ob-2026': pub(0, 1, 2) }), true, 'include forces in');
  assert.equal(socialNotable(ob({ homepageExclude: true }), { 'ob-2026': pub(4, 4, 12, 900) }), false, 'exclude wins');
});

test('a West End show posts nothing to the Broadway accounts, even with enough reviews', () => {
  const we = show({ id: 'we-2026', category: 'west-end', venue: 'Lyric Theatre', openingDate: '2026-11-05' });
  assert.equal(events(we, [6, 4, 10]).length, 0);
  assert.deepEqual(targetSets(we, [], C.CHANNEL_SETS, null, { [we.id]: pub(6, 4, 10) }), []);
});

test('an opera, regional or touring show posts nothing to the Broadway accounts', () => {
  const opera = show({ id: 'opera-2026', category: 'off-broadway', type: 'opera', venue: 'Metropolitan Opera' });
  assert.equal(events(opera, [5, 5, 20]).length, 0);
  for (const category of ['regional', 'tour', 'off-west-end']) {
    const s = show({ id: `${category}-2026`, category, tourLaunchEvidence: true });
    assert.equal(events(s, [5, 5, 20]).length, 0, category);
  }
});

test('a London compare posts only when its New York show qualifies', () => {
  const slim = { 'small-ob-2026': pub(2, 3, 6, 369), 'big-ob-2026': pub(4, 2, 4) };
  for (const [id, want] of [['small-ob-2026', false], ['big-ob-2026', true]]) {
    const s = show({ id, category: 'off-broadway' });
    assert.equal(sel.isEligibleShow(s, { slim }), want, id);
  }
});

test('the weekly roundup lists only shows that qualify', () => {
  const shows = [show({ id: 'b1-2026', openingDate: '2026-11-04' }), show({ id: 'b2-2026', openingDate: '2026-11-04' }),
    show({ id: 'ob-small-2026', category: 'off-broadway', openingDate: '2026-11-04' }), show({ id: 'we1-2026', category: 'west-end', openingDate: '2026-11-04' })];
  const slim = { 'b1-2026': pub(3, 3, 8), 'b2-2026': pub(3, 3, 8), 'ob-small-2026': pub(2, 4, 17, 369), 'we1-2026': pub(6, 4, 10) };
  const reviewsByShow = Object.fromEntries(shows.map(s => [s.id, reviews(3, 3, 8)]));
  const got = sel.roundupCandidates('2026-11-06', 'broadway', { shows, reviewsByShow, slim, getOutletTier });
  assert.deepEqual(got.map(s => s.id).sort(), ['b1-2026', 'b2-2026']);
});

test('opera still routes to its own accounts once they are configured (the gate is the Broadway accounts only)', () => {
  const sets = { ...C.CHANNEL_SETS, opera: { ...Object.fromEntries(Object.keys(C.CHANNEL_SETS.broadway).map(k => [k, `op-${k}`])) } };
  const opera = show({ id: 'opera-2026', category: 'off-broadway', type: 'opera' });
  assert.deepEqual(targetSets(opera, [], sets, null, {}), ['opera']);
});

test('socialNotable: Broadway always, other categories never, no public file means not notable', () => {
  assert.equal(socialNotable(show(), {}), true);
  assert.equal(socialNotable(show({ category: 'off-broadway' }), {}), false);
  const ob = show({ category: 'off-broadway' });
  assert.equal(socialNotable(ob, { 'x-2026': pub(4, 0, 0) }), true);
  assert.equal(socialNotable(ob, { 'x-2026': pub(3, 9, 9, 499) }), false);
  assert.equal(socialNotable(ob, { 'x-2026': pub(0, 0, 0, 500) }), true);
  assert.equal(socialNotable(show({ category: 'west-end' }), { 'x-2026': pub(9, 9, 9) }), false);
});

// ---- tags ----
const handles = {
  'x-2026': {
    instagram: { handle: 'xmusical', verifiedAt: '2026-11-12', source: 'https://x.example' },
    twitter: { handle: 'xmusical', verifiedAt: '2026-11-12', source: 'https://x.example' },
    threads: { handle: 'xmusical', verifiedAt: '2026-11-12', source: 'https://x.example' },
    bluesky: { handle: 'x.bsky.social', verifiedAt: '2026-11-12', source: 'https://x.example' },
    facebook: { handle: 'xmusical', verifiedAt: '2026-11-12', source: 'https://x.example' },
  },
};
const caps = { twitter: 'X scored 81.\n\nhttps://broadwayscorecard.com/x', bluesky: 'b', threads: 't', instagram: 'i', facebook: 'f', altText: 'alt' };

test('Worth Seeing or better with a verified handle is tagged on Instagram, X, Threads and Bluesky, never Facebook', () => {
  for (const score of [65, 70, 75, 90]) {
    const out = withShowTags(caps, show(), score, { handles });
    assert.ok(out.instagram.endsWith('\n\n@xmusical'));
    assert.ok(out.twitter.endsWith('\n\n@xmusical'));
    assert.ok(out.threads.endsWith('\n\n@xmusical'));
    assert.ok(out.bluesky.endsWith('\n\n@x.bsky.social'));
    assert.equal(out.facebook, 'f');
    assert.equal(out.altText, 'alt');
  }
});

test('Mixed and below get no tag; a missing, unverified or malformed handle gets none', () => {
  assert.deepEqual(withShowTags(caps, show(), 64, { handles }), caps);
  assert.deepEqual(withShowTags(caps, show(), 40, { handles }), caps);
  assert.deepEqual(withShowTags(caps, show({ id: 'other-2026' }), 90, { handles }), caps);
  const unverified = { 'x-2026': { instagram: { handle: 'xmusical' } } };
  assert.deepEqual(withShowTags(caps, show(), 90, { handles: unverified }), caps);
  const bad = { 'x-2026': { instagram: { handle: 'x musical!', verifiedAt: '2026-11-12' } } };
  assert.deepEqual(withShowTags(caps, show(), 90, { handles: bad }), caps);
});

test('a tag that would push a caption over its limit is left off that network only', () => {
  const full = { ...caps, twitter: 'a'.repeat(270), threads: 'short' };
  const out = withShowTags(full, show(), 90, { handles });
  assert.equal(out.twitter, full.twitter);
  assert.ok(out.threads.endsWith('@xmusical'));
});

test('tagging never mutates the input captions', () => {
  const before = JSON.stringify(caps);
  withShowTags(caps, show(), 90, { handles });
  assert.equal(JSON.stringify(caps), before);
});

test('handle shape is checked per network (X: 15 chars, no dots)', async () => {
  const { handleFor } = await import('./tags.js');
  const h = { s: { twitter: { handle: 'a.b', verifiedAt: '2026-11-12' }, instagram: { handle: 'a.b', verifiedAt: '2026-11-12' }, threads: { handle: 'x'.repeat(31), verifiedAt: '2026-11-12' } } };
  assert.equal(handleFor(h, 's', 'twitter'), null);
  assert.equal(handleFor(h, 's', 'instagram'), '@a.b');
  assert.equal(handleFor(h, 's', 'threads'), null);
});

// BRO-7417: an owner-approved brief skips the notability gate; automatic lanes keep it.
test('briefChannels: a brief for a non-notable Off-Broadway show routes to broadway, the gated (automatic) route does not', () => {
  const { briefChannels } = require('./run.js');
  const ob = show({ id: 'tiny-ob-2026', category: 'off-broadway', venue: 'A Basement', openingDate: '2026-11-05' });
  const slim = { [ob.id]: pub(1, 1, 2) };
  const channels = [{ id: 'c1', service: 'instagram', set: 'broadway', key: 'instagram' }, { id: 'c2', service: 'twitter', set: 'broadway', key: 'twitter' }];
  assert.ok(!socialNotable(ob, slim), 'fixture is not notable');
  assert.equal(briefChannels(channels, ob, { ungated: true }).length, 2, 'brief posts');
  assert.equal(briefChannels(channels, ob, { slim }).length, 0, 'default (london-compare, roundup, closing) stays gated');
  assert.deepEqual(targetSets(ob, [], C.CHANNEL_SETS, null, slim), [], 'score route stays gated');
});

test('briefChannels: a notable Broadway show routes either way (a notable show, e.g. the NYC side of a london-compare, keeps its channel)', () => {
  const { briefChannels } = require('./run.js');
  const b = show({ id: 'big-2026' });
  const channels = [{ id: 'c1', service: 'instagram', set: 'broadway', key: 'instagram' }];
  assert.equal(briefChannels(channels, b, { slim: { [b.id]: pub(3, 3, 8) } }).length, 1);
  assert.equal(briefChannels(channels, b, { ungated: true }).length, 1);
});

test('class guard: only runBrief passes ungated: true to postCompare (automatic lanes must stay gated)', () => {
  const src = require('fs').readFileSync(require.resolve('./run.js'), 'utf8');
  const hits = [...src.matchAll(/ungated:\s*true/g)];
  assert.equal(hits.length, 1, 'exactly one ungated: true call site');
  const start = src.indexOf('async function runBrief');
  const end = src.indexOf('\nasync function ', start + 1);
  assert.ok(start >= 0 && hits[0].index > start && (end < 0 || hits[0].index < end), 'the call site is inside runBrief');
});

test('a West End brief keeps the pre-BRO-7413 route (Broadway fallback) when ungated; gated it posts nowhere', () => {
  const { briefChannels } = require('./run.js');
  const we = show({ id: 'we-brief-2026', category: 'west-end', venue: 'Lyric Theatre' });
  const channels = [{ id: 'c1', service: 'instagram', set: 'broadway', key: 'instagram' }];
  assert.equal(briefChannels(channels, we, { ungated: true }).length, 1);
  assert.equal(briefChannels(channels, we, { slim: {} }).length, 0);
});
