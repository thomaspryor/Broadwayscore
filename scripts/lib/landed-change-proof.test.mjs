// BRO-7790: pins the landed-change proof audit's verdicts, ledger rules and the owner digest line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceOf, classifyPath, relativeImports, libWorkflowIndex, fileVerdict, auditCommit, worst, newRows, summarize,
  digestLine, needsFollowUp, cardBody, safeRunCommand, dayMinus, workflowScriptIndex, runMarker,
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
  assert.equal(safeRunCommand('scripts/send-feedback-reply.js', explainUnsafeCheckCommand, has()), null);
  assert.equal(safeRunCommand('scripts/send-feedback-reply.js', explainUnsafeCheckCommand), null, 'default oracle invents nothing');
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

test('CLI smoke: a dry run over no matching commits reads git, writes nothing, exits 0', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  if (spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/main'], { cwd: root }).status !== 0) return t.skip('no origin/main in this checkout');
  const r = spawnSync('node', ['scripts/landed-change-proof-audit.js', '--dry-run', '--days=1', '--sha=ffffffffffff'], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, GH_TOKEN: '', VERCEL_TOKEN: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /all: 0 code commits/);
  assert.match(r.stdout, /dry run: would append 0 row\(s\) \+ run marker, card for 0 change\(s\)/);
  const v = spawnSync('node', ['scripts/landed-change-proof-audit.js', '--dry-run', '--sha=ffffffffffff', '--expect-proven'], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, GH_TOKEN: '', VERCEL_TOKEN: '' } });
  assert.equal(v.status, 1, 'a card VERIFY over a sha that is not on main must fail, not pass on zero rows');
});
