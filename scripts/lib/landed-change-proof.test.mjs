// BRO-7790: pins the landed-change proof audit's verdicts, ledger rules and the owner digest line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceOf, classifyPath, relativeImports, libWorkflowIndex, fileVerdict, auditCommit, worst, newRows, summarize,
  digestLine, digestLineWithCatchUp, hasAuditToday, needsFollowUp, cardBody, safeRunCommand, dayMinus, workflowScriptIndex, runMarker,
} from './landed-change-proof.mjs';
import { isUsageOnlyOutput } from './usage-output.mjs';

const index = workflowScriptIndex({
  'nightly.yml': 'on:\n  schedule: []\njobs:\n  a:\n    steps:\n      - run: node scripts/nightly-job.js\n      # node scripts/commented-out.js\n',
  'test.yml': 'run: node scripts/only-in-tests.js',
});
const libIndex = new Map([['scripts/lib/helper.js', ['nightly.yml']]]);
const posOf = new Map([['c0', 0], ['c1', 1], ['c2', 2], ['c3', 3]]);
const cls = (f) => classifyPath(f, { index, libIndex });

test('sourceOf: trailer, Codex runner, cloud author, bots, Mac', () => {
  assert.equal(sourceOf({ authorName: 'Claude', authorEmail: 'noreply@anthropic.com', body: 'x\n\nClaude-Session: https://claude.ai/code/session_01ABC' }), 'cloud');
  assert.equal(sourceOf({ authorName: 'Claude', authorEmail: 'noreply@anthropic.com', body: 'no trailer' }), 'cloud');
  assert.equal(sourceOf({ authorName: 'Codex runner', authorEmail: 'codex-runner@broadwayscorecard.com', body: '' }), 'codex');
  assert.equal(sourceOf({ authorName: 'Tom Pryor', authorEmail: 'o@example.com', body: 'Worked by the daily Codex runner' }), 'codex');
  assert.equal(sourceOf({ authorName: 'github-actions[bot]', authorEmail: 'github-actions[bot]@users.noreply.github.com' }), 'none');
  assert.equal(sourceOf({ authorName: 'GitHub Action', authorEmail: 'action@github.com' }), 'none');
  assert.equal(sourceOf({ authorName: 'Tom Pryor', authorEmail: 'o@example.com', body: 'Co-Authored-By: Claude' }), 'mac');
});

test('classifyPath: workflow, script, lib, src, hook, exempt, other', () => {
  assert.deepEqual(cls('.github/workflows/nightly.yml'), { kind: 'workflow', workflows: ['nightly.yml'] });
  assert.deepEqual(cls('scripts/nightly-job.js'), { kind: 'script', workflows: ['nightly.yml'] });
  assert.equal(cls('scripts/commented-out.js').kind, 'other', 'comment lines in a workflow do not run anything');
  assert.equal(cls('scripts/only-in-tests.js').kind, 'other', 'test.yml does not count as a live run');
  assert.equal(cls('scripts/lib/helper.js').kind, 'lib');
  assert.equal(cls('src/app/page.tsx').kind, 'src');
  assert.equal(cls('next.config.js').kind, 'src');
  assert.equal(cls('.claude/hooks/verify-edits.sh').kind, 'hook');
  assert.equal(cls('scripts/lib/live-run-stop.mjs').kind, 'hook');
  assert.equal(classifyPath('scripts/lib/retro-coverage-stop.mjs', { index, libIndex: new Map([['scripts/lib/retro-coverage-stop.mjs', ['x.yml']]]) }).kind, 'hook', 'a Stop hook is a hook even when a workflow script imports it');
  for (const f of ['scripts/lib/x.test.mjs', 'tests/unit/a.test.mjs', 'CLAUDE.md', 'data/shows.json', 'memory/a.md', '.claude/commands/ship-check.md']) assert.equal(cls(f).kind, 'exempt', f);
});

