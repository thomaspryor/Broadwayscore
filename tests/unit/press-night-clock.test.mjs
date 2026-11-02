// BRO-6802: the punctual press-night clock plans kicks from show data, never from a cron tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planKicks, nextKick, sleepPlan, kickKey, KICK_LEAD_MIN } = require('../../scripts/lib/press-night-clock.js');

const show = (id, openingDate, category = 'broadway', extra = {}) => ({ id, openingDate, category, status: 'previews', ...extra });
const SHOWS = [
  show('b-nov9', '2026-11-09'),
  show('a-nov8', '2026-11-08'),
  show('ob-nov4', '2026-11-04', 'off-broadway'),
  show('we-nov10', '2026-11-10', 'west-end'),
  show('closed-one', '2026-11-08', 'broadway', { status: 'closed' }),
];
const T = (iso) => Date.parse(iso);

test('kick is embargo -2h (22:00 ET = 03:00Z after DST ends), earliest first, broadway only by default', () => {
  const k = planKicks(SHOWS, T('2026-11-02T12:00:00Z'));
  assert.deepEqual(k.map((x) => x.showId), ['a-nov8', 'b-nov9']);
  assert.equal(new Date(k[0].kickAtMs).toISOString(), '2026-11-09T01:00:00.000Z');
  assert.equal(Date.parse(k[0].embargoAt) - k[0].kickAtMs, KICK_LEAD_MIN * 60000);
});

test('off-broadway is only planned when asked for; west-end and closed shows never', () => {
  const k = planKicks(SHOWS, T('2026-11-02T12:00:00Z'), { categories: ['broadway', 'off-broadway'] });
  assert.deepEqual(k.map((x) => x.showId), ['ob-nov4', 'a-nov8', 'b-nov9']);
});

test('fired kicks are skipped and a late tick still kicks until embargo +2h50', () => {
  const fired = [kickKey('a-nov8', '2026-11-08')];
  assert.equal(nextKick(SHOWS, T('2026-11-09T00:00:00Z'), { fired }).showId, 'b-nov9');
  assert.equal(nextKick(SHOWS, T('2026-11-09T05:30:00Z')).showId, 'a-nov8'); // embargo +2.5h: late but still useful
  assert.equal(nextKick(SHOWS, T('2026-11-09T06:00:00Z')).showId, 'b-nov9'); // a-nov8 is past +2h50
});

test('nothing beyond the horizon, no shows gives null', () => {
  assert.equal(nextKick(SHOWS, T('2026-10-01T00:00:00Z')), null);
  assert.equal(nextKick([], Date.now()), null);
});

test('an embargo override moves the kick', () => {
  const s = [show('o', '2026-11-09', 'broadway', { reviewEmbargoAt: '2026-11-10T01:30:00Z' })];
  const k = nextKick(s, T('2026-11-08T00:00:00Z'));
  assert.equal(new Date(k.kickAtMs).toISOString(), '2026-11-09T23:30:00.000Z');
});

test('sleepPlan sleeps straight to a near kick and rechains for a far one', () => {
  const now = T('2026-11-02T00:00:00Z');
  assert.deepEqual(sleepPlan(now + 3 * 3600000, now), { sleepMs: 3 * 3600000, action: 'kick' });
  assert.deepEqual(sleepPlan(now + 9 * 3600000, now), { sleepMs: 300 * 60000, action: 'rechain' });
  assert.deepEqual(sleepPlan(now - 1000, now), { sleepMs: 0, action: 'kick' });
});

test('express preemption spares orchestrator runs targeted at another show (BRO-6802)', () => {
  const ep = require('../../scripts/lib/express-preemption.js');
  const wf = 'opening-night-orchestrator.yml';
  assert.equal(ep.shouldCancel(wf, 'Opening Night Orchestrator targeted a-show (broadway)', 'b-show'), false);
  assert.equal(ep.shouldCancel(wf, 'Opening Night Orchestrator targeted a-show (broadway)', 'a-show'), true);
  assert.equal(ep.shouldCancel(wf, 'Opening Night Orchestrator (broadway)', 'b-show'), true);
  assert.deepEqual(ep.planRedispatch(wf, 'Opening Night Orchestrator targeted a-show (broadway)').fields, { market: 'broadway', show_id: 'a-show' });
});
