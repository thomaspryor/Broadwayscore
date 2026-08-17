// audit-card-relevance.test.mjs — task #1719. Requires the real exported
// classifier functions (CLAUDE.md §15) rather than re-implementing the
// rules here; every git/exec/fs check is injected via opts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  extractCommitShas,
  extractRecheckAfter,
  tokenizeTitle,
  titleOverlapScore,
  extractFileRefs,
  extractSymbols,
  extractReferencedPaths,
  checkAcceptanceHolds,
  checkCommitsOnMain,
  checkRecheckAfterDueAndVerified,
  checkStaleFiles,
  findDuplicateForCard,
  detectDoneSignals,
  classifyCard,
  classifyPool,
} = require('../lib/audit-card-relevance.js');
const { makeFileExists } = require('../audit-card-relevance.js');

function card(overrides = {}) {
  return {
    id: 'id-1', name: 'Fix the thing', url: 'https://example.com/1',
    priority: 'P1 Next', status: 'Not started', notes: '', outcome: '',
    ...overrides,
  };
}

// ── Required case 1: acceptance command passes → LIKELY-DONE ─────────────
test('classifyCard: card whose acceptance command passes -> LIKELY-DONE (acceptance-command-passes)', () => {
  const c = card({
    notes: '## Acceptance criteria\n`node --test scripts/lib/thing.test.mjs`',
  });
  const opts = { runAcceptanceCmd: (cmd) => ({ status: 'pass', detail: null }) };
  const result = classifyCard(c, [c], opts);
  assert.equal(result.verdict, 'LIKELY-DONE');
  assert.equal(result.evidence.type, 'acceptance-command-passes');
  assert.equal(result.evidence.cmd, 'node --test scripts/lib/thing.test.mjs');
});

test('checkAcceptanceHolds: null when command fails or is unverifiable', () => {
  const c = card({ notes: '## Acceptance criteria\n`node --test scripts/lib/thing.test.mjs`' });
  assert.equal(checkAcceptanceHolds(c, { runAcceptanceCmd: () => ({ status: 'fail' }) }), null);
  assert.equal(checkAcceptanceHolds(c, { runAcceptanceCmd: () => ({ status: 'unverifiable' }) }), null);
  assert.equal(checkAcceptanceHolds(c, {}), null); // no runAcceptanceCmd injected -> ambiguous, not evaluated
});

test('checkAcceptanceHolds: null when card names no runnable command (prose only)', () => {
  const c = card({ notes: '## Acceptance criteria\nManually verify it looks right.' });
  assert.equal(checkAcceptanceHolds(c, { runAcceptanceCmd: () => ({ status: 'pass' }) }), null);
});

// ── Required case 2: referenced commit already on main → LIKELY-DONE ─────
test('classifyCard: card whose referenced commit is on main -> LIKELY-DONE (commits-on-main)', () => {
  const c = card({ notes: 'Landed in commit `abc1234` already.' });
  const opts = { isCommitOnMain: (sha) => sha === 'abc1234' };
  const result = classifyCard(c, [c], opts);
  assert.equal(result.verdict, 'LIKELY-DONE');
  assert.equal(result.evidence.type, 'commits-on-main');
  assert.deepEqual(result.evidence.shas, ['abc1234']);
});

test('extractCommitShas: backticked and labeled forms only, no bare hex-looking prose', () => {
  assert.deepEqual(extractCommitShas('see `deadbee1` for details'), ['deadbee1']);
  assert.deepEqual(extractCommitShas('fixed in commit deadbee2 today'), ['deadbee2']);
  assert.deepEqual(extractCommitShas('SHA: deadbee3'), ['deadbee3']);
  // Bare, unlabeled hex-looking token in prose is NOT evidence.
  assert.deepEqual(extractCommitShas('issue affects deadbee4 somehow'), []);
  assert.deepEqual(extractCommitShas('no shas here'), []);
});

test('checkCommitsOnMain: null unless EVERY referenced sha is confirmed on main', () => {
  const c = card({ notes: 'commits `aaaaaaa` and `bbbbbbb` both landed.' });
  assert.equal(checkCommitsOnMain(c, { isCommitOnMain: (sha) => sha === 'aaaaaaa' }), null);
  const ok = checkCommitsOnMain(c, { isCommitOnMain: () => true });
  assert.equal(ok.type, 'commits-on-main');
  assert.equal(checkCommitsOnMain(c, {}), null); // not injected -> ambiguous
});

