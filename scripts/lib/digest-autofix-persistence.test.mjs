// BRO-4487: a digest row gets a card only after its condition has been present
// for 3 days; younger rows render as 'watching'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { persistenceKey, applyPersistenceGate, planAutofix, PERSIST_BEFORE_FILING_HOURS, GATE_SLACK_HOURS } = require('./digest-autofix.js');

const H = 3600 * 1000;
const NOW = Date.parse('2026-10-02T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const row = (title, extra = {}) => ({ title, state: 'needs-card', ...extra });

test('persistenceKey: count tokens normalize, distinct identifiers stay distinct', () => {
  const a = persistenceKey(row('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (438/250 reqs)'));
  const b = persistenceKey(row('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (1048/250 reqs)'));
  const c = persistenceKey(row('BSC Daily: Bright Data daily breaker TRIPPED: serp_api1 (40/25 reqs)'));
  assert.equal(a, b, 'same condition on different days');
  assert.notEqual(a, c, 'serp_api1 vs web_unlocker2 are different conditions');
  assert.notEqual(persistenceKey(row('BSC Daily: Stale tag (batch 2)')), persistenceKey(row('BSC Daily: Stale tag (batch 3)')), 'batch spills stay distinct');
  assert.equal(persistenceKey(row('anything', { conditionKey: 'health-check:X' })), 'ck:health-check:X', 'conditionKey wins when present');
});

test('applyPersistenceGate: a first sighting is watched, not filed', () => {
  const plan = [row('BSC Daily: New thing')];
  const seen = applyPersistenceGate(plan, {}, NOW);
  assert.equal(plan[0].state, 'watching');
  const entry = seen[persistenceKey(plan[0])];
  assert.equal(entry.firstSeen, new Date(NOW).toISOString());
});

test('applyPersistenceGate: a condition present for 3+ days is filed', () => {
  const plan = [row('BSC Daily: Old thing')];
  const key = persistenceKey(plan[0]);
  applyPersistenceGate(plan, { [key]: { firstSeen: iso((PERSIST_BEFORE_FILING_HOURS + 1) * H), lastSeen: iso(24 * H) } }, NOW);
  assert.equal(plan[0].state, 'needs-card');
});

// BRO-5430: the digest runs daily, so the 4th sighting is 72h minus a few
// seconds (or minus launchd drift). It must file, and the 3rd must not.
test('applyPersistenceGate: the 4th daily sighting files even a little under 72h; the 3rd is held', () => {
  const key = persistenceKey(row('BSC Daily: Daily thing'));
  const fourth = [row('BSC Daily: Daily thing')];
  applyPersistenceGate(fourth, { [key]: { firstSeen: iso(PERSIST_BEFORE_FILING_HOURS * H - 3000), lastSeen: iso(24 * H) } }, NOW);
  assert.equal(fourth[0].state, 'needs-card', '71.99h (Oct 12 11:30:35 -> Oct 15 11:30:32) files');
  const late = [row('BSC Daily: Daily thing')];
  applyPersistenceGate(late, { [key]: { firstSeen: iso((PERSIST_BEFORE_FILING_HOURS - GATE_SLACK_HOURS + 1) * H), lastSeen: iso(24 * H) } }, NOW);
  assert.equal(late[0].state, 'needs-card', 'a day-0 run delayed under the slack still files on day 3');
  const third = [row('BSC Daily: Daily thing')];
  applyPersistenceGate(third, { [key]: { firstSeen: iso(48 * H + 3000), lastSeen: iso(24 * H) } }, NOW);
  assert.equal(third[0].state, 'watching', 'the 3rd sighting (~48h) is still held');
  assert.ok(GATE_SLACK_HOURS > 0 && GATE_SLACK_HOURS < 24, 'slack must stay under one daily run');
});

// BRO-5430: 11 of 27 rows on 2026-10-16 already had an open Linear card and
// were shown as 'watching'. The gate only stops new cards, so they skip it.
test('applyPersistenceGate: a row whose exact title has an open Linear card is not held', () => {
  const plan = [row('BSC Daily: Quality: star-vs-score mismatch'), row('BSC Daily: Brand new')];
  const seen = applyPersistenceGate(plan, {}, NOW, { openTitles: new Set(['BSC Daily: Quality: star-vs-score mismatch', 'BSC Daily: Brand new thing']) });
  assert.equal(plan[0].state, 'needs-card', 'existing card: straight to fileCard reattach');
  assert.equal(plan[1].state, 'watching', 'exact title only, like fileCard: a near-miss title is still held');
  assert.ok(seen[persistenceKey(plan[0])], 'sightings are still recorded for exempt rows');
  const unread = [row('BSC Daily: Quality: star-vs-score mismatch')];
  applyPersistenceGate(unread, {}, NOW, { openTitles: null });
  assert.equal(unread[0].state, 'watching', 'Linear unreadable (null): gate holds as before');
});

// Ship-check P1 (BRO-5430): a visitor-facing error a worker can fix files on
// its first sighting; warnings, internal rows and owner/Mac rows still wait.
test('applyPersistenceGate: a fixable visitor-facing error is never held; others still wait', () => {
  const plan = planAutofix({
    health: {
      errors: [{ name: 'Data: T1/T2 silent review gaps', message: 'x' }, { name: 'Push-retry deadman', message: 'x' }, { name: 'Credits: ScrapingBee low', message: 'x' }],
      warns: [{ name: 'SEO: health', message: 'x' }],
    },
    tasks: [], queued: [],
  });
  applyPersistenceGate(plan, {}, NOW);
  const state = Object.fromEntries(plan.map((r) => [r.name, r.state]));
  assert.equal(state['Data: T1/T2 silent review gaps'], 'needs-card', 'visitor error: files now (START-NOW in fileCard)');
  assert.equal(state['Push-retry deadman'], 'watching', 'internal error waits');
  assert.equal(state['Credits: ScrapingBee low'], 'watching', 'owner-money row waits');
  assert.equal(state['SEO: health'], 'watching', 'visitor warning waits');
});

test('applyPersistenceGate: a 96h+ gap restarts the clock', () => {
  const plan = [row('BSC Daily: Flappy thing')];
  const key = persistenceKey(plan[0]);
  const seen = applyPersistenceGate(plan, { [key]: { firstSeen: iso(300 * H), lastSeen: iso(100 * H) } }, NOW);
  assert.equal(plan[0].state, 'watching');
  assert.equal(seen[key].firstSeen, new Date(NOW).toISOString());
});

test('applyPersistenceGate: only needs-card rows are held; tracked/in-progress rows are untouched', () => {
  const plan = [row('BSC Daily: A', { state: 'queued' }), row('BSC Daily: B', { state: 'in-progress' }), row('BSC Daily: C', { state: 'decision' })];
  applyPersistenceGate(plan, {}, NOW);
  assert.deepEqual(plan.map((r) => r.state), ['queued', 'in-progress', 'decision']);
});

test('applyPersistenceGate: sightings older than 14 days are pruned', () => {
  const seen = applyPersistenceGate([], { 't:gone': { firstSeen: iso(40 * 24 * H), lastSeen: iso(20 * 24 * H) }, 't:recent': { firstSeen: iso(5 * 24 * H), lastSeen: iso(2 * 24 * H) } }, NOW);
  assert.deepEqual(Object.keys(seen), ['t:recent']);
});

// BRO-5168: the gate used to hold rows BEFORE writing the sightings file. When
// the write failed, every run looked like a first sighting, so nothing was
// ever old enough to file. Holds now apply only after the write succeeds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { runAutofix, computePersistenceGate } = require('./digest-autofix.js');

function runWithSeenPath(seenPath) {
  const filed = [];
  const plan = [{ name: 'Data: something broke', message: 'm', title: 'BSC Daily: Data: something broke', state: 'needs-card', taskId: null, conditionKey: null }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5168-'));
  runAutofix({
    plan, dryRun: false, seenPath, loadTasksFn: () => [],
    ledgerPath: path.join(dir, 'ledger.jsonl'), dispatchLedgerEntriesFn: () => [],
    dispatchFn: () => {}, now: new Date(NOW),
    fileCardFn: (title) => { filed.push(title); return { ok: true, identifier: 'BRO-1' }; },
  });
  return { plan, filed };
}

test('computePersistenceGate does not mutate the plan', () => {
  const plan = [row('BSC Daily: New thing')];
  const { seen, hold } = computePersistenceGate(plan, {}, NOW);
  assert.equal(plan[0].state, 'needs-card');
  assert.equal(hold.length, 1);
  assert.equal(hold[0], plan[0]);
  assert.ok(seen[persistenceKey(plan[0])]);
});

test('runAutofix: an unwritable sightings file files the card instead of holding the row forever', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5168-'));
  const notADir = path.join(dir, 'file');
  fs.writeFileSync(notADir, 'x'); // parent of seenPath is a FILE, so mkdir/write fail even as root
  const { plan, filed } = runWithSeenPath(path.join(notADir, 'digest-seen.json'));
  assert.deepEqual(filed, ['BSC Daily: Data: something broke']);
  assert.notEqual(plan[0].state, 'watching');
  assert.ok(['card-filed', 'dispatched'].includes(plan[0].state), plan[0].state);
});

test('runAutofix: a writable sightings file still holds a first sighting as watching', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5168-'));
  const seenPath = path.join(dir, 'digest-seen.json');
  const { plan, filed } = runWithSeenPath(seenPath);
  assert.deepEqual(filed, []);
  assert.equal(plan[0].state, 'watching');
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(seenPath, 'utf8'))).length === 1);
});

test('applyPersistenceGate: a row whose open card differs only in a live count is not held (BRO-6081)', () => {
  const plan = [row('BSC Daily: breaker TRIPPED: web_unlocker2 (2194/1750 reqs)'), row('BSC Daily: breaker TRIPPED: web_unlocker3 (2194/1750 reqs)')];
  applyPersistenceGate(plan, {}, NOW, { openTitles: new Set(['BSC Daily: breaker TRIPPED: web_unlocker2 (2445/1750 reqs)']) });
  assert.equal(plan[0].state, 'needs-card', 'same condition, new count: straight to reattach');
  assert.equal(plan[1].state, 'watching', 'a different zone is a different card');
});
