// BRO-4210 phase 1: the opening-night lane's per-night ledger and night lease.
// Real functions only (CLAUDE.md section 15); temp dirs only, no repo data written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const ledger = require('../../scripts/lib/opening-night-lane/ledger.js');
const lease = require('../../scripts/lib/opening-night-lane/lease.js');

const LEASE_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../scripts/lib/opening-night-lane/lease.js');
const SHOW = 'paranormal-activity-2026';
const NIGHT = '2026-08-25';
const T0 = Date.parse('2026-08-25T21:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro4210-'));

function fullRun(key, startMin, perStageMin) {
  return ledger.STAGES.map((stage, i) => ({ show: SHOW, night: NIGHT, reviewKey: key, stage, at: at(startMin + i * perStageMin) }));
}

// ---------------------------------------------------------------- ledger

test('ledger: append, read back, one line per event, nothing rewritten', () => {
  const dir = tmp();
  try {
    ledger.appendEvent(dir, { show: SHOW, night: NIGHT, reviewKey: 'https://a.example/1', stage: 'discovered', at: at(0) });
    ledger.appendEvent(dir, { show: SHOW, night: NIGHT, reviewKey: 'https://a.example/1', stage: 'fetched', at: at(2), meta: { bytes: 1200 } });
    const raw = fs.readFileSync(ledger.ledgerPath(dir, SHOW, NIGHT), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2);
    const { events, corrupt } = ledger.readLedger(dir, SHOW, NIGHT);
    assert.equal(corrupt, 0);
    assert.deepEqual(events.map((e) => e.stage), ['discovered', 'fetched']);
    assert.deepEqual(events[1].meta, { bytes: 1200 });
    assert.deepEqual(ledger.readLedger(dir, SHOW, '2026-01-01'), { events: [], corrupt: 0 }, 'a night with no ledger is empty, not an error');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ledger: bad stage, show, night, key or time is refused, never written', () => {
  const dir = tmp();
  try {
    const ok = { show: SHOW, night: NIGHT, reviewKey: 'k', stage: 'discovered' };
    assert.throws(() => ledger.appendEvent(dir, { ...ok, stage: 'published' }), /unknown stage/);
    assert.throws(() => ledger.appendEvent(dir, { ...ok, show: '../etc' }), /bad show/);
    assert.throws(() => ledger.appendEvent(dir, { ...ok, night: '10/18/2026' }), /bad night/);
    assert.throws(() => ledger.appendEvent(dir, { ...ok, reviewKey: '' }), /reviewKey/);
    assert.throws(() => ledger.appendEvent(dir, { ...ok, at: 'not a date' }), /timestamp/);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ledger: a corrupt or half-written line is counted and skipped, the rest still reads', () => {
  const good = JSON.stringify({ show: SHOW, night: NIGHT, reviewKey: 'k', stage: 'discovered', at: at(0) });
  const { events, corrupt } = ledger.parseLedger(`${good}\n{"show":"x","stage":"disc\n${JSON.stringify({ reviewKey: 'k', stage: 'nope', at: at(1) })}\n\n${good}\n`);
  assert.equal(events.length, 2);
  assert.equal(corrupt, 2);
});

test('ledger: time to live is first discovered to first verified-live; a retried stage cannot move it', () => {
  const events = [...fullRun('https://a.example/1', 0, 3)];
  events.push({ show: SHOW, night: NIGHT, reviewKey: 'https://a.example/1', stage: 'fetched', at: at(40) }); // late retry
  events.push({ show: SHOW, night: NIGHT, reviewKey: 'https://a.example/1', stage: 'discovered', at: at(-5) }); // earlier sighting wins
  const [r] = ledger.reviewStates(events);
  assert.equal(r.ttlMs, (15 + 5) * 60000, 'first discovered (t-5) to verified-live (t+15)');
  assert.equal(r.lastStage, 'verified-live');
  assert.deepEqual(r.skipped, []);
});

test('ledger: summarize reports live count, distribution and where each pending review is stuck', () => {
  const events = [
    ...fullRun('r1', 0, 2), // ttl 10 min
    ...fullRun('r2', 0, 4), // ttl 20 min
    ...fullRun('r3', 0, 6), // ttl 30 min
    { show: SHOW, night: NIGHT, reviewKey: 'r4', stage: 'discovered', at: at(1) },
    { show: SHOW, night: NIGHT, reviewKey: 'r4', stage: 'fetched', at: at(3) },
  ];
  const s = ledger.summarize(events);
  assert.equal(s.total, 4);
  assert.equal(s.live, 3);
  assert.equal(s.medianMs, 20 * 60000);
  assert.equal(s.maxMs, 30 * 60000);
  assert.deepEqual(s.pending, [{ reviewKey: 'r4', lastStage: 'fetched' }]);
  assert.deepEqual(ledger.summarize([]), { total: 0, live: 0, skewed: [], medianMs: null, p90Ms: null, maxMs: null, pending: [], reviews: [] });
});

test('rehearsal verdict: passes only when every expected review is live, fast, hands-off and complete', () => {
  const keys = ['r1', 'r2'];
  const good = [...fullRun('r1', 0, 2), ...fullRun('r2', 1, 3)];
  assert.deepEqual(ledger.rehearsalVerdict(good, { expectedKeys: keys }), { pass: true, failures: [], checked: 2 });

  const reasons = (events, opts = {}) => ledger.rehearsalVerdict(events, { expectedKeys: keys, ...opts }).failures.map((f) => `${f.reviewKey}:${f.reason}`);
  assert.deepEqual(reasons(fullRun('r1', 0, 2)), ['r2:never-logged'], 'a review the lane never logged is a failure, not an omission');
  assert.deepEqual(reasons([...fullRun('r1', 0, 2), ...fullRun('r2', 0, 5)]), ['r2:too-slow'], '25 minutes breaches the 20 minute bar');
  assert.deepEqual(reasons([...fullRun('r1', 0, 2), ...fullRun('r2', 0, 5)], { maxMs: 30 * 60000 }), []);
  const stuck = fullRun('r2', 0, 2).filter((e) => e.stage !== 'verified-live');
  assert.deepEqual(reasons([...fullRun('r1', 0, 2), ...stuck]), ['r2:not-live']);
  const skipped = fullRun('r2', 0, 2).filter((e) => e.stage !== 'scored');
  assert.deepEqual(reasons([...fullRun('r1', 0, 2), ...skipped]), ['r2:skipped-stage']);
  const manual = fullRun('r2', 0, 2).map((e) => (e.stage === 'fetched' ? { ...e, meta: { manual: true } } : e));
  assert.deepEqual(reasons([...fullRun('r1', 0, 2), ...manual]), ['r2:manual-step']);
  assert.throws(() => ledger.rehearsalVerdict(good, {}), /expectedKeys/);
});

test('ledger: a verified-live stamped before discovered (clock skew) is its own failure, not a fast pass', () => {
  const skewed = fullRun('r1', 0, 2).map((e) => (e.stage === 'verified-live' ? { ...e, at: at(-30) } : e));
  const v = ledger.rehearsalVerdict(skewed, { expectedKeys: ['r1'] });
  assert.equal(v.pass, false);
  assert.deepEqual(v.failures.map((f) => f.reason), ['negative-ttl']);
  const s = ledger.summarize(skewed);
  assert.equal(s.live, 0);
  assert.deepEqual(s.skewed, ['r1']);
});

test('ledger: corrupt lines fail a rehearsal; a line for another show or night is not merged into this file', () => {
  const good = fullRun('r1', 0, 2);
  assert.equal(ledger.rehearsalVerdict(good, { expectedKeys: ['r1'], corrupt: 1 }).failures[0].reason, 'corrupt-lines');
  const dir = tmp();
  try {
    for (const e of good) ledger.appendEvent(dir, e);
    fs.appendFileSync(ledger.ledgerPath(dir, SHOW, NIGHT), `${JSON.stringify({ show: 'other-show-2026', night: NIGHT, reviewKey: 'x', stage: 'discovered', at: at(0) })}\n`);
    const { events, corrupt } = ledger.readLedger(dir, SHOW, NIGHT);
    assert.equal(events.length, good.length);
    assert.equal(corrupt, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ledger: null timestamp is refused (it would become 1970); even-count median and p90 are nearest-rank', () => {
  assert.throws(() => ledger.buildEvent({ show: SHOW, night: NIGHT, reviewKey: 'k', stage: 'discovered', at: null }), /timestamp/);
  const events = [...fullRun('a', 0, 2), ...fullRun('b', 0, 4), ...fullRun('c', 0, 6), ...fullRun('d', 0, 8)]; // ttl 10, 20, 30, 40
  const s = ledger.summarize(events);
  assert.equal(s.medianMs, 20 * 60000, 'nearest-rank median of four is the 2nd value');
  assert.equal(s.p90Ms, 40 * 60000);
});

// ---------------------------------------------------------------- lease

const L = { show: 'other-desert-cities-2026', night: '2026-10-18' };
const NOW = Date.parse('2026-10-18T17:00:00Z');

test('lease: first holder wins, the second starter is refused and the lease is unchanged', () => {
  const a = lease.acquire(lease.emptyState(), { ...L, holder: 'gha', now: NOW });
  assert.equal(a.ok, true);
  assert.equal(a.reason, 'acquired');
  const b = lease.acquire(a.state, { ...L, holder: 'mac', now: NOW + 1000 });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'held-by-other');
  assert.equal(b.holder, 'gha');
  assert.deepEqual(b.state.leases, a.state.leases);
});

test('lease: the same holder re-acquiring renews; an expired lease can be taken over, a live one never', () => {
  const a = lease.acquire(lease.emptyState(), { ...L, holder: 'gha', now: NOW, ttlMs: 60000 });
  const again = lease.acquire(a.state, { ...L, holder: 'gha', now: NOW + 30000, ttlMs: 60000 });
  assert.equal(again.reason, 'renewed');
  assert.equal(again.state.leases[`${L.show}|${L.night}`].expiresAt, new Date(NOW + 90000).toISOString());
  assert.equal(lease.acquire(again.state, { ...L, holder: 'mac', now: NOW + 89000 }).ok, false, 'one second before expiry it is still live');
  const taken = lease.acquire(again.state, { ...L, holder: 'mac', now: NOW + 90000 });
  assert.equal(taken.reason, 'taken-over-expired');
  assert.equal(taken.previousHolder, 'gha');
  assert.equal(taken.state.leases[`${L.show}|${L.night}`].holder, 'mac');
});

test('lease: heartbeat fails for an expired, foreign or missing lease so a lane that lost it stops writing', () => {
  const a = lease.acquire(lease.emptyState(), { ...L, holder: 'gha', now: NOW, ttlMs: 60000 });
  assert.equal(lease.heartbeat(a.state, { ...L, holder: 'gha', now: NOW + 59000 }).ok, true);
  assert.equal(lease.heartbeat(a.state, { ...L, holder: 'gha', now: NOW + 60000 }).reason, 'expired');
  assert.equal(lease.heartbeat(a.state, { ...L, holder: 'mac', now: NOW + 1000 }).reason, 'held-by-other');
  assert.equal(lease.heartbeat(lease.emptyState(), { ...L, holder: 'gha', now: NOW }).reason, 'no-lease');
});

test('lease: only the holder releases', () => {
  const a = lease.acquire(lease.emptyState(), { ...L, holder: 'gha', now: NOW });
  const denied = lease.release(a.state, { ...L, holder: 'mac' });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.state.leases, a.state.leases);
  const done = lease.release(a.state, { ...L, holder: 'gha' });
  assert.equal(done.ok, true);
  assert.deepEqual(done.state.leases, {});
});

test('lease: other writers skip a leased show for any night, honour expiry, and let the lane through', () => {
  const a = lease.acquire(lease.emptyState(), { ...L, holder: 'gha', now: NOW, ttlMs: 60000 });
  const hit = lease.activeLeaseFor(a.state, L.show, { now: NOW + 1000 });
  assert.deepEqual(hit, { show: L.show, night: L.night, holder: 'gha', expiresAt: new Date(NOW + 60000).toISOString() });
  assert.equal(lease.activeLeaseFor(a.state, 'a-different-show-2026', { now: NOW + 1000 }), null);
  assert.equal(lease.activeLeaseFor(a.state, L.show, { now: NOW + 61000 }), null, 'expired lease no longer blocks');
  assert.equal(lease.activeLeaseFor(a.state, L.show, { now: NOW + 1000, ignoreHolder: 'gha' }), null, 'the lane itself is not blocked by its own lease');
  assert.equal(lease.sweepExpired(a.state, { now: NOW + 61000 }).leases[`${L.show}|${L.night}`], undefined);
});

test('lease: bad show, night or holder throws instead of writing a junk key', () => {
  assert.throws(() => lease.acquire(lease.emptyState(), { ...L, show: 'Bad Show', holder: 'x' }), /bad show/);
  assert.throws(() => lease.acquire(lease.emptyState(), { ...L, night: 'tonight', holder: 'x' }), /bad night/);
  assert.throws(() => lease.acquire(lease.emptyState(), { ...L, holder: '' }), /holder/);
});

test('lease file: acquire, heartbeat, release round trip through the file', () => {
  const dir = tmp();
  const file = path.join(dir, 'leases.json');
  try {
    assert.equal(lease.acquireLease(file, { ...L, holder: 'gha', now: NOW }).reason, 'acquired');
    assert.equal(lease.acquireLease(file, { ...L, holder: 'mac', now: NOW + 1000 }).reason, 'held-by-other');
    assert.equal(lease.isShowLeased(file, L.show, { now: NOW + 1000 }).holder, 'gha');
    assert.equal(lease.heartbeatLease(file, { ...L, holder: 'gha', now: NOW + 2000 }).ok, true);
    assert.equal(lease.releaseLease(file, { ...L, holder: 'gha', now: NOW + 3000 }).ok, true);
    assert.equal(lease.isShowLeased(file, L.show, { now: NOW + 3000 }), null);
    assert.equal(lease.acquireLease(file, { ...L, holder: 'gha', now: NOW + 3500 }).ok, true);
    fs.writeFileSync(file, '{not json');
    const refused = lease.acquireLease(file, { ...L, holder: 'mac', now: NOW + 4000 });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'state-unreadable', 'a corrupt file is never read as "no leases": that would wipe every other show\'s live lease');
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json', 'and nothing is written over it');
    assert.equal(lease.isShowLeased(file, L.show, { now: NOW + 4000 }).unreadable, true, 'writers that cannot read the file treat the show as leased');
    fs.rmSync(file);
    assert.equal(lease.acquireLease(file, { ...L, holder: 'mac', now: NOW + 5000 }).reason, 'acquired', 'a MISSING file is the only empty state');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lease file: fails closed when the lock cannot be taken (held by a live process)', () => {
  const dir = tmp();
  const file = path.join(dir, 'leases.json');
  try {
    fs.writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()}`); // a live holder: this very process, fresh
    const r = lease.acquireLease(file, { ...L, holder: 'gha', now: NOW, lockTimeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'lock-unavailable');
    assert.equal(fs.existsSync(file), false, 'no lease was granted or written without mutual exclusion');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lease: ttl must be positive; an unparsable expiry reads as expired everywhere; holder ids are the contract', () => {
  assert.throws(() => lease.acquire(lease.emptyState(), { ...L, holder: 'x', ttlMs: 0 }), /ttlMs/);
  assert.throws(() => lease.heartbeat(lease.emptyState(), { ...L, holder: 'x', ttlMs: -5 }), /ttlMs/);
  const broken = { leases: { [`${L.show}|${L.night}`]: { holder: 'gha', expiresAt: 'garbage' } } };
  assert.equal(lease.activeLeaseFor(broken, L.show, { now: NOW }), null);
  assert.equal(lease.acquire(broken, { ...L, holder: 'mac', now: NOW }).reason, 'taken-over-expired');
  assert.deepEqual(lease.sweepExpired(broken, { now: NOW }).leases, {});
  // The same holder string renews by design, so two starters sharing a fixed name would both win.
  const first = lease.acquire(lease.emptyState(), { ...L, holder: 'opening-night-lane', now: NOW });
  assert.equal(lease.acquire(first.state, { ...L, holder: 'opening-night-lane', now: NOW + 1 }).ok, true);
  assert.equal(lease.acquire(first.state, { ...L, holder: 'mac-4242-1', now: NOW + 1 }).ok, false, 'unique ids keep first-of-two-wins');
});

test('lease file: six processes race for one night, exactly one wins', async () => {
  const dir = tmp();
  const file = path.join(dir, 'leases.json');
  const script = `
    const lease = require(${JSON.stringify(LEASE_PATH)});
    const r = lease.acquireLease(${JSON.stringify(file)}, { show: ${JSON.stringify(L.show)}, night: ${JSON.stringify(L.night)}, holder: process.argv[1], now: ${NOW} });
    console.log(JSON.stringify({ holder: process.argv[1], ok: r.ok, reason: r.reason }));
  `;
  try {
    const runs = ['a', 'b', 'c', 'd', 'e', 'f'].map((h) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, h], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', reject);
      child.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop())));
    }));
    const results = await Promise.all(runs);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(lease.isShowLeased(file, L.show, { now: NOW + 1 }).holder, winners[0].holder);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
