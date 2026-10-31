// TESTS-VS-DERIVED-DATA-EXEMPT: the last test reads the two committed data/audit baseline files only to assert every key carries an expiry entry (structure, not a factual pin on which keys exist)
// BRO-3364: acknowledged-finding baselines expire.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  DAY_MS, activeBaselineKeys, expiredBaselineKeys, expiringSoon, describeExpiry, buildBaseline,
} = require('./baseline-ttl.js');

const T0 = Date.parse('2026-09-14T00:00:00Z');
const doc = {
  keys: ['old', 'fresh', 'legacy'],
  entries: {
    old: { timestamp: '2026-06-01T00:00:00Z', ttlDays: 90 }, // expires 2026-08-30
    fresh: { timestamp: '2026-09-10T00:00:00Z', ttlDays: 90 }, // expires 2026-12-09
  },
};

test('an entry older than its ttl is no longer acknowledged; a legacy key with no entry stays active', () => {
  assert.deepEqual([...activeBaselineKeys(doc, T0)].sort(), ['fresh', 'legacy']);
  assert.deepEqual(expiredBaselineKeys(doc, T0), ['old']);
});

test('expiry is exact: active until timestamp + ttlDays, expired from then on', () => {
  const exp = Date.parse('2026-12-09T00:00:00Z');
  assert.ok(activeBaselineKeys(doc, exp - 1).has('fresh'));
  assert.ok(!activeBaselineKeys(doc, exp).has('fresh'));
});

test('keys expiring within 7 days are listed, and the digest suffix names them', () => {
  const now = Date.parse('2026-12-04T00:00:00Z'); // fresh expires in 5 days
  assert.deepEqual(expiringSoon(doc, now).map((r) => r.key), ['fresh']);
  assert.deepEqual(expiringSoon(doc, now - 3 * DAY_MS), [], '8 days out is not "soon"');
  const note = describeExpiry(doc, now, { renewCommand: '--renew-baseline' });
  assert.match(note, /1 ack\(s\) expire within 7d \(fresh\)/);
  assert.match(note, /1 ack\(s\) expired/);
  assert.match(note, /--renew-baseline/);
  assert.equal(describeExpiry({ keys: ['legacy'] }, now), '', 'nothing expiring = no suffix');
});

test('--write-baseline keeps existing ack dates (a bulk re-ack cannot silently renew), drops gone keys, stamps new ones', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const { doc: out, stats } = buildBaseline(['fresh', 'old', 'brand-new'], doc, { nowMs: now, meta: { description: 'x' } });
  assert.deepEqual(out.keys, ['brand-new', 'fresh', 'old']);
  assert.equal(out.entries.fresh.timestamp, '2026-09-10T00:00:00Z');
  assert.equal(out.entries.old.timestamp, '2026-06-01T00:00:00Z', 'an expired ack stays expired without --renew-baseline');
  assert.equal(out.entries['brand-new'].timestamp, new Date(now).toISOString());
  assert.equal(out._meta.count, 3);
  assert.equal(out._meta.description, 'x');
  assert.deepEqual(stats, { kept: 2, renewed: 0, added: 1, dropped: 1 }); // legacy dropped
  assert.ok(!activeBaselineKeys(out, now).has('old'));
});

test('--renew-baseline re-acks every listed key from now', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const { doc: out, stats } = buildBaseline(['fresh', 'old'], doc, { nowMs: now, renew: true });
  for (const k of ['fresh', 'old']) assert.equal(out.entries[k].timestamp, new Date(now).toISOString());
  assert.equal(stats.renewed, 2);
  assert.ok(activeBaselineKeys(out, now).has('old'));
});

