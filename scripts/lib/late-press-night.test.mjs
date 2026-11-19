// BRO-7808: the late press-night decision. Real shapes from Now You See Me Live (2026-11-11 first performance,
// roundup dated 2026-11-18). Run: node --test scripts/lib/late-press-night.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./late-press-night.js');

const NOW = Date.parse('2026-11-19T03:00:00Z');
const show = { id: 'now-you-see-me-live-2026', title: 'Now You See Me Live', category: 'broadway', status: 'open', openingDate: '2026-11-11' };
const ROUNDUP = 'https://www.broadwayworld.com/article/Review-Roundup-NOW-YOU-SEE-ME-LIVE-Opens-on-Broadway-20261118';
const tierOf = (r) => ({ nyt: 1, timeout: 1, tmania: 2, blog: 3 }[r.outletId] || 3);
const rv = (outletId, publishDate) => ({ showId: show.id, outletId, publishDate, url: `https://x.test/${outletId}` });

test('live BWW roundup for an unwatched show routes to the coordinator, marker is per show and day', () => {
  const d = L.decideLatePressNight({ show, roundupUrl: ROUNDUP, nowMs: NOW });
  assert.equal(d.action, 'route-coordinator');
  assert.equal(d.signal, 'bww-roundup');
  assert.equal(d.day, '2026-11-18');
  assert.equal(d.marker, 'late-press-night:now-you-see-me-live-2026:2026-11-18');
  assert.match(L.alertText(show, d), /opening-night-lane-live\.yml/);
  assert.doesNotMatch(L.alertText(show, d), /set reviewEmbargoAt/i);
});

test('three tier 1/2 reviews on one recent day, including a full timestamp, route; the same three blog posts do not', () => {
  const t12 = [rv('nyt', '2026-11-18T00:59:02.000Z'), rv('timeout', '2026-11-18'), rv('tmania', '2026-11-18')];
  const d = L.decideLatePressNight({ show, reviews: t12, nowMs: NOW, tierOf });
  assert.equal(d.action, 'route-coordinator');
  assert.equal(d.signal, 'tier12-burst');
  assert.equal(d.day, '2026-11-18');
  const blogs = [rv('blog', '2026-11-18'), rv('blog', '2026-11-18'), rv('blog', '2026-11-18')];
  assert.equal(L.decideLatePressNight({ show, reviews: blogs, nowMs: NOW, tierOf }).action, 'none');
});

test('a watched show, an unreadable lease, a young press night, off-Broadway and a stale roundup all stay quiet', () => {
  const base = { show, roundupUrl: ROUNDUP, nowMs: NOW };
  assert.equal(L.decideLatePressNight({ ...base, lease: { holder: 'lane' } }).action, 'none');
  const unknown = L.decideLatePressNight({ ...base, lease: { unknown: true } });
  assert.equal(unknown.action, 'none');
  assert.match(unknown.reason, /unreadable/);
  assert.equal(L.decideLatePressNight({ ...base, show: { ...show, openingDate: '2026-11-17' } }).action, 'none');
  assert.equal(L.decideLatePressNight({ ...base, show: { ...show, category: 'off-broadway' } }).action, 'none');
  assert.equal(L.decideLatePressNight({ ...base, roundupUrl: ROUNDUP.replace('20261118', '20261105') }).action, 'none');
  assert.equal(L.decideLatePressNight({ ...base, roundupUrl: null }).action, 'none');
});

test('a week-one trickle on top of a normal press night is not a late press night', () => {
  const rows = [rv('nyt', '2026-11-12'), rv('timeout', '2026-11-12'), rv('tmania', '2026-11-12'), rv('nyt', '2026-11-13'), rv('blog', '2026-11-12'), rv('nyt', '2026-11-18'), rv('timeout', '2026-11-18'), rv('tmania', '2026-11-18')];
  assert.equal(L.decideLatePressNight({ show: { ...show, openingDate: '2026-11-12' }, reviews: rows, nowMs: NOW, tierOf }).action, 'none');
});

test('roundupDayFromUrl reads the BWW date suffix only', () => {
  assert.equal(L.roundupDayFromUrl(ROUNDUP), '2026-11-18');
  assert.equal(L.roundupDayFromUrl('https://www.broadwayworld.com/article/Review-Roundup-X'), null);
  assert.equal(L.roundupDayFromUrl(null), null);
});
