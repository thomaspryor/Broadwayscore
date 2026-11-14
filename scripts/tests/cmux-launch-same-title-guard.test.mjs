// BRO-4077: identical-title guard for ordinary "👑 OWNER — …" hand-offs.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { launchCmuxSession } = require('../lib/cmux-launch.js');
const { isOwnerLaunchTitle, shouldLaunchSameTitle } = require('../lib/crown-fanout-guard.js');

const TITLE = '👑 OWNER — BRO-4068 land + re-verify two dispatched jobs';
const noCapacity = () => ({ hasCapacity: false, known: true, liveRuntimes: 99, ceiling: 90, reason: 'test-isolation: no terminal capacity' });
const launch = (extra, listed) => launchCmuxSession({
  title: TITLE, seed: 's', seedKey: 'k-bro-4077-' + Math.random().toString(36).slice(2), cwd: os.tmpdir(),
  skipAuthPreflight: true, ...extra,
  probes: { cmuxExists: () => true, listWorkspaces: () => listed, terminalCapacity: noCapacity },
});

test('isOwnerLaunchTitle: ordinary OWNER titles only (not crown, not watchdog, not task titles)', () => {
  assert.equal(isOwnerLaunchTitle(TITLE), true);
  assert.equal(isOwnerLaunchTitle('👑 OWNER — Crown v49 (BRO-343 backlog triage)'), false);
  assert.equal(isOwnerLaunchTitle('👑 OWNER watchdog — 4 in flight'), false);
  assert.equal(isOwnerLaunchTitle('🤖 BRO-4068 fix thing'), false);
});

test('second launch with the same title while the first is listed is refused', () => {
  const res = launch({}, [{ ref: 'workspace:35', title: TITLE }]);
  assert.equal(res.ok, false);
  assert.equal(res.refusedForSameTitle, true);
  assert.equal(res.existingRef, 'workspace:35');
});

test('a live tab carrying a cmux spinner/glyph prefix still matches', () => {
  const res = launch({}, [{ ref: 'workspace:35', title: '⠹ ' + TITLE }]);
  assert.equal(res.refusedForSameTitle, true);
});

test('successorOf (ref or id) exempts only the caller own predecessor', () => {
  const byRef = launch({ successorOf: 'workspace:35' }, [{ ref: 'workspace:35', id: 'u-1', title: TITLE }]);
  assert.equal(byRef.refusedForSameTitle, undefined);
  const byId = launch({ successorOf: 'u-1' }, [{ ref: 'workspace:35', id: 'u-1', title: TITLE }]);
  assert.equal(byId.refusedForSameTitle, undefined);
  const other = launch({ successorOf: 'workspace:99' }, [{ ref: 'workspace:35', id: 'u-1', title: TITLE }]);
  assert.equal(other.refusedForSameTitle, true);
});

test('a different title, and a listing failure all let the launch through', () => {
  assert.equal(launch({}, [{ ref: 'workspace:35', title: '👑 OWNER — BRO-9999 other mandate' }]).refusedForSameTitle, undefined);
  const res = launchCmuxSession({
    title: TITLE, seed: 's', seedKey: 'k-bro-4077-throw', cwd: os.tmpdir(), skipAuthPreflight: true,
    probes: { cmuxExists: () => true, listWorkspaces: () => { throw new Error('socket'); }, terminalCapacity: noCapacity },
  });
  assert.equal(res.refusedForSameTitle, undefined);
  assert.match(res.reason, /no terminal capacity/);
});

test('shouldLaunchSameTitle is a no-op for non-owner titles', () => {
  assert.deepEqual(shouldLaunchSameTitle([{ ref: 'w:1', title: 'x' }], 'x'), { allow: true });
});