test('libWorkflowIndex: 2-level import closure, scripts themselves excluded', () => {
  const files = {
    'scripts/nightly-job.js': "const a = require('./lib/a');\nimport b from './lib/b.mjs';",
    'scripts/lib/a.js': "require('./deep.js')",
    'scripts/lib/deep.js': "require('./deeper.js')",
    'scripts/lib/b.mjs': '',
  };
  const exists = (p) => p in files || p === 'scripts/lib/deeper.js';
  assert.deepEqual(relativeImports('scripts/nightly-job.js', files['scripts/nightly-job.js'], exists), ['scripts/lib/a.js', 'scripts/lib/b.mjs']);
  const li = libWorkflowIndex(index, (p) => files[p] ?? '', exists);
  assert.deepEqual(li.get('scripts/lib/a.js'), ['nightly.yml']);
  assert.deepEqual(li.get('scripts/lib/deep.js'), ['nightly.yml']);
  assert.equal(li.has('scripts/lib/deeper.js'), false, 'stops at two levels');
});

test('fileVerdict: non-cron success proves, cron-only waits, failure, not_run, missing data is never proven', () => {
  const c = cls('scripts/nightly-job.js');
  const run = (o) => ({ workflow: 'nightly.yml', event: 'workflow_dispatch', conclusion: 'success', headSha: 'c2', ...o });
  const v = (runs, extra = {}) => fileVerdict('scripts/nightly-job.js', 'c1', { cls: c, runs, posOf, ...extra }).verdict;
  assert.equal(v([run()]), 'proven');
  assert.equal(v([run({ event: 'schedule' })]), 'waiting');
  assert.equal(v([run({ conclusion: 'failure' })]), 'failed');
  assert.equal(v([run({ conclusion: 'failure' }), run({ event: 'schedule' })]), 'waiting', 'a later success outranks a failure');
  assert.equal(v([run({ headSha: 'c0' })]), 'not_run', 'a run on a commit before the landing does not contain it');
  assert.equal(v([run({ headSha: 'land-branch-sha' })]), 'not_run', 'a run off main does not count');
  assert.equal(v([run({ workflow: 'other.yml' })]), 'not_run', 'a run of a workflow that does not run the file does not count');
  assert.equal(v([]), 'not_run');
  assert.equal(v([], { incomplete: new Set(['nightly.yml']) }), 'unknown', 'an incomplete run list is unknown, never not_run');
  assert.equal(v([run()], { runsOk: false }), 'unknown');
  assert.equal(v([run({ id: 9 })], { ranWork: (r) => r.id !== 9 }), 'not_run', 'a green run whose jobs were all skipped ran nothing');
  assert.equal(v([run({ id: 9 }), run({ id: 10, event: 'schedule' })], { ranWork: (r) => r.id !== 9 }), 'waiting');
  assert.equal(v([run({ id: 9 })], { ranWork: () => null }), 'proven', 'jobs unreadable: the green run still counts');
  // Lazy reads: a skipped-jobs green run on the first workflow must not stop the search before the second.
  const two = { kind: 'lib', workflows: ['a.yml', 'b.yml'] };
  const runsByWf = { 'a.yml': [run({ id: 1, workflow: 'a.yml' })], 'b.yml': [run({ id: 2, workflow: 'b.yml' })] };
  assert.equal(fileVerdict('scripts/lib/x.js', 'c1', { cls: two, runsFor: (w) => runsByWf[w], posOf, ranWork: (r) => r.id !== 1 }).verdict, 'proven');
  // A merge's side commits share its position; a run on one of them must not prove a later one.
  const side = new Map([...posOf, ['s1', 2], ['s2', 2]]);
  assert.equal(fileVerdict('scripts/nightly-job.js', 's2', { cls: c, runs: [run({ headSha: 's1' })], posOf: side, headPos: posOf }).verdict, 'not_run');
  assert.equal(fileVerdict('scripts/nightly-job.js', 's2', { cls: c, runs: [run({ headSha: 'c2' })], posOf: side, headPos: posOf }).verdict, 'proven', 'the merge commit run contains it');
  assert.equal(fileVerdict('scripts/nightly-job.js', 'not-on-main', { cls: c, runs: [run()], posOf }).verdict, 'unknown');
});

test('fileVerdict: src needs the live READY deploy; unknown deploy is unknown', () => {
  const v = (d) => fileVerdict('src/a.tsx', 'c1', { cls: cls('src/a.tsx'), runs: [], posOf, isDeployed: () => d }).verdict;
  assert.equal(v(true), 'deployed');
  assert.equal(v(false), 'not_run');
  assert.equal(v(null), 'unknown');
});

