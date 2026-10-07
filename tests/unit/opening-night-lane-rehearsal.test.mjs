// BRO-4787 (epic BRO-4210 phase 4): the rehearsal is the epic's acceptance test. Real functions only (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const rh = require('../../scripts/lib/opening-night-lane/rehearsal.js');
const { buildSyntheticFixture } = require('../../scripts/lib/opening-night-lane/rehearsal-fixture.js');
const { resolveOutletFromUrl } = require('../../scripts/lib/review-normalization.js');
const discovery = require('../../scripts/lib/opening-night-lane/discovery.js');
const ledger = require('../../scripts/lib/opening-night-lane/ledger.js');

const CLI = new URL('../../scripts/opening-night-lane-rehearse.js', import.meta.url).pathname;
const DAY = 24 * 60 * 60 * 1000;

test('synthetic fixture: 35 reviews, every host a registered outlet, decoys not among them, a paywalled NYT with no text', () => {
  const f = buildSyntheticFixture();
  assert.equal(f.reviews.length, 35);
  assert.equal(new Set(f.expectedKeys).size, 35, 'canonical keys are unique');
  for (const r of f.reviews) assert.ok(resolveOutletFromUrl(r.url), `${r.host} must resolve to a registered outlet`);
  for (const d of f.decoys) assert.ok(!f.expectedKeys.includes(discovery.canonicalUrl(d)));
  const nyt = f.reviews.find((r) => r.outletId === 'nytimes');
  assert.equal(nyt.text, '');
  assert.equal(f.reviews.filter((r) => r.criticName === 'Chris Example').length, 2, 'the syndicated critic appears on two outlets');
  assert.deepEqual(buildSyntheticFixture(), f, 'deterministic');
});

test('rehearsal replay: every fixture review reaches verified-live in under 20 minutes with zero manual steps', async () => {
  const fixture = buildSyntheticFixture();
  const res = await rh.runRehearsal({ fixture });
  assert.equal(res.pass, true, JSON.stringify(res.verdict.failures.slice(0, 3)));
  assert.equal(res.verdict.checked, 35);
  assert.equal(res.summary.total, 35);
  assert.equal(res.summary.live, 35);
  assert.ok(res.summary.maxMs < ledger.DEFAULT_MAX_MS, `max time-to-live ${res.summary.maxMs}ms`);
  for (const r of res.summary.reviews) { assert.equal(r.manual, false); assert.deepEqual(r.skipped, []); assert.equal(r.lastStage, 'verified-live'); }
  assert.deepEqual(res.checks.unexpected, []);
  assert.deepEqual(res.checks.decoyLeaks, []);
  assert.equal(res.checks.bystandersSurvived, true);
});