test('checkRecheckAfterDueAndVerified: due date passed + filled outcome + passing command -> evidence', () => {
  const c = card({
    notes: 'RECHECK-AFTER: 2026-08-01\n## Acceptance criteria\n`node --test scripts/lib/thing.test.mjs`',
    outcome: 'Held for 10 days straight.',
  });
  const opts = { now: new Date('2026-08-16T00:00:00Z'), runAcceptanceCmd: () => ({ status: 'pass' }) };
  const result = checkRecheckAfterDueAndVerified(c, opts);
  assert.equal(result.type, 'recheck-after-due-and-verified');
  assert.equal(result.recheckAfter, '2026-08-01');
});

test('checkRecheckAfterDueAndVerified: null when date not yet due, outcome empty, or no command', () => {
  const base = { notes: 'RECHECK-AFTER: 2026-09-01\n## Acceptance criteria\n`node --test scripts/lib/thing.test.mjs`', outcome: 'Held.' };
  const opts = { now: new Date('2026-08-16T00:00:00Z'), runAcceptanceCmd: () => ({ status: 'pass' }) };
  assert.equal(checkRecheckAfterDueAndVerified(card(base), opts), null); // not due yet
  assert.equal(checkRecheckAfterDueAndVerified(
    card({ notes: 'RECHECK-AFTER: 2026-08-01\n## Acceptance criteria\n`node --test x.test.mjs`', outcome: '' }),
    opts,
  ), null); // no filled outcome
  assert.equal(checkRecheckAfterDueAndVerified(
    card({ notes: 'RECHECK-AFTER: 2026-08-01', outcome: 'Held.' }),
    opts,
  ), null); // no runnable command at all
});

test('checkRecheckAfterDueAndVerified: same-day UTC-midnight boundary stays not-due (task #1722, code-review catch)', () => {
  // RECHECK-AFTER: 2026-08-16 parses to 2026-08-16T00:00:00Z. Unpadded, that
  // reads as "due" against a same-day 12:00 UTC `now` even though it is still
  // 2026-08-16 in the owner's US-Eastern timezone — the identical bug fixed
  // in scripts/lib/orphan-inprogress-triage.js for card #1226.
  const c = card({
    notes: 'RECHECK-AFTER: 2026-08-16\n## Acceptance criteria\n`node --test scripts/lib/thing.test.mjs`',
    outcome: 'Held for 10 days straight.',
  });
  const opts = { now: new Date('2026-08-16T12:00:00Z'), runAcceptanceCmd: () => ({ status: 'pass' }) };
  assert.equal(checkRecheckAfterDueAndVerified(c, opts), null);
});

// ── Required case 3: duplicate pair → LIKELY-DUPLICATE ────────────────────
test('classifyCard: high title-token overlap with another open card -> LIKELY-DUPLICATE', () => {
  const a = card({ id: 'a', name: 'Scraping v2: T4 was a yield regression' });
  const b = card({ id: 'b', name: 'Scraping v2: T4 yield regression still open' });
  const result = classifyCard(a, [a, b], {});
  assert.equal(result.verdict, 'LIKELY-DUPLICATE');
  assert.equal(result.evidence.type, 'duplicate-title-overlap');
  assert.equal(result.evidence.otherId, 'b');
});

test('classifyCard: shared file + shared symbol between two cards -> LIKELY-DUPLICATE (file+symbol wins over title)', () => {
  const a = card({ id: 'a', name: 'Fix the ledger bug', notes: 'In scripts/lib/dispatch-ledger.js the `recordEntry` function drops rows.' });
  const b = card({ id: 'b', name: 'Totally unrelated other title here', notes: 'scripts/lib/dispatch-ledger.js `recordEntry` also loses timestamps.' });
  const result = classifyCard(a, [a, b], {});
  assert.equal(result.verdict, 'LIKELY-DUPLICATE');
  assert.equal(result.evidence.type, 'duplicate-file-symbol');
  assert.equal(result.evidence.otherId, 'b');
});

