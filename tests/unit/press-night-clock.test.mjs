// BRO-6802: the punctual press-night clock plans kicks from show data, never from a cron tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planKicks, nextKick, sleepPlan, confirmKick, kickKey, KICK_LEAD_MIN } = require('../../scripts/lib/press-night-clock.js');

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

// BRO-6809: after waking, replan from freshly read data; never kick a stale plan.
test('confirmKick kicks only the same show+night when due; embargo moved later, show gone or swapped replans', () => {
  const planned = { showId: 'a-nov8', night: '2026-11-08' };
  const kickAt = nextKick(SHOWS, T('2026-11-01T00:00:00Z')).kickAtMs;
  assert.equal(confirmKick(SHOWS, kickAt, planned), 'kick');
  assert.equal(confirmKick(SHOWS, kickAt - 1000, planned), 'replan');
  const moved = SHOWS.map((x) => (x.id === 'a-nov8' ? { ...x, embargoOverride: undefined, openingDate: '2026-11-09' } : x));
  assert.equal(confirmKick(moved, kickAt, planned), 'replan');
  assert.equal(confirmKick(SHOWS.filter((x) => x.id !== 'a-nov8'), kickAt, planned), 'replan');
  assert.equal(confirmKick(SHOWS, kickAt, null), 'replan');
  assert.equal(confirmKick(SHOWS, kickAt, planned, { fired: [kickKey('a-nov8', '2026-11-08')] }), 'replan');
});

test('CLI: sleep-plan and confirm print what the workflow reads', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lib = new URL('../../scripts/lib/press-night-clock.js', import.meta.url).pathname;
  const run = (...a) => execFileSync('node', [lib, ...a], { encoding: 'utf8' }).trim();
  assert.equal(run('sleep-plan', '--kick-at=2026-11-03T03:00:00Z', '--now=2026-11-02T22:00:00Z'), '18000 kick');
  assert.equal(run('sleep-plan', '--kick-at=2026-11-09T03:00:00Z', '--now=2026-11-02T22:00:00Z'), '18000 rechain');
  assert.equal(run('sleep-plan', '--kick-at=2026-11-02T21:00:00Z', '--now=2026-11-02T22:00:00Z'), '0 kick');
  const f = join(mkdtempSync(join(tmpdir(), 'pnc-')), 'shows.json');
  writeFileSync(f, JSON.stringify(SHOWS));
  const line = run('next', `--shows-file=${f}`, '--now=2026-11-01T00:00:00Z').split(' ');
  assert.equal(line[0], 'a-nov8');
  assert.equal(run('confirm', `--shows-file=${f}`, '--show=a-nov8', '--night=2026-11-08', `--now=${line[2]}`), 'kick');
  assert.equal(run('confirm', `--shows-file=${f}`, '--show=a-nov8', '--night=2026-11-08', '--now=2026-11-01T00:00:00Z'), 'replan');
});

test('confirmKick: embargo moved earlier kicks at once; another show now first replans; past KICK_LATE replans', () => {
  const planned = { showId: 'a-nov8', night: '2026-11-08' };
  const now = T('2026-11-02T02:00:00Z');
  const earlier = SHOWS.map((x) => (x.id === 'a-nov8' ? { ...x, openingDate: '2026-11-01' } : x));
  assert.equal(confirmKick(earlier, now, { showId: 'a-nov8', night: '2026-11-01' }), 'kick');
  assert.equal(confirmKick(earlier, now, planned), 'replan');
  const late = SHOWS.map((x) => (x.id === 'a-nov8' ? { ...x, openingDate: '2026-10-25' } : x));
  assert.equal(confirmKick(late, now, { showId: 'a-nov8', night: '2026-10-25' }), 'replan');
});
test('workflow uses the CLI sleep plan, chunked sleeps and a bounded replan loop (BRO-6809)', async () => {
  const { readFileSync } = await import('node:fs');
  const y = readFileSync(new URL('../../.github/workflows/press-night-clock.yml', import.meta.url), 'utf8');
  assert.match(y, /press-night-clock\.js sleep-plan/);
  assert.match(y, /press-night-clock\.js confirm/);
  assert.match(y, /2700/);
  assert.match(y, /REPLANS/);
  assert.doesNotMatch(y, /-gt 18000/);
});
