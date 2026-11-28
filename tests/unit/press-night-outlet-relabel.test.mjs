// BRO-7900: a mid-night outlet display-name fix ("columbiaspectator" -> "Columbia Daily Spectator")
// must not read as a dropped review. Much Ado 2026-11-19 failed its stability gate this way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pnr = require('../../scripts/lib/press-night-record.js');

const night = '2026-11-19';
function rec() {
  const r = pnr.emptyRecord({ showId: 'much-ado-about-nothing-2026', night, market: 'broadway', embargoAt: '2026-11-20T02:00:00Z' });
  return r;
}
const rv = (outlet, critic) => ({ outlet, critic, publishDate: night });

test('outlet relabel pairs as a rename in applySample (no drop)', () => {
  const r = rec();
  pnr.applySample(r, { at: '2026-11-20T07:04:00Z', reviews: [rv('columbiaspectator', 'Light Dohrn'), rv('Slant Magazine', 'A B')] });
  pnr.applySample(r, { at: '2026-11-20T07:54:00Z', reviews: [rv('Columbia Daily Spectator', 'Light Dohrn'), rv('Slant Magazine', 'A B')] });
  assert.equal(r.dropped.length, 0, JSON.stringify(r.dropped));
});

test('stored record with a relabel drop is not stuck in the stability gate', () => {
  const r = rec();
  r.perReview = [
    { key: 'columbiaspectator|light dohrn', outlet: 'columbiaspectator', critic: 'Light Dohrn', liveNow: false, firstLiveAt: '2026-11-20T07:04:00Z' },
    { key: 'columbia daily spectator|light dohrn', outlet: 'Columbia Daily Spectator', critic: 'Light Dohrn', liveNow: true, firstLiveAt: '2026-11-20T07:54:00Z' },
  ];
  r.dropped = [{ key: 'columbiaspectator|light dohrn', outlet: 'columbiaspectator', critic: 'Light Dohrn', firstLiveAt: '2026-11-20T07:04:00Z', droppedAt: '2026-11-20T07:54:00Z', restoredAt: null }];
  r.probe.samples = 3; r.probe.lastOkSampleAt = '2026-11-20T08:00:00Z';
  const out = pnr.evaluateCheck(r);
  const st = (out.gates || out).find((g) => g.name === 'stability');
  assert.notEqual(st.status, 'fail', st.detail);
});

test('a real drop (different critic, same outlet) still fails', () => {
  const r = rec();
  r.perReview = [
    { key: 'columbiaspectator|light dohrn', outlet: 'columbiaspectator', critic: 'Light Dohrn', liveNow: false, firstLiveAt: '2026-11-20T07:04:00Z' },
    { key: 'columbia daily spectator|someone else', outlet: 'Columbia Daily Spectator', critic: 'Someone Else', liveNow: true, firstLiveAt: '2026-11-20T07:04:00Z' },
  ];
  r.dropped = [{ key: 'columbiaspectator|light dohrn', outlet: 'columbiaspectator', critic: 'Light Dohrn', firstLiveAt: '2026-11-20T07:04:00Z', droppedAt: '2026-11-20T07:54:00Z', restoredAt: null }];
  r.probe.samples = 3; r.probe.lastOkSampleAt = '2026-11-20T08:00:00Z';
  const out = pnr.evaluateCheck(r);
  const st = (out.gates || out).find((g) => g.name === 'stability');
  assert.equal(st.status, 'fail');
});

test('alias outlets with different critics do not merge (NY Mag -> Vulture)', () => {
  const r = rec();
  pnr.applySample(r, { at: '2026-11-20T03:00:00Z', reviews: [rv('New York Magazine', 'Sara Holdren')] });
  pnr.applySample(r, { at: '2026-11-20T03:05:00Z', reviews: [rv('Vulture', 'Jackson McHenry')] });
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].critic, 'Sara Holdren');
});

test('a paired relabel takes the new outlet label', () => {
  const r = rec();
  pnr.applySample(r, { at: '2026-11-20T07:04:00Z', reviews: [rv('columbiaspectator', 'Light Dohrn')] });
  pnr.applySample(r, { at: '2026-11-20T07:54:00Z', reviews: [rv('Columbia Daily Spectator', 'Light Dohrn')] });
  assert.equal(r.perReview.length, 1);
  assert.equal(r.perReview[0].outlet, 'Columbia Daily Spectator');
});