test('findDuplicateForCard: no match below threshold or with too few significant tokens', () => {
  const a = card({ id: 'a', name: 'Fix login bug' });
  const b = card({ id: 'b', name: 'Improve checkout flow' });
  assert.equal(findDuplicateForCard(a, [a, b]), null);
  const short1 = card({ id: 'c', name: 'CI red' });
  const short2 = card({ id: 'd', name: 'CI red again' });
  // Fewer than TITLE_MIN_TOKENS significant tokens each -> no match, even
  // though they'd otherwise overlap heavily.
  assert.equal(findDuplicateForCard(short1, [short1, short2]), null);
});

test('titleOverlapScore / tokenizeTitle: stopwords and short tokens dropped, Jaccard over the rest', () => {
  assert.deepEqual(tokenizeTitle('Fix the P1 bug in scoring'), ['scoring']);
  assert.equal(titleOverlapScore('completely different alpha', 'totally other beta'), 0);
  assert.ok(titleOverlapScore('scraping yield regression telegraph', 'scraping yield regression telegraph two') > 0.6);
});

// Structural guard: tests/unit/sibling-matchers-diacritics.test.mjs (task
// #648 class) — diacritics must fold BEFORE the non-ASCII strip, or a card
// titled after a show with an accented name silently fails to match its own
// duplicate. Crown-input catch on this classifier's own first review pass.
test('tokenizeTitle: folds diacritics before stripping non-ASCII (Café -> cafe, not caf)', () => {
  assert.deepEqual(tokenizeTitle('Café Society revival tracking'), ['cafe', 'society', 'revival', 'tracking']);
});

test('classifyCard: duplicate detection still matches titles that differ only by diacritics', () => {
  const a = card({ id: 'a', name: 'Café Society revival tracking issue' });
  const b = card({ id: 'b', name: 'Cafe Society revival tracking issue two' });
  const result = classifyCard(a, [a, b], {});
  assert.equal(result.verdict, 'LIKELY-DUPLICATE');
  assert.equal(result.evidence.otherId, 'b');
});

// ── Required case 4: card naming a deleted file → LIKELY-STALE ───────────
test('classifyCard: card naming only a deleted file -> LIKELY-STALE', () => {
  const c = card({ notes: 'The bug lives in scripts/this-file-was-deleted-long-ago.js — fix it there.' });
  const opts = { fileExists: () => false };
  const result = classifyCard(c, [c], opts);
  assert.equal(result.verdict, 'LIKELY-STALE');
  assert.equal(result.evidence.type, 'stale-files');
  assert.deepEqual(result.evidence.paths, ['scripts/this-file-was-deleted-long-ago.js']);
});

test('checkStaleFiles: mixed live/dead paths stay ambiguous (null), not stale', () => {
  const c = card({ notes: 'See scripts/live-file.js and scripts/dead-file.js.' });
  const opts = { fileExists: (p) => p === 'scripts/live-file.js' };
  assert.equal(checkStaleFiles(c, opts), null);
});

test('checkStaleFiles: a missing *.test.mjs alone is a planned deliverable, not stale (live false-positive fixed 2026-08-16)', () => {
  const c = card({ notes: 'Acceptance: `node --test scripts/tests/not-written-yet.test.mjs`' });
  const opts = { fileExists: () => false };
  assert.equal(checkStaleFiles(c, opts), null);
});

test('checkStaleFiles: a missing *.test.ts alone is a planned deliverable, not stale (task #1722, code-review catch)', () => {
  // tests/unit/*.test.ts is this repo's dominant unit-test extension
  // (tests/unit-test-manifest-tsx.txt) — the .mjs-only regex missed it.
  const c = card({ notes: 'Acceptance: `npx tsx --test tests/unit/not-written-yet.test.ts`' });
  const opts = { fileExists: () => false };
  assert.equal(checkStaleFiles(c, opts), null);
});

test('checkStaleFiles: a missing test file alongside a missing real file is still stale on the real file', () => {
  const c = card({ notes: 'See scripts/lib/deleted-thing.js and scripts/tests/not-written-yet.test.mjs' });
  const opts = { fileExists: () => false };
  const result = checkStaleFiles(c, opts);
  assert.equal(result.type, 'stale-files');
  assert.deepEqual(result.paths, ['scripts/lib/deleted-thing.js']);
});

