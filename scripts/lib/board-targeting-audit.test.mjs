/**
 * board-targeting-audit.test.mjs — BRO-3423.
 *
 * CLAUDE.md §15: these tests require() the real functions. No decision logic is
 * restated here, so changing a threshold or a verdict rule in the module fails
 * the test rather than quietly passing a copy.
 *
 * The inventory test at the bottom is the one that matters most. The first
 * draft of this module audited an ALLOW-list of four event names, which would
 * have been blind to `stall-sweep-attempted` (189 real rows, 100% retired ids),
 * `amend` and `watchdog-park`. That test pins the real ledger's full event
 * inventory against the deny-list, so adding a name to EXEMPT_EVENTS — the only
 * way a dispatcher can become invisible again — has to be argued for in review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTaskIdBoard,
  isRetiredBoardTaskId,
  isLiveBoardTaskId,
  parseLinearTaskId,
  LIVE_BOARD,
} from './task-id-namespace.js';

import {
  auditWriterBoards,
  auditLiveBoardCoverage,
  summarizeBoardTargeting,
  EXEMPT_EVENTS,
  HEALTH_ROW_NAME,
  DEFAULT_MIN_BOARD_ROWS,
  DEFAULT_RECENCY_HOURS,
} from './board-targeting-audit.js';

const NOW = Date.parse('2026-09-15T20:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();

function rows(event, { live = 0, retired = 0, ageHours = 1 } = {}) {
  const out = [];
  for (let i = 0; i < live; i += 1) out.push({ ts: hoursAgo(ageHours), event, taskId: `linear:BRO-${1000 + i}` });
  for (let i = 0; i < retired; i += 1) out.push({ ts: hoursAgo(ageHours), event, taskId: String(1000 + i) });
  return out;
}

// ── namespace classifier ───────────────────────────────────────────────────

test('classifyTaskIdBoard: the three namespaces the dispatch ledger actually carries', () => {
  assert.equal(classifyTaskIdBoard('linear:BRO-3423'), 'linear');
  assert.equal(classifyTaskIdBoard('1812'), 'notion');
  // Real non-board ids from the live ledger — these must never count as
  // mis-targeting, or every monitor tick would read as a retired-board write.
  assert.equal(classifyTaskIdBoard('on-monitor-2026-09-14'), 'non-board');
  assert.equal(classifyTaskIdBoard('sweep'), 'non-board');
  assert.equal(classifyTaskIdBoard('watchdog'), 'non-board');
  // Absent / malformed ids are non-board, never a silent 'notion'.
  assert.equal(classifyTaskIdBoard(null), 'non-board');
  assert.equal(classifyTaskIdBoard(undefined), 'non-board');
  assert.equal(classifyTaskIdBoard(''), 'non-board');
  assert.equal(classifyTaskIdBoard('linear:bro-1'), 'non-board', 'lowercase team key is not a valid Linear id');
  assert.equal(classifyTaskIdBoard('linear:BRO-3423; rm -rf /'), 'non-board', 'anchoring keeps shell interpolation safe');
});

test('classifyTaskIdBoard: team keys containing a digit (the divergence this module ended)', () => {
  // digest-autofix.js's old private copy was /^linear:([A-Z]+-\d+)$/, which
  // rejected this shape while linear-watchdog-source.js accepted it.
  assert.equal(classifyTaskIdBoard('linear:B2B-17'), 'linear');
  assert.equal(parseLinearTaskId('linear:B2B-17'), 'B2B-17');
  assert.equal(parseLinearTaskId('1812'), null);
  assert.ok(isLiveBoardTaskId('linear:BRO-1'));
  assert.ok(isRetiredBoardTaskId('1812'));
  assert.ok(!isRetiredBoardTaskId('linear:BRO-1'));
});

// ── writer arm ─────────────────────────────────────────────────────────────

test('auditWriterBoards: a currently mis-targeted writer fails', () => {
  const r = auditWriterBoards({ rows: rows('watchdog-redispatch', { live: 2, retired: 84, ageHours: 16 }), now: NOW });
  const w = r.writers.find((x) => x.event === 'watchdog-redispatch');
  assert.equal(w.verdict, 'fail');
  assert.equal(w.retired, 84);
  assert.equal(w.live, 2);
  assert.ok(w.retiredFraction > 0.9);
  assert.equal(r.failing.length, 1);
});

test('auditWriterBoards: a healthy writer passes and does not drag others down', () => {
  const r = auditWriterBoards({
    rows: [...rows('launch', { live: 104 }), ...rows('watchdog-redispatch', { live: 2, retired: 84, ageHours: 16 })],
    now: NOW,
  });
  assert.equal(r.writers.find((x) => x.event === 'launch').verdict, 'ok');
  assert.deepEqual(r.failing.map((x) => x.event), ['watchdog-redispatch']);
});

test('auditWriterBoards: a landed fix self-clears instead of alarming for a whole window', () => {
  // The bad ratio is still in the window, but nothing retired is recent. This
  // is the 2026-09-15 shape: the fix landed mid-window and the window is still
  // full of pre-fix rows. It must be visible, not an alarm.
  const r = auditWriterBoards({
    rows: [
      ...rows('watchdog-redispatch', { retired: 84, ageHours: DEFAULT_RECENCY_HOURS + 12 }),
      ...rows('watchdog-redispatch', { live: 4, ageHours: 1 }),
    ],
    now: NOW,
  });
  const w = r.writers.find((x) => x.event === 'watchdog-redispatch');
  assert.equal(w.verdict, 'clearing');
  assert.equal(r.failing.length, 0, 'a fixed dispatcher must not keep paging');
});

test('auditWriterBoards: too few board rows is insufficient-data, never a pass or a fail', () => {
  const r = auditWriterBoards({ rows: rows('launch-refused', { live: 2, retired: 3 }), now: NOW });
  const w = r.writers.find((x) => x.event === 'launch-refused');
  assert.equal(w.boardRows, 5);
  assert.ok(w.boardRows < DEFAULT_MIN_BOARD_ROWS);
  assert.equal(w.verdict, 'insufficient-data');
  assert.equal(r.failing.length, 0);
});

test('auditWriterBoards: exempt reconciliation events are skipped, non-board ids ignored', () => {
  const r = auditWriterBoards({
    rows: [
      ...rows('prune-closed', { retired: 40 }),
      { ts: hoursAgo(1), event: 'prune', taskId: 'sweep' },
      { ts: hoursAgo(1), event: 'launch', taskId: 'on-monitor-2026-09-14' },
    ],
    now: NOW,
  });
  assert.equal(r.failing.length, 0);
  assert.ok(r.exemptEvents.includes('prune-closed'));
  assert.equal(r.writers.find((x) => x.event === 'launch'), undefined,
    'a non-board id must not create a writer row at all');
});

test('auditWriterBoards: rows outside the window, unparseable or in the future are not evidence', () => {
  const r = auditWriterBoards({
    rows: [
      ...rows('watchdog-redispatch', { retired: 84, ageHours: 24 * 30 }), // outside window
      { ts: 'not-a-date', event: 'watchdog-redispatch', taskId: '1' },
      { ts: new Date(NOW + 864e5).toISOString(), event: 'watchdog-redispatch', taskId: '2' },
      null,
      'garbage',
    ],
    now: NOW,
  });
  assert.equal(r.failing.length, 0);
  assert.equal(r.writers.length, 0);
});

test('auditWriterBoards: a brand-new event name is audited from its first row, no edit required', () => {
  // The point of the deny-list. A future dispatcher writing an event name
  // nobody has seen before must be covered by default.
  const r = auditWriterBoards({ rows: rows('some-future-dispatcher-v9', { retired: 30, ageHours: 2 }), now: NOW });
  assert.deepEqual(r.failing.map((x) => x.event), ['some-future-dispatcher-v9']);
});

// ── coverage arm ───────────────────────────────────────────────────────────

test('auditLiveBoardCoverage: a live board automation never touches fails', () => {
  const eligibleIds = Array.from({ length: 137 }, (_, i) => `linear:BRO-${i}`);
  const everTouchedIds = new Set(eligibleIds.slice(0, 15));
  const c = auditLiveBoardCoverage({ eligibleIds, everTouchedIds });
  assert.equal(c.verdict, 'fail');
  assert.equal(c.eligibleCount, 137);
  assert.equal(c.neverTouched, 122);
  assert.ok(c.neverTouchedSample.length > 0, 'must name examples the owner can go look at');
});

test('auditLiveBoardCoverage: a well-drained board passes', () => {
  const eligibleIds = Array.from({ length: 100 }, (_, i) => `linear:BRO-${i}`);
  const c = auditLiveBoardCoverage({ eligibleIds, everTouchedIds: new Set(eligibleIds.slice(0, 60)) });
  assert.equal(c.verdict, 'ok');
});

test('auditLiveBoardCoverage: a failed or TRUNCATED fetch is unknown, never a pass', () => {
  // fetchLinearWatchdogTasks returns ok:false both for an outage and for
  // hitting its page cap on a large backlog. Reading either as "nothing
  // eligible" would report a clean bill of health on the exact condition the
  // check exists to catch.
  const c = auditLiveBoardCoverage({ ok: false, reason: 'linear-scan-truncated: hit maxPages=30' });
  assert.equal(c.verdict, 'unknown');
  assert.equal(c.eligibleCount, null);
  assert.match(c.reason, /truncated/);
});

test('auditLiveBoardCoverage: too few armed issues is insufficient-data', () => {
  const c = auditLiveBoardCoverage({ eligibleIds: ['linear:BRO-1', 'linear:BRO-2'], everTouchedIds: new Set() });
  assert.equal(c.verdict, 'insufficient-data');
});

// ── summary / health row ───────────────────────────────────────────────────

test('summarizeBoardTargeting: a blind audit is an error, never an OK', () => {
  // The regression that motivated this: run from a worktree, where the
  // gitignored Mac-local ledger does not exist, the first version read zero
  // rows and printed "OK — all writers targeting the live board".
  const row = summarizeBoardTargeting({
    writerAudit: auditWriterBoards({ rows: [], now: NOW }),
    coverage: null,
    now: NOW,
    blind: true,
    primaryLedger: 'data/audit/dispatch-ledger.jsonl',
  });
  assert.equal(row.status, 'error');
  assert.match(row.message, /blind, not clean/);
  assert.match(row.message, /dispatch-ledger\.jsonl/);
  assert.equal(row.details.blind, true);
});

test('summarizeBoardTargeting: emits the {status,name,message,hint} health-row shape', () => {
  // send-morning-digest.js pushes this straight into sections.health.errors,
  // which drives the digest subject line — so the shape is load-bearing.
  const row = summarizeBoardTargeting({
    writerAudit: auditWriterBoards({ rows: rows('watchdog-redispatch', { live: 2, retired: 84, ageHours: 16 }), now: NOW }),
    coverage: null,
    now: NOW,
  });
  assert.equal(row.status, 'error');
  assert.equal(row.name, HEALTH_ROW_NAME);
  // renderHealthScoreboard() splits the category off the prefix before ':',
  // so a name without one invents a stray one-row category in the email.
  assert.ok(row.name.includes(':'), 'health-row name needs a "Category: detail" shape');
  assert.equal(typeof row.message, 'string');
  assert.ok(row.message.includes('watchdog-redispatch'));
  assert.ok(row.message.includes(LIVE_BOARD));
  assert.equal(typeof row.hint, 'string');
});

test('summarizeBoardTargeting: healthy still says what it checked', () => {
  const row = summarizeBoardTargeting({
    writerAudit: auditWriterBoards({ rows: rows('launch', { live: 104 }), now: NOW }),
    coverage: auditLiveBoardCoverage({ ok: false, reason: 'no token' }),
    now: NOW,
  });
  assert.equal(row.status, 'ok');
  // A check whose healthy output is silence is a check nobody can tell is
  // still running — and an UNKNOWN coverage arm must say so out loud.
  assert.match(row.message, /audited dispatch writer/);
  assert.match(row.message, /UNKNOWN/);
});

test('summarizeBoardTargeting: a failing coverage arm alone is enough to raise the error', () => {
  const eligibleIds = Array.from({ length: 137 }, (_, i) => `linear:BRO-${i}`);
  const row = summarizeBoardTargeting({
    writerAudit: auditWriterBoards({ rows: rows('launch', { live: 104 }), now: NOW }),
    coverage: auditLiveBoardCoverage({ eligibleIds, everTouchedIds: new Set() }),
    now: NOW,
  });
  assert.equal(row.status, 'error');
  assert.match(row.message, /never appeared in the dispatch ledger/);
});

// ── the inventory guard ────────────────────────────────────────────────────

test('every event name the real dispatch ledgers carry is either exempt or audited', () => {
  // Measured 2026-09-15 across all three dispatch ledgers (the full set of
  // event names that have ever been written with a board-namespace taskId).
  // This is a fixture rather than a live read on purpose: the ledgers are
  // gitignored and Mac-local, so a live read would silently pass in CI.
  const OBSERVED_EVENTS = [
    'amend', 'dead', 'drain-dispatch', 'job-abandoned', 'job-done', 'job-failed',
    'job-orphan-suspect', 'job-orphaned', 'job-retried', 'job-spawned', 'launch',
    'launch-refused', 'prune', 'prune-closed', 'remapped', 'restart-hold',
    'stall-sweep-attempted', 'vanish-epoch', 'vanished', 'watchdog-park',
    'watchdog-redispatch', 'watchdog-resurrect',
  ];

  const auditedRows = OBSERVED_EVENTS.flatMap((e) => rows(e, { retired: DEFAULT_MIN_BOARD_ROWS + 2, ageHours: 1 }));
  const r = auditWriterBoards({ rows: auditedRows, now: NOW });
  const audited = new Set(r.writers.map((w) => w.event));
  const exempt = new Set(Object.keys(EXEMPT_EVENTS));

  for (const e of OBSERVED_EVENTS) {
    assert.ok(audited.has(e) || exempt.has(e),
      `event "${e}" is neither audited nor explicitly exempt — a dispatcher writing it would be invisible, which is the BRO-3423 failure`);
  }

  // The dispatcher events that were 100% retired-board on 2026-09-15 and that
  // the original four-event allow-list would have missed entirely.
  for (const e of ['stall-sweep-attempted', 'amend', 'watchdog-park', 'drain-dispatch']) {
    assert.ok(audited.has(e) && !exempt.has(e),
      `"${e}" is real dispatcher activity and must be audited, not exempt`);
  }
});

test('the exempt list stays small and every entry carries a justification', () => {
  const entries = Object.entries(EXEMPT_EVENTS);
  assert.ok(entries.length <= 8, `EXEMPT_EVENTS has grown to ${entries.length} — every entry is a place a mis-targeted dispatcher can hide`);
  for (const [name, why] of entries) {
    assert.equal(typeof why, 'string');
    assert.ok(why.length > 15, `exemption "${name}" needs a real justification, got "${why}"`);
  }
});