test('auditCommit: a commit takes the worst verdict of its non-exempt files', () => {
  assert.equal(worst(['proven', 'no_signal', 'exempt']), 'no_signal');
  assert.equal(worst(['exempt']), 'exempt');
  const row = auditCommit({ sha: 'c1', landedAt: '2026-11-17T10:00:00.000Z', authorName: 'Codex runner', authorEmail: 'codex-runner@x', subject: 's', body: '', files: ['scripts/nightly-job.js', 'scripts/lib/x.test.mjs', '.claude/hooks/a.sh'] },
    { index, libIndex, auditDay: '2026-11-18', runs: [{ workflow: 'nightly.yml', event: 'push', conclusion: 'success', headSha: 'c3' }], posOf });
  assert.equal(row.verdict, 'no_signal');
  assert.equal(row.source, 'codex');
  assert.equal(row.landedDay, '2026-11-17');
  assert.deepEqual(row.files.map((f) => f.verdict), ['proven', 'no_signal'], 'exempt files are not stored');
});

test('newRows: append-only, one row per sha per audit day; older commits only when the verdict changed; a run marker every day', () => {
  const r = (sha, landedDay, verdict, auditDay = '2026-11-18') => ({ sha, landedDay, verdict, auditDay });
  const prior = [r('a', '2026-11-16', 'not_run', '2026-11-17'), r('b', '2026-11-16', 'waiting', '2026-11-17'), runMarker('2026-11-17')];
  const out = newRows(prior, [r('a', '2026-11-16', 'proven'), r('b', '2026-11-16', 'waiting'), r('y', '2026-11-17', 'not_run'), r('old', '2026-11-15', 'no_signal'), runMarker('2026-11-18')]);
  assert.deepEqual(out.map((x) => x.sha), ['a', 'y', 'old', '_run']);
  assert.deepEqual(newRows([...prior, ...out], out), [], 'a second run the same day appends nothing');
  assert.deepEqual(newRows(prior, [{ ...r('b', '2026-11-16', 'waiting'), card: 'BRO-9' }]).map((x) => x.sha), ['b'], 'a carded row is kept even when its verdict did not change');
});

test('digestLine: one plain line over yesterday, counts add up; only today\'s audit counts', () => {
  const rows = [
    ...['proven', 'deployed', 'waiting', 'not_run', 'no_signal'].map((verdict, i) => ({ sha: `s${i}`, auditDay: '2026-11-18', landedDay: '2026-11-17', verdict, source: 'cloud' })),
    { sha: 'older', auditDay: '2026-11-18', landedDay: '2026-11-16', verdict: 'failed', source: 'mac' },
    runMarker('2026-11-18'),
  ];
  const at = (iso) => ({ now: new Date(iso) });
  assert.equal(digestLine(rows, at('2026-11-18T11:30:00Z')),
    'Yesterday 5 code changes went live: 2 proven running, 1 only ran on their schedule, 1 not run since landing, 1 with nothing that runs them on their own.');
  assert.match(digestLine(rows, at('2026-11-19T11:30:00Z')), /not measured this morning \(the check last ran 2026-11-18\)/, 'yesterday\'s audit is not today\'s');
  assert.equal(digestLine([runMarker('2026-11-19')], at('2026-11-19T11:30:00Z')), 'Yesterday no code changes went live.', 'the marker tells no changes from no audit');
  assert.equal(digestLine([]), null);
});

test('needsFollowUp: full day behind them, carded once, missed nights caught up, per-file self-runs', () => {
  const r = (sha, landedDay, verdict, files = [{ file: 'f', verdict }]) => ({ sha, landedDay, verdict, auditDay: '2026-11-18', files });
  const ok = { ok: true };
  const out = needsFollowUp([
    r('a', '2026-11-16', 'not_run'), r('b', '2026-11-17', 'not_run'), r('c', '2026-11-16', 'failed'),
    r('d', '2026-11-16', 'not_run', [{ file: 'x', verdict: 'not_run', safeRun: ok }]),
    r('mixed', '2026-11-16', 'not_run', [{ file: 'x', verdict: 'not_run', safeRun: ok }, { file: 'y', verdict: 'not_run' }]),
    r('e', '2026-11-16', 'no_signal'), r('late', '2026-11-15', 'not_run'), r('done', '2026-11-15', 'not_run'),
  ], [{ sha: 'done', auditDay: '2026-11-17', card: 'BRO-1' }]);
  assert.deepEqual(out.map((x) => x.sha), ['a', 'c', 'mixed', 'late']);
  assert.equal(dayMinus('2026-03-01', 1), '2026-02-28');
});

