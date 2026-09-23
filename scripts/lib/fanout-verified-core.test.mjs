import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideFanout, landingState, FANOUT_EVENT, MIN_REFS } = require('./fanout-verified-core.js');

const done = (ref, ts) => ({ ts, event: 'job-done', taskId: `linear:${ref}`, jobId: `${ref}-job` });
const spawned = (ref, ts) => ({ ts, event: 'job-spawned', taskId: `linear:${ref}`, jobId: `${ref}-job` });
const ok = { cmd: 'node --test tests/unit/thing.test.mjs', safe: true, unsafeReason: null, exitCode: 0 };
const reason = 'ran the unit suite that covers both children together';

test('two landed children + safe verify exit 0 -> fanout-verified row', () => {
  const entries = [spawned('BRO-1', '2026-09-22T01:00:00Z'), done('BRO-1', '2026-09-22T02:00:00Z'),
    spawned('BRO-2', '2026-09-22T01:10:00Z'), done('BRO-2', '2026-09-22T02:30:00Z')];
  const d = decideFanout({ refs: ['BRO-1', 'linear:BRO-2'], entries, verify: ok, reason, ackedBy: 'sess' });
  assert.equal(d.ok, true, d.refusals.join('; '));
  assert.equal(d.row.event, FANOUT_EVENT);
  assert.deepEqual(d.row.refs, ['BRO-1', 'BRO-2']);
  assert.equal(d.row.taskId, 'fanout');
});

test('one ref is refused: the single child LANDED re-run is the check', () => {
  const d = decideFanout({ refs: ['BRO-1'], entries: [done('BRO-1', '2026-09-22T02:00:00Z')], verify: ok, reason });
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), new RegExp(`at least ${MIN_REFS}`));
});

test('a child that has not landed (newest row spawned / stopped-short) refuses', () => {
  const entries = [done('BRO-1', '2026-09-22T02:00:00Z'), spawned('BRO-2', '2026-09-22T02:10:00Z')];
  const d = decideFanout({ refs: ['BRO-1', 'BRO-2'], entries, verify: ok, reason });
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /BRO-2 has not landed yet \(job-spawned/);
  const stopped = [done('BRO-1', '2026-09-22T02:00:00Z'), done('BRO-2', '2026-09-22T02:00:00Z'),
    { ts: '2026-09-22T02:20:00Z', event: 'job-stopped-short', taskId: 'linear:BRO-2' }];
  assert.equal(decideFanout({ refs: ['BRO-1', 'BRO-2'], entries: stopped, verify: ok, reason }).ok, false);
});

test('landed-acked newer than the bad row counts; prune-closed needs the ✅ mark', () => {
  assert.equal(landingState([
    { ts: '2026-09-22T02:00:00Z', event: 'job-stopped-short' },
    { ts: '2026-09-22T02:30:00Z', event: 'landed-acked' }]).landed, true);
  assert.equal(landingState([
    { ts: '2026-09-22T02:30:00Z', event: 'landed-acked' },
    { ts: '2026-09-22T02:40:00Z', event: 'job-stopped-short' }]).landed, false);
  assert.equal(landingState([{ ts: '2026-09-22T02:00:00Z', event: 'prune-closed', title: '✅ done' }]).landed, true);
  assert.equal(landingState([{ ts: '2026-09-22T02:00:00Z', event: 'prune-closed', title: 'still going' }]).landed, false);
});

test('unsafe, failed or missing verify and a thin reason each refuse', () => {
  const entries = [done('BRO-1', '2026-09-22T02:00:00Z'), done('BRO-2', '2026-09-22T02:30:00Z')];
  const base = { refs: ['BRO-1', 'BRO-2'], entries, reason };
  assert.match(decideFanout({ ...base, verify: { cmd: 'node scripts/x.js --go', safe: false, unsafeReason: 'arbitrary script' } }).refusals.join(), /not safe-form/);
  assert.match(decideFanout({ ...base, verify: { ...ok, exitCode: 1 } }).refusals.join(), /exited 1/);
  assert.match(decideFanout({ ...base, verify: { cmd: '', safe: false } }).refusals.join(), /--verify is required/);
  assert.match(decideFanout({ ...base, verify: ok, reason: 'ok' }).refusals.join(), /--reason/);
});
