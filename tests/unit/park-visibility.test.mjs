// Parked-card visibility (card #777): bsc-prune's tab-close park (#776)
// writes a 'vanished' ledger entry and pauses the Notion card, but nothing
// surfaced that state anywhere — the same write-only-signal class as
// #689/#690/#641/#692. This covers the three surfaces added to fix it:
// dispatch-ledger.parkedTasks() (source of truth, already existed but was
// untested), the morning-digest render block, and the bsc-status listing.
// Real functions via require() — never copied (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dispatchLedger = require('../../scripts/lib/dispatch-ledger.js');
const { renderParkedCardsBlock } = require('../../scripts/lib/autonomous-email-render.js');
const { formatParkedCardsLines } = require('../../scripts/bsc-status.js');

test('parkedTasks: a seeded vanished entry parks its task', () => {
  const entries = [
    { event: 'launch', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: 't0' },
    { event: 'vanished', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: 't1' },
  ];
  const parked = dispatchLedger.parkedTasks(entries);
  assert.equal(parked.size, 1);
  assert.equal(parked.get('601').workspaceRef, 'workspace:12');
});

test('parkedTasks: a later launch clears the park (self-healing re-dispatch)', () => {
  const entries = [
    { event: 'launch', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: 't0' },
    { event: 'vanished', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: 't1' },
    { event: 'launch', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:47', ts: 't2' },
  ];
  const parked = dispatchLedger.parkedTasks(entries);
  assert.equal(parked.size, 0, 'a fresh launch (--force resume) unparks the task');
});

test('parkedTasks: an explicit unpark entry clears without a new dispatch', () => {
  const entries = [
    { event: 'launch', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: 't0' },
    { event: 'vanished', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: 't1' },
    dispatchLedger.unparkEntry({ taskId: 601, reason: 'owner review' }),
  ];
  const parked = dispatchLedger.parkedTasks(entries);
  assert.equal(parked.size, 0);
});

test('parkedTasks: multiple distinct tasks all park independently', () => {
  const entries = [
    { event: 'launch', taskId: 601, workspaceRef: 'workspace:12', ts: 't0' },
    { event: 'vanished', taskId: 601, workspaceRef: 'workspace:12', ts: 't1' },
    { event: 'launch', taskId: 602, workspaceRef: 'workspace:13', ts: 't0' },
    { event: 'vanished', taskId: 602, workspaceRef: 'workspace:13', ts: 't1' },
  ];
  const parked = dispatchLedger.parkedTasks(entries);
  assert.equal(parked.size, 2);
  assert.deepEqual([...parked.keys()].sort(), ['601', '602']);
});

test('renderParkedCardsBlock: empty/absent input renders nothing', () => {
  assert.equal(renderParkedCardsBlock(null), '');
  assert.equal(renderParkedCardsBlock(undefined), '');
  assert.equal(renderParkedCardsBlock([]), '');
});

test('renderParkedCardsBlock: names each task id + subject + workspace ref, "Parked by you: N card(s)"', () => {
  const html = renderParkedCardsBlock([
    { taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12' },
    { taskId: 602, subject: 'Fix the other thing', workspaceRef: 'workspace:13' },
  ]);
  assert.match(html, /Parked by you: 2 cards/);
  assert.match(html, /#601/);
  assert.match(html, /Fix the thing/);
  assert.match(html, /workspace:12/);
  assert.match(html, /#602/);
  assert.match(html, /Fix the other thing/);
  assert.match(html, /workspace:13/);
});

test('renderParkedCardsBlock: singular "card" for exactly one, and escapes subject + workspaceRef (the fields it actually renders)', () => {
  const html = renderParkedCardsBlock([{ taskId: 1, subject: '<script>alert(1)</script>', workspaceRef: '<img src=x>' }]);
  assert.match(html, /Parked by you: 1 card —/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img /);
});

test('selectParkedCardsForDigest: caps at maxShown, newest-parked-first, reports moreCount (ship-check finding — Codex)', () => {
  const parked = dispatchLedger.parkedTasks([
    { event: 'vanished', taskId: 1, subject: 'oldest', workspaceRef: 'workspace:1', ts: '2026-08-01T00:00:00.000Z' },
    { event: 'vanished', taskId: 2, subject: 'middle', workspaceRef: 'workspace:2', ts: '2026-08-01T01:00:00.000Z' },
    { event: 'vanished', taskId: 3, subject: 'newest', workspaceRef: 'workspace:3', ts: '2026-08-01T02:00:00.000Z' },
  ]);
  const { shown, moreCount } = dispatchLedger.selectParkedCardsForDigest(parked, 2);
  assert.deepEqual(shown.map(s => s.taskId), [3, 2], 'newest-ts entries shown first');
  assert.equal(moreCount, 1);
});

test('renderParkedCardsBlock: an unbounded historical replay is capped — moreCount shows in the total and as "+N more" (ship-check finding)', () => {
  const html = renderParkedCardsBlock(
    [{ taskId: 601, subject: 'shown one', workspaceRef: 'workspace:1' }],
    3,
  );
  assert.match(html, /Parked by you: 4 cards/, 'total = shown + moreCount, not just the capped page');
  assert.match(html, /\+3 more/);
});

test('formatParkedCardsLines: empty Map produces no lines', () => {
  assert.deepEqual(formatParkedCardsLines(new Map()), []);
  assert.deepEqual(formatParkedCardsLines(null), []);
});

test('formatParkedCardsLines: names each parked task id + closed workspace ref', () => {
  const parked = dispatchLedger.parkedTasks([
    { event: 'launch', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: 't0' },
    { event: 'vanished', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: 't1' },
  ]);
  const lines = formatParkedCardsLines(parked);
  const joined = lines.join('\n');
  assert.match(joined, /Parked by you \(1\)/);
  assert.match(joined, /#601/);
  assert.match(joined, /workspace:12/);
  assert.match(joined, /bsc-next\.js --id <id> --force/);
});

test('end-to-end: a vanished breadcrumb from vanishedBreadcrumbs() is visible in both surfaces, then clears on unpark', () => {
  const liveRefs = new Set(['workspace:99']); // workspace:12 no longer listed
  let entries = [
    { ...dispatchLedger.vanishEpochEntry(), ts: '2026-07-31T00:00:00.000Z' },
    { event: 'launch', taskId: 601, subject: 'Fix the thing', workspaceRef: 'workspace:12', ts: '2026-08-01T00:00:00.000Z' },
  ];
  const epochTs = dispatchLedger.vanishEpoch(entries);
  const breadcrumbs = dispatchLedger.vanishedBreadcrumbs(liveRefs, entries, { epochTs, now: Date.parse('2026-08-01T01:00:00.000Z') })
    .map(b => ({ ...b, ts: '2026-08-01T01:00:00.000Z' }));
  assert.equal(breadcrumbs.length, 1);
  entries = entries.concat(breadcrumbs);

  const parkedBefore = dispatchLedger.parkedTasks(entries);
  assert.equal(parkedBefore.size, 1, 'vanished breadcrumb parks the task');
  assert.ok(renderParkedCardsBlock([...parkedBefore.values()]).includes('#601'));
  assert.ok(formatParkedCardsLines(parkedBefore).join('\n').includes('#601'));

  entries = entries.concat([dispatchLedger.unparkEntry({ taskId: 601 })]);
  const parkedAfter = dispatchLedger.parkedTasks(entries);
  assert.equal(parkedAfter.size, 0, 'unpark clears it from both surfaces');
  assert.equal(renderParkedCardsBlock([...parkedAfter.values()]), '');
  assert.deepEqual(formatParkedCardsLines(parkedAfter), []);
});