test('cardBody: names cloud-session misses and carries a safe-form VERIFY line', () => {
  const body = cardBody([{ sha: 'abcdef123456', source: 'cloud', session: 'https://claude.ai/code/session_01X', verdict: 'not_run', subject: 'fix', files: [{ file: 'scripts/nightly-job.js', verdict: 'not_run' }] }], { auditDay: '2026-11-18' });
  assert.match(body, /live-run-stop\.mjs/);
  assert.match(body, /session_01X/);
  assert.match(body, /^VERIFY: node scripts\/landed-change-proof-audit\.js --dry-run --sha=abcdef1234 --expect-proven$/m);
});

test('safeRunCommand: maps a script to its own test, accepted by the REAL safe-form gate (BRO-7796)', async () => {
  const { createRequire } = await import('node:module');
  const { explainUnsafeCheckCommand } = createRequire(import.meta.url)('./autonomous-triage-core.js');
  const has = (...paths) => (p) => paths.includes(p);
  // Colocated test wins over scripts/tests and tests/unit.
  assert.equal(safeRunCommand('scripts/lib/land-branch.js', explainUnsafeCheckCommand, has('scripts/lib/land-branch.test.mjs', 'tests/unit/land-branch.test.mjs')), 'node --test scripts/lib/land-branch.test.mjs');
  assert.equal(safeRunCommand('scripts/x.js', explainUnsafeCheckCommand, has('scripts/tests/x.test.mjs')), 'node --test scripts/tests/x.test.mjs');
  assert.equal(safeRunCommand('scripts/sweep-pending-commercial.js', explainUnsafeCheckCommand, has('tests/unit/sweep-pending-commercial.test.mjs')), 'node --test tests/unit/sweep-pending-commercial.test.mjs');
  assert.equal(safeRunCommand('scripts/newsletter/generate.mjs', explainUnsafeCheckCommand, has('scripts/newsletter/generate.test.mjs')), 'node --test scripts/newsletter/generate.test.mjs');
  // No test on disk: nothing to run (never a bare `node <file>`, which the gate rejects and which could mutate).
  assert.equal(safeRunCommand('scripts/example-untested-script.js', explainUnsafeCheckCommand, has()), null);
  assert.equal(safeRunCommand('scripts/example-untested-script.js', explainUnsafeCheckCommand), null, 'default oracle invents nothing');
  assert.equal(explainUnsafeCheckCommand('node scripts/lib/land-branch.js').ok, false, 'the premise: a bare node <file> is rejected by the gate');
  // Non-scripts and test files themselves.
  assert.equal(safeRunCommand('.github/workflows/x.yml', explainUnsafeCheckCommand, () => true), null);
  assert.equal(safeRunCommand('scripts/lib/a.test.mjs', explainUnsafeCheckCommand, () => true), null);
  // The gate has the last word, and an error in it runs nothing.
  assert.equal(safeRunCommand('scripts/a.js', () => ({ ok: false }), () => true), null);
  assert.equal(safeRunCommand('scripts/a.js', () => { throw new Error('x'); }, () => true), null);
});

test('isUsageOnlyOutput: a help banner is not a run, a real report is', () => {
  assert.equal(isUsageOnlyOutput('usage: live-run-stop.mjs --stop-hook  (reads the Stop hook JSON on stdin)\n'), true);
  assert.equal(isUsageOnlyOutput('Usage:\n  node scripts/x.js [--dry-run]\n\nOptions:\n  --dry-run   print only\n  --json      json\n'), true);
  assert.equal(isUsageOnlyOutput('Checked 120 shows\n3 problems found\nusage: none'), false);
  assert.equal(isUsageOnlyOutput('usage: x\nWrote 4 rows to data/a.json'), false);
  assert.equal(isUsageOnlyOutput(''), false);
  assert.equal(isUsageOnlyOutput('Audit - 3 shows checked\n  hamilton: ok\n  wicked: ok'), false, 'a report titled with a dash is not a banner');
});

