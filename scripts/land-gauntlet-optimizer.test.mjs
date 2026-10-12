// BRO-4299: scripts/lib/land-gauntlet-optimizer.js decides when land.yml's
// `checks` job may skip both gauntlet runs. These tests require() the real
// module (CLAUDE.md rule 15) and prove (a) the prose-only scenarios skip the
// gauntlet, (b) anything code-like, unknown, referenced, strict or malformed
// never does, and (c) land.yml wires the decision fail-closed.
//   node --test scripts/land-gauntlet-optimizer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const MOD = path.join(HERE, 'lib', 'land-gauntlet-optimizer.js');
const {
  MAX_FILES,
  classifyPath,
  parseRawDiff,
  referenceNeedles,
  decideGauntletSkip,
  makeGitReferenceChecker,
  main,
} = require(MOD);
const { isCacheKeyRelevant } = require('./lib/land-gate-delta.js');

const mod = (p, status = 'M') => ({
  path: p,
  status,
  oldMode: status === 'A' ? '000000' : '100644',
  newMode: status === 'D' ? '000000' : '100644',
});
const never = () => false;

// ── Scenarios where the gauntlet is eliminated ─────────────────────────────

const PROSE_SCENARIOS = {
  'memory note added': [mod('memory/feedback_new_lesson.md', 'A')],
  'docs page edited': [mod('docs/opening-night-express.md')],
  'cloud-memory mirror updated': [mod('cloud-memory/autonomous-loop-schedule.md')],
  'root handoff note deleted': [mod('HANDOFF-old-note.md', 'D')],
  'nested docs subdir + root sprint plan': [mod('docs/specs/new-spec.md', 'A'), mod('sprint-plan-new.md', 'A')],
};

for (const [name, changes] of Object.entries(PROSE_SCENARIOS)) {
  test(`skips both gauntlets: ${name}`, () => {
    const d = decideGauntletSkip({ changes, isReferenced: never });
    assert.equal(d.skip, true, d.reason);
    assert.deepEqual(d.blockers, []);
  });
}

// ── Never skip: code, config, tests, data, unknowns ────────────────────────

const NEVER_SKIP = [
  'src/app/page.tsx', 'src/lib/README.md', 'src/notes.md',
  'scripts/lib/land-gauntlet.sh', 'scripts/lib/CLAUDE.md', 'scripts/opening-night-prompts/phase1.md', 'scripts/foo.md',
  '.github/workflows/land.yml', '.github/workflows/CLAUDE.md', '.github/pull_request_template.md',
  'tests/unit/foo.test.mjs', 'tests/unit-test-manifest.txt', 'tests/README.md',
  'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.js', 'tailwind.config.ts',
  'playwright.config.ts', 'vercel.json', '.gitignore', '.gitattributes', '.eslintrc.json', '.nvmrc',
  '.claude/hooks/x.sh', '.claude/skills/foo/SKILL.md', 'tools/x.js', 'supabase/functions/a/index.ts',
  'data/shows.json', 'data/audit/notes.md', 'public/data/shows/x.json', 'content/reviews/post.md',
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'memory/CLAUDE.md', 'docs/claude.md',
  'docs/audit/report.json', 'docs/plan.txt', 'memory/notes.MD', 'memory/notes', 'LICENSE', 'supabase-schema.sql',
  'design-ios-show-stats-mockup.html', 'some/unknown/dir/file.md', 'random.bin',
  '../escape.md', 'memory/../src/x.md', '/abs.md', 'memory//x.md', 'docs/a\nb.md', '',
];

for (const p of NEVER_SKIP) {
  test(`never skips for ${JSON.stringify(p)}`, () => {
    assert.equal(classifyPath(p).skippable, false, `classifyPath(${JSON.stringify(p)})`);
    // alone, and mixed into an otherwise-prose diff
    for (const changes of [[mod(p)], [mod('docs/a.md'), mod(p), mod('memory/b.md')]]) {
      const d = decideGauntletSkip({ changes, isReferenced: never });
      assert.equal(d.skip, false, `${JSON.stringify(p)} must force the gauntlet`);
      assert.ok(d.blockers.some((b) => b.path === String(p)));
    }
  });
}

