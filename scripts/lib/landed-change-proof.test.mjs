// BRO-7790: pins the landed-change proof audit's verdicts, ledger rules and the owner digest line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceOf, classifyPath, relativeImports, libWorkflowIndex, fileVerdict, auditCommit, worst, newRows, summarize,
  digestLine, needsFollowUp, cardBody, safeRunCommand, dayMinus, workflowScriptIndex,
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

test('newRows: append-only, one row per sha per audit day; older commits only when the verdict changed', () => {
  const r = (sha, landedDay, verdict, auditDay = '2026-11-18') => ({ sha, landedDay, verdict, auditDay });
  const prior = [r('a', '2026-11-16', 'not_run', '2026-11-17'), r('b', '2026-11-16', 'waiting', '2026-11-17')];
  const out = newRows(prior, [r('a', '2026-11-16', 'proven'), r('b', '2026-11-16', 'waiting'), r('y', '2026-11-17', 'not_run'), r('old', '2026-11-15', 'no_signal')]);
  assert.deepEqual(out.map((x) => x.sha), ['a', 'y', 'old']);
  assert.deepEqual(newRows([...prior, ...out], out), [], 'a second run the same day appends nothing');
});

test('digestLine: one plain line over yesterday, counts add up, stale ledger says so', () => {
  const rows = [
    ...['proven', 'deployed', 'waiting', 'not_run', 'no_signal'].map((verdict, i) => ({ sha: `s${i}`, auditDay: '2026-11-18', landedDay: '2026-11-17', verdict, source: 'cloud' })),
    { sha: 'older', auditDay: '2026-11-18', landedDay: '2026-11-16', verdict: 'failed', source: 'mac' },
  ];
  assert.equal(digestLine(rows, { now: new Date('2026-11-18T11:30:00Z') }),
    'Yesterday 5 code changes went live: 2 proven running, 1 only ran on their schedule, 1 not run since landing, 1 with nothing that runs them on their own.');
  assert.match(digestLine(rows, { now: new Date('2026-11-21T11:30:00Z') }), /not measured this morning/);
  assert.equal(digestLine([]), null);
});

test('needsFollowUp: only commits with a full day behind them, minus ones the audit ran itself', () => {
  const r = (sha, landedDay, verdict, safeRun) => ({ sha, landedDay, verdict, auditDay: '2026-11-18', safeRun });
  const out = needsFollowUp([r('a', '2026-11-16', 'not_run'), r('b', '2026-11-17', 'not_run'), r('c', '2026-11-16', 'failed'), r('d', '2026-11-16', 'not_run', { ok: true }), r('e', '2026-11-16', 'no_signal')]);
  assert.deepEqual(out.map((x) => x.sha), ['a', 'c']);
  assert.equal(dayMinus('2026-03-01', 1), '2026-02-28');
});

test('cardBody: names cloud-session misses and carries a safe-form VERIFY line', () => {
  const body = cardBody([{ sha: 'abcdef123456', source: 'cloud', session: 'https://claude.ai/code/session_01X', verdict: 'not_run', subject: 'fix', files: [{ file: 'scripts/nightly-job.js', verdict: 'not_run' }] }], { auditDay: '2026-11-18' });
  assert.match(body, /live-run-stop\.mjs/);
  assert.match(body, /session_01X/);
  assert.match(body, /^VERIFY: node scripts\/landed-change-proof-audit\.js --dry-run .*--sha=abcdef1234 --expect-proven$/m);
});

test('safeRunCommand: only what the vetted read-only gate accepts', () => {
  const gate = (cmd) => ({ ok: cmd === 'node scripts/audit-text-quality.js' });
  assert.equal(safeRunCommand('scripts/audit-text-quality.js', gate), 'node scripts/audit-text-quality.js');
  assert.equal(safeRunCommand('scripts/send-broadcast.js', gate), null);
  assert.equal(safeRunCommand('.github/workflows/x.yml', gate), null);
  assert.equal(safeRunCommand('scripts/a.js', () => { throw new Error('x'); }), null, 'a gate error never runs anything');
});

test('isUsageOnlyOutput: a help banner is not a run, a real report is', () => {
  assert.equal(isUsageOnlyOutput('usage: live-run-stop.mjs --stop-hook  (reads the Stop hook JSON on stdin)\n'), true);
  assert.equal(isUsageOnlyOutput('Usage:\n  node scripts/x.js [--dry-run]\n\nOptions:\n  --dry-run   print only\n  --json      json\n'), true);
  assert.equal(isUsageOnlyOutput('Checked 120 shows\n3 problems found\nusage: none'), false);
  assert.equal(isUsageOnlyOutput('usage: x\nWrote 4 rows to data/a.json'), false);
  assert.equal(isUsageOnlyOutput(''), false);
});