test('dispatchPlan: allowlisted workflows only, one per workflow, capped, never twice for a sha (BRO-7796)', async () => {
  const { dispatchPlan, DISPATCH_ALLOWLIST } = await import('./landed-change-proof.mjs');
  const row = (sha, file, workflows, verdict = 'not_run') => ({ sha, verdict, files: [{ file, verdict, workflows }] });
  const A = 'check-cutoff-freshness.yml';
  const B = 'other-readonly.yml';
  assert.ok(DISPATCH_ALLOWLIST.has(A) && !DISPATCH_ALLOWLIST.has('check-linear-drain-health.yml'), 'ops monitors that can legitimately go red stay off the list');
  const allow = new Set([A, B]);
  const rows = [row('s1', 'scripts/check-cutoff-freshness.js', [A]), row('s2', 'scripts/lib/x.js', [A, 'spend.yml']), row('s3', 'scripts/y.js', ['spend.yml']), row('s4', 'scripts/z.js', [B]), row('s5', 'scripts/q.js', [A], 'failed')];
  const plan = dispatchPlan(rows, [], { allow });
  assert.deepEqual(plan.map((p) => p.workflow), [A, B], 'spend.yml is never planned; failed rows are not re-dispatched');
  assert.deepEqual(plan[0].shas, ['s1', 's2'], 'one dispatch proves both files');
  assert.equal(dispatchPlan(rows, [{ sha: 's1', files: [{ dispatch: { requested: true } }] }, { sha: 's2', files: [{ dispatch: { requested: true } }] }], { allow }).map((p) => p.workflow).join(), B, 'already requested shas are skipped');
  assert.equal(dispatchPlan(rows, [], { cap: 1, allow }).length, 1, 'cap');
  assert.deepEqual(dispatchPlan(rows, [], { allow: new Set() }), [], 'empty allowlist plans nothing');
});

test('needsFollowUp and newRows treat a dispatched or self-run file as in progress and keep it in the ledger (BRO-7796)', () => {
  const r = { auditDay: '2026-11-18', sha: 'aaa', landedDay: '2026-11-15', verdict: 'not_run', files: [{ file: 'scripts/a.js', verdict: 'not_run', dispatch: { workflow: 'w.yml', requested: true } }] };
  assert.equal(needsFollowUp([r], []).length, 0, 'dispatched tonight: not carded yet');
  const plain = { ...r, files: [{ file: 'scripts/a.js', verdict: 'not_run' }] };
  assert.equal(needsFollowUp([plain], []).length, 1);
  const prev = { auditDay: '2026-11-17', sha: 'aaa', landedDay: '2026-11-15', verdict: 'not_run', files: [] };
  assert.equal(newRows([prev], [r]).length, 1, 'unchanged verdict, but a dispatch must reach the ledger');
  assert.equal(newRows([prev], [plain]).length, 0);
  const ran = { ...plain, files: [{ file: 'scripts/a.js', verdict: 'not_run', safeRun: { ok: true } }] };
  assert.equal(newRows([prev], [ran]).length, 1, 'a safeRun must reach the ledger');
});

