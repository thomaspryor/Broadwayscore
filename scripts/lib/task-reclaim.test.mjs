import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  classifyReclaimable, reclaimedTaskShape, supersededTaskShape,
  taskBranchEvidence, notionMarkerOf, normalizeSubject, indexLiveTasks,
} = require('./task-reclaim.js');

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const hAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const nid = (n) => `aaaa${n}aaa-1111-2222-3333-444444444444`;
const trapped = (id, over = {}) => ({
  id: String(id),
  status: 'in_progress',
  subject: `Some trapped card subject for #${id}`,
  description: `[notion:${nid(id)}] P1 Next · In progress · Product\nbody`,
  ...over,
});
const classify = (tasks, ctx = {}) => classifyReclaimable(tasks, { now: NOW, ...ctx });
const actionOf = (rows, id) => (rows.find((r) => r.id === String(id)) || {}).action;

// ── the happy path ─────────────────────────────────────────────────────────
test('reclaims an idle, unstarted, unduplicated trapped task', () => {
  const rows = classify([trapped(9)], { cardOf: () => ({ status: 'In progress', lastEditedAt: hAgo(72) }) });
  assert.equal(actionOf(rows, 9), 'reclaim');
});

// ── C1: the duplicate-live blocker ─────────────────────────────────────────
test('C1: skips a trapped task whose Notion marker already has a LIVE twin', () => {
  const live = [{ id: '1164', subject: 'Totally different title', description: `[notion:${nid(9)}] P0 Now · Not started · Data` }];
  const rows = classify([trapped(9)], { liveTasks: live, cardOf: () => ({ lastEditedAt: hAgo(72) }) });
  assert.equal(actionOf(rows, 9), 'skip-duplicate-live');
  assert.equal(rows[0].detail, '1164');
});

test('C1: skips a MARKER-LESS trapped task whose SUBJECT already has a live twin', () => {
  const t = trapped(5, { description: 'no marker at all here' });
  const live = [{ id: '1176', subject: 'some TRAPPED card, subject for #5!', description: 'unrelated' }];
  const rows = classify([t], { liveTasks: live });
  assert.equal(actionOf(rows, 5), 'skip-duplicate-live', 'normalized-subject fallback must catch the 5 marker-less tasks');
});

// ── C2: marker match must scan the WHOLE description, not line 1 ────────────
test('C2: finds the notion marker even when a zombie-sweep note was prepended', () => {
  const t = trapped(9, { description: `[zombie-sweep 2026-08-01] reopened — sat In progress 3d.\n\n[notion:${nid(9)}] P1 Next · In progress · Product` });
  assert.equal(notionMarkerOf(t), nid(9), 'a line-1-anchored match under-counted the live-twin population as 3 instead of 14');
  const live = [{ id: '1170', subject: 'unrelated', description: `[notion:${nid(9)}] P1 Next` }];
  assert.equal(actionOf(classify([t], { liveTasks: live }), 9), 'skip-duplicate-live');
});