test('every code root never skips, whatever the file name', () => {
  for (const root of ['src', 'scripts', 'tests', '.github', '.claude', 'tools', 'supabase', 'data', 'public', 'content']) {
    for (const f of ['x.md', 'README.md', 'deep/nested/notes.md', 'x.js']) {
      assert.equal(classifyPath(`${root}/${f}`).skippable, false, `${root}/${f}`);
    }
  }
});

test('a prose path that a tracked code/test file names never skips', () => {
  const referenced = new Set(['memory/hooks-audit.md']);
  const d = decideGauntletSkip({
    changes: [mod('memory/hooks-audit.md'), mod('memory/unread.md')],
    isReferenced: (p) => referenced.has(p),
  });
  assert.equal(d.skip, false);
  assert.deepEqual(d.blockers.map((b) => b.path), ['memory/hooks-audit.md']);
});

test('symlinks, gitlinks, type changes and unknown statuses never skip', () => {
  const cases = [
    { path: 'docs/link.md', status: 'A', oldMode: '000000', newMode: '120000' },
    { path: 'docs/sub.md', status: 'A', oldMode: '000000', newMode: '160000' },
    { path: 'docs/t.md', status: 'T', oldMode: '100644', newMode: '120000' },
    { path: 'docs/u.md', status: 'U', oldMode: '100644', newMode: '100644' },
    { path: 'docs/x.md', status: 'X', oldMode: '100644', newMode: '100644' },
    { path: 'docs/r.md', status: 'R', oldMode: '100644', newMode: '100644' },
  ];
  for (const c of cases) {
    const d = decideGauntletSkip({ changes: [c], isReferenced: never });
    assert.equal(d.skip, false, JSON.stringify(c));
  }
});

test('strict mode, an empty diff, too many files, a missing checker or a bad list never skip', () => {
  const prose = [mod('docs/a.md')];
  assert.equal(decideGauntletSkip({ changes: prose, isReferenced: never, strict: true }).skip, false);
  assert.equal(decideGauntletSkip({ changes: [], isReferenced: never }).skip, false);
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => mod(`docs/n${i}.md`));
  assert.equal(decideGauntletSkip({ changes: many, isReferenced: never }).skip, false);
  assert.equal(decideGauntletSkip({ changes: many.slice(0, MAX_FILES), isReferenced: never }).skip, true);
  assert.equal(decideGauntletSkip({ changes: prose }).skip, false);
  assert.equal(decideGauntletSkip({ changes: null, isReferenced: never }).skip, false);
  assert.equal(decideGauntletSkip().skip, false);
});