test('rehearsal keeps the work dir on request and publishes lane-stamped rows, the paywalled NYT on its aggregator fallback score', async () => {
  const fixture = buildSyntheticFixture();
  const res = await rh.runRehearsal({ fixture, keep: true });
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(res.workDir, 'reviews.json'), 'utf8'));
    const mine = doc.reviews.filter((r) => r.showId === fixture.show.id);
    assert.equal(mine.length, 35);
    assert.ok(mine.every((r) => r.productionVerified === 'aggregator' && r.openingNightLane && r.assignedScore != null));
    const nyt = mine.find((r) => r.outletId === 'nytimes');
    assert.equal(nyt.needsRecollection, true);
    assert.equal(nyt.scoreConfidence, 'low');
    assert.equal(nyt.scoreSource, 'lane-aggregator-thumb');
    assert.equal(doc.reviews.filter((r) => r.showId === 'rehearsal-bystander-2026').length, 2);
  } finally { fs.rmSync(res.workDir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('a broken lane fails the rehearsal: a source page that goes missing leaves reviews never logged', async () => {
  const fixture = buildSyntheticFixture();
  for (const u of Object.keys(fixture.pages)) if (u.includes('didtheylikeit.com/shows')) delete fixture.pages[u];
  const res = await rh.runRehearsal({ fixture });
  assert.equal(res.pass, false);
  assert.ok(res.verdict.failures.some((f) => f.reason === 'never-logged'));
  assert.ok(res.verdict.failures.length >= 3, 'the three DTLI-only reviews');
});

test('a slow lane fails the rehearsal: time-to-live over the bar is too-slow', async () => {
  const res = await rh.runRehearsal({ fixture: buildSyntheticFixture(), stepMs: 60 * 1000 });
  assert.equal(res.pass, false);
  assert.ok(res.verdict.failures.some((f) => f.reason === 'too-slow'));
});

test('a review the fixture does not expect is a failure, not a bonus', async () => {
  const fixture = buildSyntheticFixture();
  fixture.expectedKeys = fixture.expectedKeys.slice(1); // pretend the first one is not expected
  fixture.reviews = fixture.reviews.slice(1);
  const res = await rh.runRehearsal({ fixture });
  assert.equal(res.pass, false);
  assert.equal(res.checks.unexpected.length, 1);
});

test('runRehearsal refuses a malformed fixture', async () => {
  await assert.rejects(rh.runRehearsal({}), /fixture needs/);
  await assert.rejects(rh.runRehearsal({ fixture: { show: { id: 'x' } } }), /fixture needs/);
});

test('armDecision: only a recent, passing rehearsal arms the lane', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const rec = (over = {}) => ({ at: '2026-10-12T12:00:00Z', pass: true, ...over });
  assert.deepEqual(rh.armDecision(rec(), { now }), { arm: true, reason: 'last-rehearsal-passed' });
  assert.equal(rh.armDecision(null, { now }).reason, 'no-rehearsal-record');
  assert.equal(rh.armDecision('x', { now }).reason, 'no-rehearsal-record');
  assert.equal(rh.armDecision(rec({ pass: false }), { now }).reason, 'last-rehearsal-failed');
  assert.equal(rh.armDecision(rec({ pass: 'yes' }), { now }).reason, 'last-rehearsal-failed', 'truthy is not true');
  assert.equal(rh.armDecision(rec({ at: 'last week' }), { now }).reason, 'rehearsal-date-unreadable');
  assert.equal(rh.armDecision(rec({ at: '2026-10-05T11:59:00Z' }), { now }).reason, 'rehearsal-stale');
  assert.equal(rh.armDecision(rec({ at: new Date(now - 8 * DAY).toISOString() }), { now }).arm, true, 'exactly at the limit still arms');
  assert.equal(rh.armDecision(rec({ at: '2026-10-20T00:00:00Z' }), { now }).reason, 'rehearsal-dated-in-the-future');
  assert.equal(rh.armDecision(rec({ at: new Date(now - 2 * DAY).toISOString() }), { now, maxAgeMs: DAY }).reason, 'rehearsal-stale');
});

test('recordRehearsal / readRehearsalRecord round trip; a missing or corrupt record reads as null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4787-'));
  try {
    const file = path.join(dir, 'nested', 'rec.json');
    const rec = rh.recordRehearsal(file, { pass: true, verdict: { checked: 35, failures: [] }, checks: { unexpected: [], decoyLeaks: [], bystandersSurvived: true, timedOut: false } }, { at: Date.parse('2026-10-14T00:00:00Z') });
    assert.deepEqual(rh.readRehearsalRecord(file), rec);
    assert.equal(rec.pass, true);
    const failed = rh.recordRehearsal(file, { pass: false, verdict: { checked: 3, failures: Array.from({ length: 30 }, (_, i) => ({ reviewKey: `k${i}`, reason: 'never-logged' })) } }, { at: 0 });
    assert.equal(failed.failures.length, 10, 'failures trimmed');
    assert.equal(rh.readRehearsalRecord(path.join(dir, 'missing.json')), null);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.equal(rh.readRehearsalRecord(path.join(dir, 'bad.json')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('CLI: --rehearse writes a passing record and --arm-check arms on it; tampering or a missing record refuses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4787-'));
  try {
    const out = path.join(dir, 'lane-rehearsal.json');
    const stdout = execFileSync('node', [CLI, '--rehearse', '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(JSON.parse(stdout.trim().split('\n').pop()).pass, true);
    const armed = spawnSync('node', [CLI, '--arm-check', '--record', out], { encoding: 'utf8' });
    assert.equal(armed.status, 0);
    assert.equal(JSON.parse(armed.stdout).arm, true);
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'));
    fs.writeFileSync(out, JSON.stringify({ ...rec, pass: false }));
    assert.equal(spawnSync('node', [CLI, '--arm-check', '--record', out], { encoding: 'utf8' }).status, 3);
    assert.equal(spawnSync('node', [CLI, '--arm-check', '--record', path.join(dir, 'nope.json')], { encoding: 'utf8' }).status, 3);
    assert.equal(spawnSync('node', [CLI], { encoding: 'utf8' }).status, 2, 'no mode is a usage error');
    assert.equal(spawnSync('node', [CLI, '--rehearse', '--fixture', 'paranormal-activity'], { encoding: 'utf8' }).status, 2, 'an unrecorded fixture is refused, not faked');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});
