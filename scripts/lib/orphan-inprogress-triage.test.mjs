import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyOrphanInProgress } = require('./orphan-inprogress-triage.js');

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const hAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const nid = (n) => `aaaa${n}aaa-1111-2222-3333-444444444444`;
const orphan = (id, over = {}) => ({
  id: String(id),
  status: 'in_progress',
  subject: `Orphan task #${id}`,
  description: `[notion:${nid(id)}] P1 Next · In progress · Product\nbody`,
  ...over,
});
const classify = (tasks, ctx = {}) => classifyOrphanInProgress(tasks, { now: NOW, ...ctx });
const bucketOf = (rows, id) => (rows.find((r) => r.id === String(id)) || {}).bucket;
const actionOf = (rows, id) => (rows.find((r) => r.id === String(id)) || {}).action;

test('card status Done -> FINISHED', () => {
  const rows = classify([orphan(1)], { cardOf: () => ({ status: 'Done', lastEditedAt: hAgo(200) }) });
  assert.equal(bucketOf(rows, 1), 'FINISHED');
  assert.equal(actionOf(rows, 1), 'card-done');
});

test('card status Archived -> STALE, not FINISHED', () => {
  const rows = classify([orphan(2)], { cardOf: () => ({ status: 'Archived', lastEditedAt: hAgo(200) }) });
  assert.equal(bucketOf(rows, 2), 'STALE');
});

test('card status Cancelled -> STALE', () => {
  const rows = classify([orphan(3)], { cardOf: () => ({ status: 'Cancelled', lastEditedAt: hAgo(200) }) });
  assert.equal(bucketOf(rows, 3), 'STALE');
});

test('BSC Daily subject -> STALE regardless of card', () => {
  const t = orphan(4, { subject: 'BSC Daily: something' });
  const rows = classify([t], { cardOf: () => ({ status: 'In progress', lastEditedAt: hAgo(200) }) });
  assert.equal(bucketOf(rows, 4), 'STALE');
  assert.equal(actionOf(rows, 4), 'close-superseded');
});

// ── the freshness gate, and the Paused bypass (task #1705's own finding) ───
test('card edited recently and status In progress -> NEEDS-REVIEW (skip-fresh)', () => {
  const rows = classify([orphan(5)], { cardOf: () => ({ status: 'In progress', lastEditedAt: hAgo(2) }) });
  assert.equal(bucketOf(rows, 5), 'NEEDS-REVIEW');
  assert.equal(actionOf(rows, 5), 'skip-fresh');
});

test('card status Paused bypasses the freshness gate even when edited minutes ago', () => {
  // Real-backlog shape: bsc-reconcile.js's sweepUntrackedInProgress sets a
  // card to Paused the moment it decides "needs a human", which itself bumps
  // lastEditedAt — so gating on recency would forever block exactly the
  // population that sweep already deferred to this classifier.
  const rows = classify([orphan(6)], { cardOf: () => ({ status: 'Paused', outcome: '', lastEditedAt: hAgo(0.1) }) });
  assert.notEqual(actionOf(rows, 6), 'skip-fresh');
});

// ── outcome corroboration (card #1159 in the real backlog) ─────────────────
test('Outcome present + corroborated -> FINISHED', () => {
  const rows = classify([orphan(7)], {
    cardOf: () => ({ status: 'Paused', outcome: 'Shipped scripts/x.js', lastEditedAt: hAgo(72) }),
    corroborateOutcomeOf: () => ({ hasEvidence: true, evidence: ['keyFile scripts/x.js exists'] }),
  });
  assert.equal(bucketOf(rows, 7), 'FINISHED');
  assert.equal(actionOf(rows, 7), 'outcome-corroborated');
});

test('Outcome present but uncorroborated -> NEEDS-REVIEW, never guessed FINISHED or LOST', () => {
  const rows = classify([orphan(8)], {
    cardOf: () => ({ status: 'Paused', outcome: 'Says it shipped something', lastEditedAt: hAgo(72) }),
    corroborateOutcomeOf: () => ({ hasEvidence: false, evidence: [] }),
  });
  assert.equal(bucketOf(rows, 8), 'NEEDS-REVIEW');
  assert.equal(actionOf(rows, 8), 'park-outcome');
});

// ── no Outcome: started vs never-started (audit-archived-in-progress.js's split) ──
test('no Outcome, never dispatched, idle -> LOST', () => {
  const rows = classify([orphan(9)], {
    cardOf: () => ({ status: 'In progress', outcome: '', lastEditedAt: hAgo(72) }),
    startedIds: new Set(),
  });
  assert.equal(bucketOf(rows, 9), 'LOST');
  assert.equal(actionOf(rows, 9), 'reclaim');
});

test('no Outcome, WAS dispatched before, no branch evidence -> NEEDS-REVIEW, never auto-reclaimed', () => {
  const rows = classify([orphan(10)], {
    cardOf: () => ({ status: 'In progress', outcome: '', lastEditedAt: hAgo(72) }),
    startedIds: new Set(['10']),
    branchEvidenceOf: () => ({ hasEvidence: false, matches: [] }),
  });
  assert.equal(bucketOf(rows, 10), 'NEEDS-REVIEW');
  assert.equal(actionOf(rows, 10), 'park-started');
});

test('no Outcome, WAS dispatched, branch evidence exists -> NEEDS-REVIEW naming the branch', () => {
  const rows = classify([orphan(11)], {
    cardOf: () => ({ status: 'In progress', outcome: '', lastEditedAt: hAgo(72) }),
    startedIds: new Set(['11']),
    branchEvidenceOf: () => ({ hasEvidence: true, matches: ['worktree-11-fix'] }),
  });
  assert.equal(bucketOf(rows, 11), 'NEEDS-REVIEW');
  assert.match(rows.find((r) => r.id === '11').reason, /worktree-11-fix/);
});