test('failed_preexisting: a workflow already red on main before the commit is not blamed on it (BRO-7804)', () => {
  const c = cls('scripts/nightly-job.js');
  const run = (o) => ({ workflow: 'nightly.yml', event: 'push', conclusion: 'failure', headSha: 'c2', createdAt: '2026-11-18T09:00:00Z', ...o });
  // c0 is before the commit (c1), c2 contains it.
  const v = (runs, extra = {}) => fileVerdict('scripts/nightly-job.js', 'c1', { cls: c, runs, posOf, ...extra });
  const before = (o) => run({ headSha: 'c0', createdAt: '2026-11-17T09:00:00Z', ...o });
  assert.equal(v([run(), before()]).verdict, 'failed_preexisting', 'red before and red after');
  assert.equal(v([run(), before()]).preRun, null);
  assert.equal(v([run(), before({ id: 5 })]).preRun, 5);
  assert.equal(v([run(), before({ conclusion: 'success' })]).verdict, 'failed', 'green before: this commit broke it');
  assert.equal(v([run()]).verdict, 'failed', 'no earlier run in the window: stay conservative');
  assert.equal(v([run(), before({ headSha: 'landing-branch-sha' })]).verdict, 'failed', 'a red run off main excuses nothing');
  assert.equal(v([run(), before({ conclusion: 'cancelled' })]).verdict, 'failed', 'cancelled is not evidence of red');
  assert.equal(v([run(), before({ conclusion: 'cancelled', createdAt: '2026-11-17T12:00:00Z' }), before({ conclusion: 'success' })]).verdict, 'failed', 'cancelled skipped, the success before it decides');
  assert.equal(v([run(), before({ conclusion: 'success', createdAt: '2026-11-16T09:00:00Z' }), before({ createdAt: '2026-11-17T09:00:00Z' })]).verdict, 'failed_preexisting', 'latest earlier run decides');
  assert.equal(v([run({ conclusion: 'success', event: 'workflow_dispatch', id: 8 }), before()]).verdict, 'proven', 'a later green still wins');
  // Two workflows: each failing one needs its own earlier red run.
  const two = { kind: 'lib', workflows: ['a.yml', 'b.yml'] };
  const runs = { 'a.yml': [run({ workflow: 'a.yml' }), before({ workflow: 'a.yml' })], 'b.yml': [run({ workflow: 'b.yml' }), before({ workflow: 'b.yml', conclusion: 'success' })] };
  assert.equal(fileVerdict('scripts/lib/x.js', 'c1', { cls: two, runsFor: (w) => runs[w], posOf }).verdict, 'failed', 'B newly red is not hidden by A already red');
  runs['b.yml'][1].conclusion = 'failure';
  assert.equal(fileVerdict('scripts/lib/x.js', 'c1', { cls: two, runsFor: (w) => runs[w], posOf }).verdict, 'failed_preexisting');
  // A sibling workflow that never ran is not excused by the other one's old red.
  assert.equal(fileVerdict('scripts/lib/x.js', 'c1', { cls: two, runsFor: (w) => (w === 'a.yml' ? runs['a.yml'] : []), posOf }).verdict, 'failed');
  assert.deepEqual(fileVerdict('scripts/lib/x.js', 'c1', { cls: two, runsFor: (w) => runs[w], posOf }).preRuns.length, 2, 'every earlier red run is recorded');
  // timed_out counts as red; a higher main position beats a later createdAt.
  assert.equal(v([run(), before({ conclusion: 'timed_out' })]).verdict, 'failed_preexisting');
  const p0 = new Map([...posOf, ['c0b', 0.5]]);
  assert.equal(fileVerdict('scripts/nightly-job.js', 'c1', { cls: c, posOf: p0, runs: [run(), before({ headSha: 'c0b', conclusion: 'success', createdAt: '2026-11-10T00:00:00Z' }), before({ createdAt: '2026-11-17T09:00:00Z' })] }).verdict, 'failed', 'position, not timestamp, picks the latest earlier run');
  // Ranking, digest and carding.
  assert.equal(worst(['failed_preexisting', 'not_run']), 'not_run');
  assert.equal(worst(['failed_preexisting', 'proven']), 'failed_preexisting');
  assert.equal(worst(['failed', 'failed_preexisting']), 'failed');
  const rows = ['proven', 'failed', 'failed_preexisting', 'failed_preexisting'].map((verdict, i) => ({ sha: `s${i}`, auditDay: '2026-11-18', landedDay: '2026-11-17', verdict, source: 'cloud', files: [{ file: 'f', verdict }] }));
  assert.equal(digestLine([...rows, runMarker('2026-11-18')], { now: new Date('2026-11-18T11:30:00Z') }),
    'Yesterday 4 code changes went live: 1 proven running, 1 ran and failed, 2 touched an already-failing check.');
  const nf = needsFollowUp(rows.map((r) => ({ ...r, landedDay: '2026-11-16' })));
  assert.deepEqual(nf.map((r) => r.sha), ['s1'], 'only a real failure is carded');
});

test('BRO-7840: digest runs the audit when today\'s marker is missing (late cron), not when present', () => {
  const now = new Date('2026-11-19T11:30:00Z');
  const old = [runMarker('2026-11-18')];
  let calls = 0;
  const runAudit = (day) => { calls++; assert.equal(day, '2026-11-19'); return []; };
  const a = digestLineWithCatchUp(old, { now, runAudit });
  assert.equal(calls, 1); assert.equal(a.caughtUp, true);
  assert.equal(a.line, 'Yesterday no code changes went live.', 'fresh in-memory audit, not "not measured this morning"');
  const b = digestLineWithCatchUp([...old, runMarker('2026-11-19')], { now, runAudit });
  assert.equal(calls, 1, 'marker present: no second run'); assert.equal(b.caughtUp, false);
  const c = digestLineWithCatchUp(old, { now, runAudit: () => { throw new Error('boom'); } });
  assert.match(c.line, /not measured this morning/, 'failed catch-up degrades to the stale line');
  assert.equal(hasAuditToday(old, now), false);
});