// Soundness of skipping BOTH runs: a skippable path is outside the
// verification-relevant tree the base-gauntlet cache key hashes, so the
// rebased tip's code tree equals the base's.
test('every skippable path is outside the verification-relevant code tree', () => {
  const sample = [
    ...Object.values(PROSE_SCENARIOS).flat().map((c) => c.path),
    ...execFileSync('git', ['ls-files', 'memory', 'cloud-memory', 'docs', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean),
  ];
  let skippable = 0;
  for (const p of sample) {
    if (!classifyPath(p).skippable) continue;
    skippable++;
    assert.equal(isCacheKeyRelevant(p), false, `${p} is skippable but cache-key relevant`);
  }
  assert.ok(skippable > 0);
});

test('referenceNeedles: basename and stem', () => {
  assert.deepEqual(referenceNeedles('memory/hooks-audit.md'), ['hooks-audit.md', 'hooks-audit']);
  assert.deepEqual(referenceNeedles('README.md'), ['README.md', 'README']);
});

test('parseRawDiff: parses -z raw records and throws on anything else', () => {
  const z = ':000000 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A\0docs/a b.md\0'
    + ':100644 100644 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 M\0memory/x.md\0';
  assert.deepEqual(parseRawDiff(z), [
    { path: 'docs/a b.md', status: 'A', oldMode: '000000', newMode: '100644' },
    { path: 'memory/x.md', status: 'M', oldMode: '100644', newMode: '100644' },
  ]);
  assert.deepEqual(parseRawDiff(''), []);
  assert.throws(() => parseRawDiff('garbage\0x\0'));
  assert.throws(() => parseRawDiff(':100644 100644 aaa bbb R100\0old.md\0new.md\0'));
  assert.throws(() => parseRawDiff(':100644 100644 aaa bbb M\0'));
});

// ── End to end over a throwaway git repo ───────────────────────────────────

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-optimizer-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  const write = (rel, body) => { fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  write('scripts/check.js', "require('fs').readFileSync('docs/read-by-a-check.md');\n");
  write('tests/unit/a.test.mjs', "// reads memory/hooks-audit.md\n");
  write('docs/read-by-a-check.md', 'v1\n');
  write('memory/hooks-audit.md', 'v1\n');
  write('memory/free.md', 'v1\n');
  write('README.md', 'v1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const commit = (msg, fn) => { fn(write); git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  return { dir, git, base, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runCli(cwd, base, head, extra = []) {
  const out = path.join(cwd, '..', `${path.basename(cwd)}.out`);
  fs.rmSync(out, { force: true });
  const r = spawnSync(process.execPath, [MOD, '--base', base, '--head', head, '--github-output', out, ...extra], { cwd, encoding: 'utf8' });
  const output = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  fs.rmSync(out, { force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output };
}

test('CLI end to end: unreferenced prose skips; referenced prose and code run', () => {
  const t = tmpRepo();
  try {
    const prose = t.commit('prose', (w) => { w('memory/free.md', 'v2\n'); w('docs/new-page.md', 'new\n'); w('README.md', 'v2\n'); });
    // README is unreferenced in this fixture repo, so it skips here.
    let r = runCli(t.dir, t.base, prose);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, 'skip=true\n', r.stdout);

    t.git('checkout', '-q', '--detach', t.base);
    const referenced = t.commit('referenced doc', (w) => w('docs/read-by-a-check.md', 'v2\n'));
    r = runCli(t.dir, t.base, referenced);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, 'skip=false\n');

    t.git('checkout', '-q', '--detach', t.base);
    const testRead = t.commit('test-referenced memory', (w) => w('memory/hooks-audit.md', 'v2\n'));
    r = runCli(t.dir, t.base, testRead);
    assert.equal(r.output, 'skip=false\n');

    t.git('checkout', '-q', '--detach', t.base);
    const code = t.commit('code', (w) => { w('memory/free.md', 'v3\n'); w('scripts/check.js', '// changed\n'); });
    r = runCli(t.dir, t.base, code);
    assert.equal(r.output, 'skip=false\n');

    t.git('checkout', '-q', '--detach', t.base);
    fs.mkdirSync(path.join(t.dir, 'src'), { recursive: true });
    t.git('mv', 'memory/free.md', 'src/free.md');
    t.git('commit', '-q', '-m', 'rename into src');
    const renamed = t.git('rev-parse', 'HEAD');
    r = runCli(t.dir, t.base, renamed);
    assert.equal(r.output, 'skip=false\n', 'a rename is judged on both sides (--no-renames)');

    t.git('checkout', '-q', '--detach', prose);
    r = runCli(t.dir, t.base, prose, ['--strict', '1']);
    assert.equal(r.output, 'skip=false\n');
  } finally { t.cleanup(); }
});

test('CLI fails closed: wrong HEAD, bad shas, outside a repo => exit 1 and no output', () => {
  const t = tmpRepo();
  try {
    const prose = t.commit('prose', (w) => w('memory/free.md', 'v2\n'));
    t.git('checkout', '-q', '--detach', t.base);
    let r = runCli(t.dir, t.base, prose);
    assert.equal(r.status, 1);
    assert.equal(r.output, '');
    assert.match(r.stderr, /running the full gauntlet/);
    r = runCli(t.dir, 'nope', prose);
    assert.equal(r.status, 1);
    assert.equal(r.output, '');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'land-optimizer-norepo-'));
    try {
      r = runCli(empty, t.base, prose);
      assert.equal(r.status, 1);
      assert.equal(r.output, '');
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  } finally { t.cleanup(); }
});

test('makeGitReferenceChecker: overlapping needles cannot hide a longer one', () => {
  const t = tmpRepo();
  try {
    t.commit('reader', (w) => w('scripts/reader.js', "const f = 'docs/foobar.md';\n"));
    const check = makeGitReferenceChecker(t.dir, ['docs/foo.md', 'docs/foobar.md', 'docs/zzz.md']);
    assert.equal(check('docs/foobar.md'), true);
    assert.equal(check('docs/foo.md'), true); // "foo" is a substring of the reader line: conservative
    assert.equal(check('docs/zzz.md'), false);
    // Markdown and prose dirs are not readers.
    t.commit('prose mention', (w) => { w('docs/index.md', 'see zzz.md\n'); w('memory/x.md', 'zzz\n'); w('notes.md', 'zzz\n'); });
    assert.equal(makeGitReferenceChecker(t.dir, ['docs/zzz.md'])('docs/zzz.md'), false);
    assert.throws(() => makeGitReferenceChecker(path.join(t.dir, 'missing-dir'), ['docs/zzz.md']));
  } finally { t.cleanup(); }
});