test('the real heartbeat digest check treats an expired ack as new again', () => {
  const { evaluateOutletHeartbeat } = require('./outlet-heartbeat-monitor-core.js');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'bro3364-'));
  const now = Date.parse('2026-12-20T00:00:00Z');
  fs.writeFileSync(path.join(dir, 'outlet-heartbeat.json'), JSON.stringify({
    generatedAt: new Date(now - 3600_000).toISOString(),
    rows: [{ outletId: 'guardian', market: 'broadway', status: 'red', silentDays: 120, thresholdDays: 30, tier: 1 }],
  }));
  fs.writeFileSync(path.join(dir, 'outlet-heartbeat-state.json'), JSON.stringify({ 'guardian::broadway': { redStreak: 3 } }));
  const write = (ts) => fs.writeFileSync(path.join(dir, 'outlet-heartbeat-baseline.json'), JSON.stringify({
    keys: ['guardian::broadway'], entries: { 'guardian::broadway': { timestamp: ts, ttlDays: 90 } },
  }));
  write('2026-12-01T00:00:00Z'); // acked 19 days ago
  assert.equal(evaluateOutletHeartbeat({ auditDir: dir, nowMs: now }).status, 'pass');
  write('2026-09-01T00:00:00Z'); // acked 110 days ago
  const r = evaluateOutletHeartbeat({ auditDir: dir, nowMs: now });
  assert.equal(r.status, 'warn', JSON.stringify(r));
  assert.match(r.message, /expired/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every key in the committed baseline files carries an expiry entry (no silent forever-acks)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const f of ['outlet-heartbeat-baseline.json', 'star-score-mismatch-baseline.json', 'score-vs-models-baseline.json']) {
    const p = path.join(root, 'data', 'audit', f);
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    // ttlDays too: an entry with a timestamp but no ttlDays never expires.
    const missing = (d.keys || []).filter((k) => !d.entries || !d.entries[k] || !Number.isFinite(Date.parse(d.entries[k].timestamp)) || !(Number(d.entries[k].ttlDays) > 0));
    assert.deepEqual(missing, [], `${f}: keys without an expiry entry would never expire — rewrite it with the audit's --write-baseline`);
  }
});

test('per-key renew re-acks only the named keys (BRO-5261)', () => {
  const { buildBaseline, parseRenewArg, unknownRenewKeys } = require('./baseline-ttl.js');
  const prev = { keys: ['a', 'b'], entries: { a: { timestamp: '2026-01-01T00:00:00Z', ttlDays: 90 }, b: { timestamp: '2026-01-01T00:00:00Z', ttlDays: 90 } } };
  const nowMs = Date.parse('2026-10-14T00:00:00Z');
  assert.equal(parseRenewArg(['--write-baseline']), null);
  assert.equal(parseRenewArg(['--renew-baseline']), true);
  const renew = parseRenewArg(['--renew-baseline=a']);
  assert.deepEqual([...renew], ['a']);
  const { doc, stats } = buildBaseline(['a', 'b'], prev, { nowMs, renew });
  assert.equal(doc.entries.a.timestamp, new Date(nowMs).toISOString());
  assert.equal(doc.entries.b.timestamp, '2026-01-01T00:00:00Z');
  assert.deepEqual(stats, { kept: 1, renewed: 1, added: 0, dropped: 0 });
  assert.deepEqual(unknownRenewKeys(new Set(['a', 'typo']), ['a', 'b']), ['typo']);
  assert.deepEqual(unknownRenewKeys(true, ['a']), []);
  assert.deepEqual(unknownRenewKeys(parseRenewArg(['--renew-baseline=']), ['a']), ['(no key given)']);
  assert.deepEqual([...parseRenewArg(['--renew-baseline=a', '--renew-baseline=b'])].sort(), ['a', 'b']);
});

test('the expiry note names the per-key renew inside the command backticks', () => {
  const { describeExpiry } = require('./baseline-ttl.js');
  const doc = { keys: ['a'], entries: { a: { timestamp: '2026-01-01T00:00:00Z', ttlDays: 90 } } };
  const note = describeExpiry(doc, Date.parse('2026-10-14T00:00:00Z'), { renewCommand: '`node x.js --renew-baseline`' });
  assert.match(note, /`node x\.js --renew-baseline=<key>` per key/);
  assert.match(note, /alert normally again if still present/);
});
