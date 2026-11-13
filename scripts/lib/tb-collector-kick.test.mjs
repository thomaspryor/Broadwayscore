// BRO-7442: a Talkin' Broadway review stuck in _pending/ must trigger the Browserbase collector
// right away (The King's Critique, 2026-11-12: stub 10:25pm ET, live 1:54am).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isStuckTbStub, findStuckTbStubs, decideKick, COLLECTOR_WORKFLOW } = require('./tb-collector-kick.js');

const NOW = new Date('2026-11-13T03:30:00Z');
// The real stub the poller wrote for The King's Critique (data repo bf25bb0fae7).
const realStub = {
  showId: 'the-kings-critique-off-broadway-2026', outletId: 'talkinbroadway', criticName: 'Unknown',
  url: 'https://www.talkinbroadway.com/page/ob/11_12_26b.html', fullText: null, pendingReason: 'no-byline',
  firstSeenAt: '2026-11-13T03:25:30.583Z', pendingUnrecoverableAt: '2026-11-13T03:27:10.056Z',
};

test('the real King\'s Critique stub counts as stuck', () => {
  assert.equal(isStuckTbStub(realStub, NOW.getTime()), true);
});

test('not stuck: other outlet, has body, judged non-review, too old', () => {
  assert.equal(isStuckTbStub({ ...realStub, outletId: 'theatermania', url: 'https://theatermania.com/x' }, NOW.getTime()), false);
  assert.equal(isStuckTbStub({ ...realStub, fullText: 'Theatre Review by James Wilson ...' }, NOW.getTime()), false);
  assert.equal(isStuckTbStub({ ...realStub, rssIdentityRejected: true }, NOW.getTime()), false);
  assert.equal(isStuckTbStub({ ...realStub, promoteSkippedReason: 'wrong show' }, NOW.getTime()), false);
  assert.equal(isStuckTbStub({ ...realStub, firstSeenAt: '2026-11-12T10:00:00Z' }, NOW.getTime()), false);
  assert.equal(isStuckTbStub(null, NOW.getTime()), false);
});

test('findStuckTbStubs reads _pending/{show} on disk and ignores other shows/outlets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbkick-'));
  const dir = path.join(root, '_pending', realStub.showId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'talkinbroadway--7c3716d2.json'), JSON.stringify(realStub));
  fs.writeFileSync(path.join(dir, 'theatermania--aaaa.json'), JSON.stringify({ ...realStub, outletId: 'theatermania' }));
  const hit = findStuckTbStubs(root, [realStub.showId, 'other-show'], { now: NOW });
  assert.deepEqual(hit.map((h) => h.file), ['talkinbroadway--7c3716d2.json']);
  assert.deepEqual(findStuckTbStubs(root, ['other-show'], { now: NOW }), []);
});

test('decideKick: dispatches for a stuck stub with no recent collector run', () => {
  const stuck = [{ showId: 'x', file: 'f' }];
  assert.equal(decideKick({ stuck, runs: [], now: NOW }).kick, true);
  // Only the daily 15:17 UTC run yesterday.
  assert.equal(decideKick({ stuck, runs: [{ status: 'completed', createdAt: '2026-11-12T15:17:00Z' }], now: NOW }).kick, true);
});

test('decideKick: no stub, running, too recent, or over the daily cap => no dispatch', () => {
  const stuck = [{ showId: 'x', file: 'f' }];
  assert.equal(decideKick({ stuck: [], runs: [], now: NOW }).kick, false);
  assert.equal(decideKick({ stuck, runs: [{ status: 'in_progress', createdAt: '2026-11-13T01:00:00Z' }], now: NOW }).kick, false);
  assert.equal(decideKick({ stuck, runs: [{ status: 'completed', createdAt: '2026-11-13T03:20:00Z' }], now: NOW }).kick, false);
  const six = Array.from({ length: 6 }, (_, i) => ({ status: 'completed', createdAt: new Date(NOW.getTime() - (30 + i * 60) * 60e3).toISOString() }));
  const d = decideKick({ stuck, runs: six, now: NOW });
  assert.equal(d.kick, false);
  assert.match(d.reason, /cap/);
});

test('class guard: the poller workflow calls tb-collector-kick.js after the per-show drain, and it exists', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/opening-night-poller.yml', import.meta.url), 'utf8');
  const drain = wf.indexOf('replay-pending-bylines.js --shows="$SHOW_ID"');
  const kick = wf.indexOf('node scripts/tb-collector-kick.js --shows="$SHOW_ID"');
  assert.ok(drain > 0 && kick > drain, 'poll_one must dispatch the TB collector after the per-show pending drain');
  assert.ok(fs.existsSync(new URL('../../.github/workflows/' + COLLECTOR_WORKFLOW, import.meta.url)));
});