test('main() writes skip=true only after a positive decision', () => {
  const t = tmpRepo();
  try {
    const prose = t.commit('prose', (w) => w('memory/free.md', 'v2\n'));
    const out = path.join(t.dir, '..', `${path.basename(t.dir)}.gho`);
    const summary = `${out}.md`;
    try {
      const d = main(['--base', t.base, '--head', prose, '--cwd', t.dir, '--github-output', out, '--summary-file', summary], { log: () => {} });
      assert.equal(d.skip, true);
      assert.equal(fs.readFileSync(out, 'utf8'), 'skip=true\n');
      assert.match(fs.readFileSync(summary, 'utf8'), /SKIP both gauntlets/);
    } finally { fs.rmSync(out, { force: true }); fs.rmSync(summary, { force: true }); }
  } finally { t.cleanup(); }
});

// ── land.yml wiring ────────────────────────────────────────────────────────

const LAND_YML = fs.readFileSync(path.join(ROOT, '.github/workflows/land.yml'), 'utf8');

function checksSteps() {
  const start = LAND_YML.indexOf('\n  checks:\n');
  const end = LAND_YML.indexOf('\n  admit:\n');
  assert.ok(start > 0 && end > start, 'checks job found');
  const job = LAND_YML.slice(start, end);
  return job.split(/\n      - (?=name:|uses:)/).slice(1).map((s) => ({
    name: (/name:\s*(.+)/.exec(s) || [])[1] || '',
    id: (/\n\s+id:\s*(\S+)/.exec(s) || [])[1] || '',
    ifExpr: (/\n\s+if:\s*(.+)/.exec(s) || [])[1] || '',
    body: s,
  }));
}

test('land.yml: the optimizer runs from the BASE tree, fail-closed, right after the rebase', () => {
  const steps = checksSteps();
  const i = steps.findIndex((s) => s.id === 'optimize');
  assert.ok(i > 0, 'an `optimize` step exists');
  assert.equal(steps[i - 1].id, 'rebase', 'optimize runs right after the rebase');
  const s = steps[i];
  assert.match(s.body, /continue-on-error:\s*true/);
  assert.match(s.body, /git show "\$BASE:scripts\/lib\/land-gauntlet-optimizer\.js"/);
  assert.doesNotMatch(s.body, /HEAD:scripts\/lib\/land-gauntlet-optimizer/, 'never the branch copy');
  assert.match(s.body, /LAND_STRICT_GATES/);
});

test('land.yml: every step after the optimizer except the verdict is gated on it', () => {
  const steps = checksSteps();
  const i = steps.findIndex((s) => s.id === 'optimize');
  const after = steps.slice(i + 1);
  assert.ok(after.length >= 15, `expected the full gauntlet after optimize, got ${after.length} steps`);
  for (const s of after) {
    if (s.id === 'verdict') continue;
    assert.match(s.ifExpr, /steps\.optimize\.outputs\.skip != 'true'/, `step "${s.name}" must not run on a skip`);
  }
  for (const id of ['deps', 'coredata', 'base_run', 'branch_run', 'delta', 'confirm', 'tipkey']) {
    assert.ok(after.some((s) => s.id === id), `${id} is after optimize`);
  }
  const verdict = after.find((s) => s.id === 'verdict');
  assert.ok(verdict && /always\(\)/.test(verdict.ifExpr));
});