test('checkStaleFiles: no referenced paths, or fileExists not injected -> null', () => {
  assert.equal(checkStaleFiles(card({ notes: 'no paths mentioned here' }), { fileExists: () => false }), null);
  assert.equal(checkStaleFiles(card({ notes: 'scripts/x.js' }), {}), null);
});

test('extractReferencedPaths / extractFileRefs / extractSymbols: basic extraction', () => {
  assert.deepEqual(extractReferencedPaths('touches scripts/lib/x.js and data/audit/y.json.'), ['scripts/lib/x.js', 'data/audit/y.json']);
  assert.deepEqual([...extractFileRefs('see scripts/lib/x.js here')], ['scripts/lib/x.js']);
  assert.deepEqual([...extractSymbols('call `doThing` then `other`')], ['doThing', 'other']);
});

test('extractRecheckAfter: parses the stamp, null when absent', () => {
  assert.equal(extractRecheckAfter('RECHECK-AFTER: 2026-08-01 some text'), '2026-08-01');
  assert.equal(extractRecheckAfter('no stamp here'), null);
});

// ship-check finding: this classifier reused a hand-rolled colon-required
// regex before this fix, silently under-matching the colon-less form live
// cards actually carry — reuse of recheck-stamp.js's canonical RECHECK_AFTER_RE
// (fixed there 2026-08-14 for exactly this reason) closes the gap.
test('extractRecheckAfter: colon-optional form (live cards are hand-stamped without one) also parses', () => {
  assert.equal(extractRecheckAfter('RECHECK-AFTER 2026-08-24 blah'), '2026-08-24');
});

// ship-check finding: makeFileExists used fs.statSync(...).isFile(), which
// is false for a directory — a card naming only a directory (a real,
// existing location) was misclassified LIKELY-STALE. Live repro before the
// fix: checkStaleFiles({notes:'the code lives in scripts/lib'}, opts) ->
// {type:'stale-files', paths:['scripts/lib']} even though scripts/lib exists.
test('makeFileExists: treats an existing directory as existing, not stale', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const exists = makeFileExists(repoRoot);
  assert.equal(exists('scripts/lib'), true); // directory
  assert.equal(exists('scripts/lib/audit-card-relevance.js'), true); // file
  assert.equal(exists('scripts/lib/definitely-does-not-exist-xyz-1719.js'), false);
});

test('checkStaleFiles: a card naming only a directory does not classify LIKELY-STALE (via the real makeFileExists)', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const c = card({ notes: 'the code lives in scripts/lib and needs a helper' });
  const result = checkStaleFiles(c, { fileExists: makeFileExists(repoRoot) });
  assert.equal(result, null);
});

// ── Required case 5: ambiguous card → REAL ────────────────────────────────
test('classifyCard: ambiguous card (no evidence for anything) -> REAL, default, never closed', () => {
  const c = card({
    id: 'amb', name: 'Investigate flaky recoupment RSS poller behavior',
    notes: 'Sometimes the poller misses an item. Needs investigation — no repro yet.',
  });
  const other = card({ id: 'other', name: 'Completely unrelated card about audience buzz scraping' });
  const opts = {
    runAcceptanceCmd: () => ({ status: 'fail' }),
    isCommitOnMain: () => false,
    fileExists: () => true,
  };
  const result = classifyCard(c, [c, other], opts);
  assert.equal(result.verdict, 'REAL');
  assert.equal(result.evidence, null);
});

test('classifyCard: no injected opts at all -> still REAL, never throws, never fabricates evidence', () => {
  const c = card({ notes: '## Acceptance criteria\n`node --test x.test.mjs`\nRECHECK-AFTER: 2020-01-01\ncommit `1234567`\nscripts/maybe-gone.js' });
  const result = classifyCard(c, [c], {});
  assert.equal(result.verdict, 'REAL');
});

test('classifyPool: classifies every card in the pool, preserving id/name/url/priority/status', () => {
  const a = card({ id: 'a', name: 'A card' });
  const b = card({ id: 'b', name: 'B card' });
  const results = classifyPool([a, b], {});
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'a');
  assert.equal(results[1].id, 'b');
  for (const r of results) {
    assert.ok(['LIKELY-DONE', 'LIKELY-DUPLICATE', 'LIKELY-STALE', 'REAL'].includes(r.verdict));
  }
});