// BRO-7910: retro coverage (advisory) and the recorded reason a not-run file got no run.
import { retroCoverageGaps, webSessionOf, noRunReason } from './landed-change-proof.mjs';
test('retroCoverageGaps lists web sessions with no retro row; matches by webSessionId or a linked sha', () => {
  const rows = [
    { sha: 'aaaaaaaaaa11', landedDay: '2026-11-20', session: 'https://claude.ai/code/session_01AAA' },
    { sha: 'bbbbbbbbbb22', landedDay: '2026-11-20', session: 'https://claude.ai/code/session_01BBB' },
    { sha: 'cccccccccc33', landedDay: '2026-11-20', session: 'https://claude.ai/code/session_01CCC' },
    { sha: 'dddddddddd44', landedDay: '2026-11-19', session: 'https://claude.ai/code/session_01DDD' },
    { sha: 'eeeeeeeeee55', landedDay: '2026-11-20', session: null },
  ];
  const retro = [{ webSessionId: 'session_01AAA', links: [] }, { sessionId: 'old', links: ['bbbbbbb'] }];
  const g = retroCoverageGaps(rows, retro, '2026-11-20');
  assert.equal(g.landed, 3);
  assert.equal(g.covered, 2);
  assert.deepEqual(g.missing, [{ session: 'session_01CCC', shas: ['cccccccccc'] }]);
  assert.equal(webSessionOf('Claude-Session: https://claude.ai/code/session_01XyZ'), 'session_01XyZ');
});
test('BRO-7911: a session whose own commit touched the retro ledger is covered even with no id or sha link', () => {
  // The audit's rows are code commits only; the retro commit is a data commit with another sha but the same Claude-Session trailer.
  const rows = [
    { sha: 'aaaaaaaaaa11', landedDay: '2026-11-20', session: 'session_01AAA' },
    { sha: 'bbbbbbbbbb22', landedDay: '2026-11-20', session: 'session_01BBB' },
  ];
  const g = retroCoverageGaps(rows, [{ sessionId: 'old', links: [] }], '2026-11-20', ['https://claude.ai/code/session_01AAA']);
  assert.deepEqual(g.missing.map((m) => m.session), ['session_01BBB']);
  assert.equal(retroCoverageGaps(rows, [], '2026-11-20').missing.length, 2, 'without the ledger sessions both read as missing');
});
test('noRunReason: says why a not-run file got no run; null when it was run or dispatched', () => {
  assert.match(noRunReason({ verdict: 'not_run', kind: 'lib', workflows: ['x.yml'] }), /not on the no-spend dispatch allowlist/);
  assert.match(noRunReason({ verdict: 'not_run', kind: 'workflow', workflows: ['x.yml'] }), /workflow file/);
  assert.equal(noRunReason({ verdict: 'not_run', kind: 'lib', workflows: [], safeRun: { ok: true } }), null);
  assert.equal(noRunReason({ verdict: 'proven' }), null);
});
test('noRunReason covers src, allowlisted-not-dispatched, failed safe run; cardBody lists reasons or n/a', async () => {
  const { cardBody } = await import('./landed-change-proof.mjs');
  assert.match(noRunReason({ verdict: 'not_run', kind: 'src' }), /Vercel/);
  assert.match(noRunReason({ verdict: 'not_run', kind: 'lib', workflows: ['check-cutoff-freshness.yml'] }), /allowlist but was not dispatched/);
  assert.match(noRunReason({ verdict: 'not_run', kind: 'lib', safeRun: { ok: false, exit: 1, cmd: 'node --test x' } }), /failed/);
  const row = (files) => ({ sha: 'a'.repeat(12), source: 'cloud', verdict: 'not_run', subject: 's', files });
  assert.match(cardBody([row([{ file: 'f.js', verdict: 'not_run', noRunReason: 'why-x' }])], { auditDay: 'd' }), /f\.js: why-x/);
  assert.match(cardBody([row([{ file: 'g.js', verdict: 'failed' }])], { auditDay: 'd' }), /n\/a/);
});