// Run a checks-job step's `run:` block the way Actions does (bash -eo
// pipefail), with every `${{ … }}` expression replaced from `exprs`.
function runStep(step, { exprs = {}, env = {}, cwd = ROOT } = {}) {
  const m = /\n        run: \|\n([\s\S]*)$/.exec(step.body);
  assert.ok(m, `step ${step.id} has a run block`);
  const script = m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n')
    .replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, e) => (e in exprs ? exprs[e] : ''));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-step-'));
  const out = path.join(tmp, 'out');
  const summary = path.join(tmp, 'summary');
  fs.writeFileSync(out, '');
  fs.writeFileSync(summary, '');
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    cwd, encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: tmp, BRANCH: 'land/test', ...env },
  });
  const res = { status: r.status, stdout: r.stdout, stderr: r.stderr, output: fs.readFileSync(out, 'utf8'), summary: fs.readFileSync(summary, 'utf8') };
  fs.rmSync(tmp, { recursive: true, force: true });
  return res;
}

test('land.yml: the Gate verdict step is GREEN both on a skip and on a full green run', () => {
  const verdict = checksSteps().find((s) => s.id === 'verdict');
  const ids = ['rebase', 'deps', 'coredata', 'manifests', 'actionlint', 'harness', 'basekey', 'base_cache', 'base_artifact', 'base_run', 'branch_run', 'delta', 'confirm'];
  const skipped = Object.fromEntries(ids.map((id) => [`steps.${id}.outcome`, id === 'rebase' ? 'success' : 'skipped']));
  let r = runStep(verdict, { exprs: { ...skipped, 'steps.optimize.outcome': 'success', "steps.optimize.outputs.skip || 'unset'": 'true', 'steps.optimize.outputs.skip': 'true' } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.output, /^gate=$/m);
  assert.match(r.summary, /verdict: GREEN/);
  assert.match(r.summary, /gauntlet: SKIPPED/);

  const green = Object.fromEntries(ids.map((id) => [`steps.${id}.outcome`, ['confirm'].includes(id) ? 'skipped' : 'success']));
  r = runStep(verdict, { exprs: { ...green, 'steps.optimize.outcome': 'success', "steps.optimize.outputs.skip || 'unset'": 'false', 'steps.optimize.outputs.skip': 'false' } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.summary, /verdict: GREEN/);
  assert.doesNotMatch(r.summary, /SKIPPED/);

  // A red gate still refuses (the optimizer never masks one).
  r = runStep(verdict, { exprs: { ...green, 'steps.branch_run.outcome': 'failure', 'steps.optimize.outcome': 'failure' } });
  assert.equal(r.status, 1);
  assert.match(r.output, /^gate=branch-gauntlet$/m);
});

test('land.yml: the optimize step skips only when the BASE carries the optimizer', () => {
  const step = checksSteps().find((s) => s.id === 'optimize');
  const t = tmpRepo();
  try {
    // Base WITHOUT the optimizer: no output, full gauntlet.
    const prose1 = t.commit('prose', (w) => w('README.md', 'v2\n'));
    // The step reads BASE/REBASED/LAND_STRICT_GATES from its env: block.
    assert.match(step.body, /BASE: \$\{\{ steps\.rebase\.outputs\.base \}\}/);
    assert.match(step.body, /REBASED: \$\{\{ steps\.rebase\.outputs\.rebased \}\}/);
    let r = runStep(step, { cwd: t.dir, env: { BASE: t.base, REBASED: prose1 } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, '');

    // Base WITH it: a prose-only branch skips; strict mode does not.
    t.git('checkout', '-q', '--detach', t.base);
    const base2 = t.commit('add optimizer', (w) => w('scripts/lib/land-gauntlet-optimizer.js', fs.readFileSync(MOD, 'utf8')));
    const prose2 = t.commit('prose', (w) => w('README.md', 'v3\n'));
    const env = { BASE: base2, REBASED: prose2 };
    r = runStep(step, { cwd: t.dir, env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, 'skip=true\n', r.stdout);
    r = runStep(step, { cwd: t.dir, env: { ...env, LAND_STRICT_GATES: '1' } });
    assert.equal(r.output, 'skip=false\n');

    // The branch's own (edited) copy is never the one that runs.
    const evil = t.commit('code + always-skip optimizer', (w) => {
      w('scripts/lib/land-gauntlet-optimizer.js', "require('fs').appendFileSync(process.argv[process.argv.indexOf('--github-output') + 1], 'skip=true\\n');\n");
    });
    r = runStep(step, { cwd: t.dir, env: { BASE: base2, REBASED: evil } });
    assert.equal(r.output, 'skip=false\n');
  } finally { t.cleanup(); }
});