test('classifyPool: empty pool -> empty result, no throw', () => {
  assert.deepEqual(classifyPool([], {}), []);
  assert.deepEqual(classifyPool(undefined, {}), []);
});

// ── Done-adjacent signals (BRO-343 live scan, 2026-08-16) ─────────────────
// Real text confirmed live off card #1478's Outcome field (2026-08-16):
// "Owner closed its workspace (workspace:477) without marking it done, so
// the dispatcher stopped re-opening it." followed later by "Auto-closed
// 2026-08-14 by notion-tasks-sync: its mirrored task was marked completed
// in the shared task list."
const REAL_WORKSPACE_CLOSED_TEXT = 'Owner closed its workspace (workspace:477) without marking it done, so the dispatcher stopped re-opening it. Resume with `node scripts/bsc-next.js --id 1478 --force`.';
const REAL_TASK_MIRROR_TEXT = 'Auto-closed 2026-08-14 by notion-tasks-sync: its mirrored task was marked completed in the shared task list.';

test('detectDoneSignals: matches the real production phrasing for both signatures independently', () => {
  assert.deepEqual(detectDoneSignals({ outcome: REAL_WORKSPACE_CLOSED_TEXT }), {
    workspaceClosedNotDecided: true, taskMirrorReportedCompleted: false,
  });
  assert.deepEqual(detectDoneSignals({ outcome: REAL_TASK_MIRROR_TEXT }), {
    workspaceClosedNotDecided: false, taskMirrorReportedCompleted: true,
  });
  assert.deepEqual(detectDoneSignals({ outcome: `${REAL_WORKSPACE_CLOSED_TEXT}\n\n${REAL_TASK_MIRROR_TEXT}` }), {
    workspaceClosedNotDecided: true, taskMirrorReportedCompleted: true,
  });
  assert.deepEqual(detectDoneSignals({ outcome: 'nothing relevant here' }), {
    workspaceClosedNotDecided: false, taskMirrorReportedCompleted: false,
  });
  assert.deepEqual(detectDoneSignals({}), { workspaceClosedNotDecided: false, taskMirrorReportedCompleted: false });
});

test('classifyCard: a card carrying BOTH done-adjacent signals but no confirming evidence still verdicts REAL — signature alone never closes a card', () => {
  const c = card({
    notes: 'Some unrelated acceptance prose, no runnable command, no commit sha.',
    outcome: `${REAL_WORKSPACE_CLOSED_TEXT}\n\n${REAL_TASK_MIRROR_TEXT}`,
  });
  const opts = { runAcceptanceCmd: () => ({ status: 'pass' }), isCommitOnMain: () => true, fileExists: () => true };
  const result = classifyCard(c, [c], opts);
  assert.equal(result.verdict, 'REAL');
  assert.deepEqual(result.signals, { workspaceClosedNotDecided: true, taskMirrorReportedCompleted: true });
});

test('classifyCard: signature-carrying card WITH a passing acceptance command still resolves via real evidence (checkAcceptanceHolds), not the signature', () => {
  const c = card({
    notes: `${REAL_TASK_MIRROR_TEXT}\n## Acceptance criteria\n\`node --test scripts/lib/thing.test.mjs\``,
  });
  const opts = { runAcceptanceCmd: () => ({ status: 'pass' }) };
  const result = classifyCard(c, [c], opts);
  assert.equal(result.verdict, 'LIKELY-DONE');
  assert.equal(result.evidence.type, 'acceptance-command-passes'); // not the signature
  assert.equal(result.signals.taskMirrorReportedCompleted, true); // still recorded, for traceability
});

test('classifyCard: every verdict carries a signals field, always computed, never influencing the verdict itself', () => {
  const done = card({ notes: '## Acceptance criteria\n`node --test x.test.mjs`' });
  const r1 = classifyCard(done, [done], { runAcceptanceCmd: () => ({ status: 'pass' }) });
  assert.ok('signals' in r1);
  const stale = card({ notes: 'scripts/deleted.js' });
  const r2 = classifyCard(stale, [stale], { fileExists: () => false });
  assert.ok('signals' in r2);
});