// ── W1: breadcrumbs must never displace line 1 ─────────────────────────────
test('W1: reclaim never prepends to description — line 1 keeps its [notion: anchor', () => {
  const out = reclaimedTaskShape(trapped(9), { now: NOW });
  const firstLine = out.description.split('\n')[0];
  assert.match(firstLine, /^\[notion:/, 'taskPriority anchors ^[notion: on line 1; prepending makes every reclaimed task invisible to p01Queue');
  assert.match(firstLine, /P1 Next/, 'the priority token taskPriority reads must survive verbatim');
  assert.equal(out.status, 'pending');
  assert.equal(out.owner, null);
  assert.ok(out.reclaimedFromArchiveAt && out.reclaimedFromArchiveReason);
});

test('W2: the line-1 status segment stops claiming In progress', () => {
  const out = reclaimedTaskShape(trapped(9), { now: NOW });
  assert.match(out.description.split('\n')[0], /· Not started ·/);
  assert.equal(out.description.split('\n')[1], 'body', 'body lines are untouched');
});

test('reclaim leaves a description with no status segment alone rather than mangling it', () => {
  const out = reclaimedTaskShape(trapped(9, { description: 'bare description' }), { now: NOW });
  assert.equal(out.description, 'bare description');
});

// ── liveness guards (borrowed from sweepUntrackedInProgress) ───────────────
test('skips a task whose lease is still held by a live claude process', () => {
  assert.equal(actionOf(classify([trapped(9)], { leaseAliveOf: () => true }), 9), 'skip-live');
});

test('skips a task with a live cmux tab titled like its subject', () => {
  const rows = classify([trapped(9)], { liveTabOf: () => 'workspace:42' });
  assert.equal(actionOf(rows, 9), 'skip-live');
  assert.equal(rows[0].detail, 'workspace:42');
});

// ── the neverStarted / startedAndLost split ────────────────────────────────
test('startedAndLost WITH branch evidence parks — never auto-reclaims (the data-loss case)', () => {
  const rows = classify([trapped(1416)], {
    startedIds: new Set(['1416']),
    branchEvidenceOf: () => ({ hasEvidence: true, matches: ['worktree-1416-url-downgrade-guard'] }),
    cardOf: () => ({ lastEditedAt: hAgo(72) }),
  });
  assert.equal(actionOf(rows, 1416), 'park-started');
  assert.deepEqual(rows[0].detail, ['worktree-1416-url-downgrade-guard'], 'the matched branch must be reported so a false positive is visible');
});

// Superseded by ship-check B3 and replaced by the B3 tests below: this used to
// assert that a startedAndLost task with no matching branch was reclaimable.
// Measured on the real corpus, 653 worktree-prefixed branches carry no task id
// at all, so "no branch matched" means the detector could not answer — and
// reclaiming on that is the data-loss direction the card forbids.
test('startedAndLost never reclaims on a branch-detector miss', () => {
  const rows = classify([trapped(1416)], {
    startedIds: new Set(['1416']),
    branchEvidenceOf: () => ({ hasEvidence: false, matches: [] }),
    cardOf: () => ({ lastEditedAt: hAgo(72) }),
  });
  assert.notEqual(actionOf(rows, 1416), 'reclaim');
});

test('neverStarted is never branch-checked at all', () => {
  let asked = false;
  classify([trapped(9)], {
    startedIds: new Set(),
    branchEvidenceOf: () => { asked = true; return { hasEvidence: true, matches: ['x'] }; },
    cardOf: () => ({ lastEditedAt: hAgo(72) }),
  });
  assert.equal(asked, false);
});

// ── taskBranchEvidence ─────────────────────────────────────────────────────
test('taskBranchEvidence matches every real dispatch naming shape', () => {
  const sources = {
    branches: ['worktree-1416-url-downgrade-guard', 'worktree-task-1075-observable', 'task-752-clean', 'remotes/origin/worktree-653-corpus'],
    worktreePaths: ['/repo/.claude/worktrees/1461-dead-commit-gate'],
  };
  for (const id of [1416, 1075, 752, 653, 1461]) {
    assert.equal(taskBranchEvidence(id, sources).hasEvidence, true, `id ${id} should match`);
  }
});

test('taskBranchEvidence does not match a task id that is a PREFIX of a longer id', () => {
  const r = taskBranchEvidence(146, { branches: ['worktree-1146-wrongshow-autoclear'] });
  assert.equal(r.hasEvidence, false, 'id 146 must not claim branch worktree-1146-*');
});

test('taskBranchEvidence returns the matched names, and is inert on a non-numeric id', () => {
  assert.deepEqual(taskBranchEvidence(752, { branches: ['task-752-clean'] }).matches, ['task-752-clean']);
  assert.equal(taskBranchEvidence('sweep', { branches: ['task-752-clean'] }).hasEvidence, false);
});

// ── Notion-derived guards ──────────────────────────────────────────────────
test('a freshly edited card is left alone', () => {
  const rows = classify([trapped(9)], { cardOf: () => ({ lastEditedAt: hAgo(1) }) });
  assert.equal(actionOf(rows, 9), 'skip-fresh');
});

test('a card with a filled Outcome parks instead of reopening finished work', () => {
  const rows = classify([trapped(9)], { cardOf: () => ({ lastEditedAt: hAgo(72), outcome: 'FINDINGS.md written.' }) });
  assert.equal(actionOf(rows, 9), 'park-outcome');
});

test('E-i: a Done card with an EMPTY Outcome still parks, never reclaims', () => {
  const rows = classify([trapped(9)], { cardOf: () => ({ status: 'Done', lastEditedAt: hAgo(72), outcome: '' }) });
  assert.equal(actionOf(rows, 9), 'park-outcome');
});

test('a failed card fetch refuses to act rather than guessing', () => {
  assert.equal(actionOf(classify([trapped(9)], { cardOf: () => null }), 9), 'skip-card-unavailable');
});

test('a marker-less task with no live twin is reclaimed without any Notion call', () => {
  let asked = false;
  const rows = classify([trapped(5, { description: 'no marker' })], { cardOf: () => { asked = true; return null; } });
  assert.equal(actionOf(rows, 5), 'reclaim');
  assert.equal(asked, false);
});

// ── BSC-Daily ──────────────────────────────────────────────────────────────
test('a BSC Daily card is closed as superseded, not returned to the pool', () => {
  const t = trapped(1360, { subject: 'BSC Daily: Stuck pipeline items' });
  assert.equal(actionOf(classify([t]), 1360), 'close-superseded');
  const out = supersededTaskShape(t, { now: NOW });
  assert.equal(out.status, 'completed');
  assert.ok(out.reclaimClosedReason.includes('superseded'));
});

test('a live twin outranks the BSC-Daily close (4 of the 14 twins are BSC Daily)', () => {
  const t = trapped(1085, { subject: 'BSC Daily: Feedback: 1 of 2 needs you' });
  const live = [{ id: '1357', subject: 'BSC Daily: Feedback: 1 of 2 needs you', description: 'x' }];
  assert.equal(actionOf(classify([t], { liveTasks: live }), 1085), 'skip-duplicate-live');
});

// ── helpers ────────────────────────────────────────────────────────────────
test('indexLiveTasks keeps the FIRST id per key so results are order-stable', () => {
  const { bySubject } = indexLiveTasks([{ id: '10', subject: 'Same' }, { id: '20', subject: 'same!' }]);
  assert.equal(bySubject.get('same'), '10');
});

test('normalizeSubject collapses punctuation and case', () => {
  assert.equal(normalizeSubject("P1: Don't — break, this!"), 'p1 don t break this');
});

test('classifyReclaimable tolerates null/empty input', () => {
  assert.deepEqual(classifyReclaimable(null, { now: NOW }), []);
  assert.deepEqual(classifyReclaimable([null], { now: NOW }), []);
});

// Regression: the first REAL --fix run crashed with "parkedTaskShape is not a
// function" because the export list was missed. The dry-run path never calls
// the shape helpers, so only executing the real thing surfaced it. Assert the
// whole public surface the executor reaches for by name.
test('every shape helper the --fix executor calls is actually exported', () => {
  const mod = require('./task-reclaim.js');
  for (const name of ['classifyReclaimable', 'reclaimedTaskShape', 'supersededTaskShape', 'parkedTaskShape', 'taskBranchEvidence']) {
    assert.equal(typeof mod[name], 'function', `${name} must be exported — the executor calls it by name`);
  }
});

test('parkedTaskShape writes a terminal, non-dispatchable status', () => {
  const { parkedTaskShape } = require('./task-reclaim.js');
  const out = parkedTaskShape({ id: '9', status: 'in_progress', owner: 'x' }, { now: NOW, reason: 'card already records a completed Outcome' });
  assert.equal(out.status, 'completed', 'never pending — that is exactly what arms p01Queue and zombie-tab-sweep');
  assert.equal(out.owner, null);
  assert.match(out.reclaimParkedReason, /completed Outcome/);
});

test('every decision carries the card status the executor gates its Notion write on', () => {
  const done = classify([trapped(9)], { cardOf: () => ({ status: 'Done', lastEditedAt: hAgo(72) }) });
  assert.equal(done[0].action, 'park-outcome');
  assert.equal(done[0].cardStatus, 'Done', 'without this the executor would downgrade an already-Done card to Paused');

  const inprog = classify([trapped(9)], { cardOf: () => ({ status: 'In progress', lastEditedAt: hAgo(72) }) });
  assert.equal(inprog[0].action, 'reclaim');
  assert.equal(inprog[0].cardStatus, 'In progress');

  const noCard = classify([trapped(5, { description: 'no marker' })], {});
  assert.equal(noCard[0].cardStatus, null, 'a task with no card must report null, not a stale value from a previous loop iteration');
});

// ── ship-check B1: the self-twin burial ────────────────────────────────────
test('B1: a task that is its OWN live twin resumes the interrupted reclaim, never parks', () => {
  // The crash window the design tolerates: live copy written, archive unlink
  // never happened. Parking here would stamp archive/<id>.json to `completed`,
  // and loadTasksUnioned lets a completed ARCHIVE record beat the live one —
  // burying the reclaimed task permanently with nothing left to detect it.
  const live = [{ id: '900', subject: 'Some trapped card subject for #900', description: `[notion:${nid(900)}] P1 Next` }];
  const rows = classify([trapped(900)], { liveTasks: live, cardOf: () => ({ lastEditedAt: hAgo(72) }) });
  assert.equal(actionOf(rows, 900), 'resume-interrupted-reclaim');
  assert.notEqual(actionOf(rows, 900), 'skip-duplicate-live', 'parking a self-twin permanently buries the task this module exists to rescue');
});

test('B1: a twin with a DIFFERENT id is still a real duplicate', () => {
  const live = [{ id: '1164', subject: 'unrelated', description: `[notion:${nid(9)}] P1 Next` }];
  assert.equal(actionOf(classify([trapped(9)], { liveTasks: live }), 9), 'skip-duplicate-live');
});

// ── ship-check B3: started work parks even with no branch found ────────────
test('B3: startedAndLost parks even when NO branch matches — absence of evidence is not evidence of absence', () => {
  const rows = classify([trapped(1416)], {
    startedIds: new Set(['1416']),
    branchEvidenceOf: () => ({ hasEvidence: false, matches: [] }),
    cardOf: () => ({ lastEditedAt: hAgo(72) }),
  });
  assert.equal(actionOf(rows, 1416), 'park-started', '653 worktree branches carry no task id, so a miss cannot license a reclaim');
  assert.match(rows[0].reason, /cannot prove absence/);
});

test('B3: branch evidence still enriches the reason when it IS found', () => {
  const rows = classify([trapped(1416)], {
    startedIds: new Set(['1416']),
    branchEvidenceOf: () => ({ hasEvidence: true, matches: ['worktree-1416-x'] }),
    cardOf: () => ({ lastEditedAt: hAgo(72) }),
  });
  assert.equal(actionOf(rows, 1416), 'park-started');
  assert.match(rows[0].reason, /may hold real commits/);
});

// ── other ship-check findings ──────────────────────────────────────────────
test('a card with no usable lastEditedAt is skipped, not treated as idle', () => {
  const rows = classify([trapped(9)], { cardOf: () => ({ status: 'In progress' }) });
  assert.equal(actionOf(rows, 9), 'skip-card-unavailable', 'sweepUntrackedInProgress skips outright; falling through would flip an unknown-age card');
});

test('notionMarkerOf reads metadata.notionCard first, matching notionIdOfTask', () => {
  const { notionMarkerOf } = require('./task-reclaim.js');
  const t = { description: `[notion:${nid(1)}] P1`, metadata: { notionCard: nid(2).toUpperCase() } };
  assert.equal(notionMarkerOf(t), nid(2), 'a metadata-only task would otherwise skip every Notion guard');
});

test('guard precedence: a live lease outranks every other signal, including a twin', () => {
  const live = [{ id: '1164', subject: 'x', description: `[notion:${nid(9)}] P1` }];
  assert.equal(actionOf(classify([trapped(9)], { liveTasks: live, leaseAliveOf: () => true }), 9), 'skip-live');
});

// ── follow-up review F1: the SHADOWED self-twin ────────────────────────────
test('F1: own-id wins even when a DIFFERENT live task shadows the twin lookup', () => {
  // The live dir holds both this task's interrupted-reclaim copy (#9) and a
  // genuine duplicate (#1164) carrying the same marker. indexLiveTasks is
  // first-match-wins over an unsorted readdir, so #1164 can win the lookup —
  // and the old `String(twin) === id` check then read false, parked #9, and
  // stamped archive/9.json to completed while live/9.json sat at pending.
  // loadTasksUnioned lets that completed archive record win: the B1 burial.
  const live = [
    { id: '1164', subject: 'unrelated', description: `[notion:${nid(9)}] P1 Next` },
    { id: '9', subject: 'Some trapped card subject for #9', description: `[notion:${nid(9)}] P1 Next`, reclaimedFromArchiveAt: '2026-08-14T00:00:00.000Z' },
  ];
  const rows = classify([trapped(9)], { liveTasks: live, cardOf: () => ({ lastEditedAt: hAgo(72) }) });
  assert.equal(actionOf(rows, 9), 'resume-interrupted-reclaim',
    'a task already present in the live dir is never a duplicate of something else — it is its own interrupted reclaim');
});

test('F1: a twin with a different id still parks when this task is NOT live', () => {
  const live = [{ id: '1164', subject: 'unrelated', description: `[notion:${nid(9)}] P1 Next` }];
  assert.equal(actionOf(classify([trapped(9)], { liveTasks: live }), 9), 'skip-duplicate-live');
});

test('F1: indexLiveTasks exposes plain id membership', () => {
  const { ids } = indexLiveTasks([{ id: '9', subject: 'a' }, { id: 1164, subject: 'b' }]);
  assert.equal(ids.has('9'), true);
  assert.equal(ids.has('1164'), true, 'numeric ids must be normalised to strings');
  assert.equal(ids.has('7'), false);
});