// ── no Notion card to consult at all ────────────────────────────────────────
test('no marker, git evidence -> FINISHED', () => {
  const t = orphan(12, { description: 'no notion marker in here' });
  const rows = classify([t], { gitEvidenceOf: (id) => (id === '12' ? { hasEvidence: true, commits: ['abc123 fix (task #12)'] } : { hasEvidence: false, commits: [] }) });
  assert.equal(bucketOf(rows, 12), 'FINISHED');
});

test('no marker, no git evidence, but a live branch names the task id -> NEEDS-REVIEW, not LOST', () => {
  // The exact real-backlog shape (#1147): description says in prose "branch
  // pushed to origin, NOT merged to main" and carries no [notion:] marker at
  // all, so the ONLY signal is branch evidence — this must never be reclaimed.
  const t = orphan(13, { description: 'Branch worktree-coverage-defects-13 PUSHED to origin, NOT merged to main.' });
  const rows = classify([t], { branchEvidenceOf: (id) => (id === '13' ? { hasEvidence: true, matches: ['worktree-coverage-defects-13'] } : { hasEvidence: false, matches: [] }) });
  assert.equal(bucketOf(rows, 13), 'NEEDS-REVIEW');
  assert.equal(actionOf(rows, 13), 'park-started');
});

test('no marker, no git evidence, no branch evidence -> LOST', () => {
  const t = orphan(14, { description: 'no notion marker, no branch, nothing' });
  const rows = classify([t], {});
  assert.equal(bucketOf(rows, 14), 'LOST');
});

// ── card fetch failure never guesses ────────────────────────────────────────
test('card fetch fails -> NEEDS-REVIEW (card-unavailable), never guessed', () => {
  const rows = classify([orphan(15)], { cardOf: () => null });
  assert.equal(bucketOf(rows, 15), 'NEEDS-REVIEW');
  assert.equal(actionOf(rows, 15), 'card-unavailable');
});

test('card has no usable lastEditedAt -> NEEDS-REVIEW (card-unavailable)', () => {
  const rows = classify([orphan(16)], { cardOf: () => ({ status: 'In progress', outcome: '' }) });
  assert.equal(bucketOf(rows, 16), 'NEEDS-REVIEW');
  assert.equal(actionOf(rows, 16), 'card-unavailable');
});

test('Outcome says "Duplicate of ..." -> STALE, never FINISHED or NEEDS-REVIEW', () => {
  const rows = classify([orphan(17)], {
    cardOf: () => ({ status: 'Paused', outcome: 'Duplicate of task #1673 (card X) — no independent deliverable.', lastEditedAt: hAgo(72) }),
    corroborateOutcomeOf: () => ({ hasEvidence: false, evidence: [] }),
  });
  assert.equal(bucketOf(rows, 17), 'STALE');
  assert.equal(actionOf(rows, 17), 'card-superseded');
});

test('Outcome says "on main card #N" -> STALE (satellite session-tracking card)', () => {
  const rows = classify([orphan(18)], {
    cardOf: () => ({ status: 'Paused', outcome: 'Confirmed live. Full outcome + evidence on main card #1249.', lastEditedAt: hAgo(72) }),
    corroborateOutcomeOf: () => ({ hasEvidence: false, evidence: [] }),
  });
  assert.equal(bucketOf(rows, 18), 'STALE');
});

test('Outcome says "Deprioritised ... do NOT auto-dispatch" -> STALE, not LOST', () => {
  const rows = classify([orphan(19)], {
    cardOf: () => ({ status: 'Paused', outcome: 'Deprioritised 2026-08-11: campaign ended. Do NOT auto-dispatch.', lastEditedAt: hAgo(72) }),
    corroborateOutcomeOf: () => ({ hasEvidence: false, evidence: [] }),
  });
  assert.equal(bucketOf(rows, 19), 'STALE');
});

test('Outcome has a FUTURE RECHECK-AFTER date -> NEEDS-REVIEW even with strong corroboration', () => {
  // Card #586 in the real backlog: real shipped code (keyFiles/commits both
  // corroborate), but the card's own latest note says it must stay open
  // until 2026-08-18/24 (live-traffic acceptance criteria). Corroboration
  // must never override this.
  const rows = classify([orphan(21)], {
    cardOf: () => ({ status: 'Paused', outcome: 'RECHECK-AFTER: 2026-08-24\n\nShipped and verified. keyFiles all exist.', lastEditedAt: hAgo(72) }),
    corroborateOutcomeOf: () => ({ hasEvidence: true, evidence: ['keyFile src/x.ts exists'] }),
  });
  assert.equal(bucketOf(rows, 21), 'NEEDS-REVIEW');
  assert.equal(actionOf(rows, 21), 'recheck-after-pending');
});

test('Outcome has only a PAST RECHECK-AFTER date -> corroboration still applies normally', () => {
  const rows = classify([orphan(22)], {
    cardOf: () => ({ status: 'Paused', outcome: 'RECHECK-AFTER: 2026-08-01\n\nShipped and verified.', lastEditedAt: hAgo(72) }),
    corroborateOutcomeOf: () => ({ hasEvidence: true, evidence: ['keyFile src/x.ts exists'] }),
  });
  assert.equal(bucketOf(rows, 22), 'FINISHED');
});

test('classifies every input exactly once', () => {
  const tasks = [orphan(20), orphan(21), orphan(22)];
  const rows = classify(tasks, { cardOf: () => ({ status: 'Done', lastEditedAt: hAgo(200) }) });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['20', '21', '22']);
});
