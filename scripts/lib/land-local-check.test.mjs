import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs, { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { parseArgs, newFailureFiles, DEFAULT_GATES, LOCAL_SKIPPED_GATES } = require('./land-local-check.js');
const { GATES, ADVISORY_GATES } = require('./land-gate-delta.js');
const R = require('./codex-runner.js');

test('parseArgs: default gates are real gauntlet gates; --all, --gates and bad input', () => {
  for (const g of DEFAULT_GATES) assert.ok(GATES.includes(g), `${g} is a land-gate-delta gate`);
  assert.deepEqual(parseArgs([]).gates, DEFAULT_GATES);
  assert.deepEqual(parseArgs(['--all']).gates, GATES);
  assert.deepEqual(parseArgs(['--gates', 'lint-workflows']).gates, ['lint-workflows']);
  assert.equal(parseArgs(['--max-wait-minutes', '5']).maxWaitMs, 300_000);
  assert.match(parseArgs(['--gates', 'nope']).error, /unknown gate/);
  assert.match(parseArgs(['--gates', '']).error, /unknown gate/);
  assert.match(parseArgs(['--bogus']).error, /unknown argument/);
  assert.match(parseArgs(['--max-wait-minutes', 'x']).error, /positive/);
});

test('every gate land.yml blocks on runs by default or is skipped with a reason (BRO-5771)', () => {
  const blocking = GATES.filter((g) => !(ADVISORY_GATES[g] && ADVISORY_GATES[g]()));
  for (const g of blocking) {
    assert.ok(DEFAULT_GATES.includes(g) || (LOCAL_SKIPPED_GATES[g] || '').length > 10,
      `${g} blocks a land but is neither a default gate nor in LOCAL_SKIPPED_GATES with a reason`);
  }
  for (const g of ['unit-tests-tsx', 'tsc', 'next-lint']) assert.ok(DEFAULT_GATES.includes(g), `${g} runs by default`);
  for (const g of Object.keys(LOCAL_SKIPPED_GATES)) assert.ok(GATES.includes(g), `${g} is a real gate`);
});

test('newFailureFiles: a tsx-gate failure is not re-run under plain node', () => {
  const report = [
    '#### unit-tests-tsx — NEW on the branch (blocking)',
    '  - `tests/unit/commercial-unreleased.test.mjs::pages only load commercial data [testCodeFailure]`',
  ].join('\n');
  assert.equal(newFailureFiles(report), null);
});

test('withFileMutex: a throwing onWait gives up without taking or deleting the held lock', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'llc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const p = join(dir, 'm.lock');
  writeFileSync(p, String(process.ppid)); // a live holder that is not us
  let ran = false;
  assert.throws(() => R.withFileMutex(p, () => { ran = true; }, { pollMs: 10, onWait: () => { throw new Error('timeout'); } }), /timeout/);
  assert.equal(ran, false);
  assert.ok(existsSync(p), 'the holder keeps its lock');
  assert.equal(R.withFileMutex(join(dir, 'free.lock'), () => 7), 7);
  assert.ok(!existsSync(join(dir, 'free.lock')), 'released after fn');
  assert.match(R.CONTAINER_LAND_MUTEX, /bsc-land-checks\.lock$/);
});

test('newFailureFiles: the NEW test files only; null when a new failure is not a test case', () => {
  const report = [
    '#### unit-tests-node — NEW on the branch (blocking)',
    '  - `tests/unit/duplicate-of-url-mismatch.test.mjs::duplicateOf-cycle mismatches are excluded [testCodeFailure]`',
    '',
    '#### unit-tests-node — pre-existing on origin/main (not blocking; still real, file an issue)',
    '  - `scripts/award-scores.test.mjs::computeSiteAwardScore [testCodeFailure]`',
  ].join('\n');
  assert.deepEqual(newFailureFiles(report), ['tests/unit/duplicate-of-url-mismatch.test.mjs']);
  assert.equal(newFailureFiles('#### lint-workflows — NEW on the branch (blocking)\n  - `lint-workflows::actionlint`'), null);
  assert.deepEqual(newFailureFiles('no lists at all'), []);
  const table = (rows) => ['| gate | verdict | mode | new |', '|---|---|---|---|', ...rows].join('\n');
  assert.deepEqual(newFailureFiles(table(['| unit-tests-node | **FAIL** | delta | 1 |']) + '\n' + report), ['tests/unit/duplicate-of-url-mismatch.test.mjs']);
  assert.equal(newFailureFiles(table(['| unit-tests-node | **FAIL** | delta | 1 |', '| scripts-lib-tests | **FAIL** | strict | 0 |']) + '\n' + report), null,
    'a gate that failed with no NEW list (crash, timeout) is never cleared by re-running another gate\'s files');
});

test('missingCoreData: a worktree without data/*.json is not ready (false "new failures", BRO-6037 session)', () => {
  const { missingCoreData, CORE_DATA_FILES } = require('./land-local-check.js');
  assert.ok(CORE_DATA_FILES.includes('data/shows.json'));
  assert.deepEqual(missingCoreData('/r', () => true), []);
  assert.deepEqual(missingCoreData('/r', () => false), CORE_DATA_FILES);
  assert.deepEqual(missingCoreData('/r', (p) => !p.endsWith('reviews.json')), ['data/reviews.json']);
  assert.deepEqual(missingCoreData('/r', (p) => !p.endsWith('cast-manifest.json') && !p.endsWith('actor-slugs.json')),
    ['data/cast-manifest.json', 'data/actor-slugs.json']);
});

// Mock process boundaries, not the checker: run its real main(), file copies, readiness
// check and return-to handling without checking out this checkout or running whole batches.
function checkerWithRunner(t, spawn) {
  t.mock.method(require('node:child_process'), 'spawnSync', spawn);
  const filename = require.resolve('./land-local-check.js');
  const cached = require.cache[filename];
  delete require.cache[filename];
  try { return require(filename); }
  finally { require.cache[filename] = cached; }
}

test('generated manifests missing: main exits 3 with build commands before fetch or gates', (t) => {
  const messages = [];
  t.mock.method(console, 'error', (message) => messages.push(message));
  t.mock.method(fs, 'existsSync', (p) => !/data\/(cast-manifest|actor-slugs)\.json$/.test(String(p)));
  const checker = checkerWithRunner(t, (cmd, args) => {
    assert.equal(cmd, 'git');
    assert.equal(args[0], 'status', 'missing data must stop before fetch, mutex or gauntlet');
    return { status: 0, stdout: '', stderr: '' };
  });
  assert.equal(checker.main([]), 3);
  const message = messages.join('\n');
  assert.match(message, /data\/cast-manifest\.json/);
  assert.match(message, /data\/actor-slugs\.json/);
  assert.match(message, /node scripts\/build-cast-manifest\.js/);
  assert.match(message, /node scripts\/build-actor-slugs-manifest\.js/);
});

test('base comparison runs the staged gauntlet in a throwaway worktree, never checking out this tree', (t) => {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const gitCalls = [];
  const messages = [];
  let compared = false;
  t.mock.method(console, 'log', (message) => messages.push(message));
  t.mock.method(R, 'withFileMutex', (_lock, fn) => fn());
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => /data\/(shows|reviews|cast-manifest|actor-slugs)\.json$/.test(String(p)) || exists(p));
  const checker = checkerWithRunner(t, (cmd, args, opts) => {
    const result = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (cmd === 'git') {
      gitCalls.push(args);
      switch (args[0]) {
        case 'status': case 'fetch': case 'ls-files': case 'worktree': return result();
        case 'diff': return result(); // no package.json/lock change vs base (BRO-6114)
        case 'rev-parse': return result(head);
        case 'merge-base': return result(base);
        case 'rev-list': return result('0');
      }
    }
    if (cmd === 'bash' && args[0] === 'scripts/lib/land-gauntlet.sh') {
      fs.mkdirSync(args[1], { recursive: true });
      fs.writeFileSync(join(args[1], 'meta.json'), '{}');
      t.after(() => rmSync(join(args[1], '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      return result();
    }
    if (cmd === 'bash') {
      compared = true;
      assert.equal(args.length, 2, 'no --checkout/--return-to: the tree under test is already the base');
      assert.match(opts.cwd, /basewt$/, 'the base gates run inside the throwaway worktree');
      for (const name of ['land-gauntlet.sh', 'tsc-node-options.sh']) {
        assert.equal(fs.readFileSync(join(args[0], '..', name), 'utf8'),
          fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
      }
      return result();
    }
    if (cmd === 'node' && args[1] === '--red-gates') return result('tsc');
    if (cmd === 'node' && args[1] === '--base-dir') return result('no new failures');
    assert.fail(`unexpected command: ${cmd} ${args.join(' ')}`);
  });
  assert.equal(checker.main(['--gates', 'tsc']), 0);
  assert.ok(compared, 'the red gate was compared against the base');
  assert.equal(gitCalls.filter((a) => a[0] === 'checkout').length, 0, 'this checkout is never switched');
  const add = gitCalls.find((a) => a[0] === 'worktree' && a[1] === 'add');
  assert.deepEqual([add[2], add[add.length - 1]], ['--detach', base]);
  assert.ok(gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'remove'), 'the worktree is removed afterwards');
  assert.ok(messages.some((message) => message.includes('CLEAN, no new failures')));
});

// BRO-6252: the caller keeps committing while the ~20 min base run is in flight. Real git, no mocks.
test('withBaseWorktree leaves the caller branch and HEAD alone when a commit lands mid-run', () => {
  const { withBaseWorktree } = require('./land-local-check.js');
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const root = fs.realpathSync(mkdtempSync(join(tmpdir(), 'wt-caller-')));
  const scratch = mkdtempSync(join(tmpdir(), 'wt-scratch-'));
  try {
    sh(root, 'init', '-q', '-b', 'work');
    sh(root, 'config', 'user.email', 't@example.com'); sh(root, 'config', 'user.name', 't');
    writeFileSync(join(root, '.gitignore'), 'node_modules\ndata/secret.json\n.next/\n.claude/\n*.lock\ndata/my "odd" é.json\n');
    fs.mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data/tracked.json'), '1');
    writeFileSync(join(root, 'f.txt'), 'base\n');
    sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'base');
    const base = sh(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'f.txt'), 'head\n');
    sh(root, 'commit', '-qam', 'head');
    fs.mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules/pkg/i.js'), 'x');
    writeFileSync(join(root, 'data/secret.json'), 'private');
    fs.mkdirSync(join(root, '.next')); writeFileSync(join(root, '.next/b'), 'build');
    fs.mkdirSync(join(root, '.claude')); writeFileSync(join(root, '.claude/state.jsonl'), 's');
    fs.mkdirSync(join(root, 'data/job.lock')); writeFileSync(join(root, 'data/odd.lock'), 'l');
    writeFileSync(join(root, 'data/my "odd" é.json'), 'odd');
    const dir = join(scratch, 'basewt');
    let seen;
    const result = withBaseWorktree(root, base, dir, (wt) => {
      seen = {
        file: fs.readFileSync(join(wt, 'f.txt'), 'utf8'),
        secret: fs.readFileSync(join(wt, 'data/secret.json'), 'utf8'),
        nm: fs.existsSync(join(wt, 'node_modules/pkg/i.js')),
        next: fs.existsSync(join(wt, '.next')),
        live: [fs.existsSync(join(wt, '.claude')), fs.existsSync(join(wt, 'data/job.lock')), fs.existsSync(join(wt, 'data/odd.lock'))],
        odd: fs.readFileSync(join(wt, 'data/my "odd" é.json'), 'utf8'),
      };
      // the session commits and edits meanwhile
      writeFileSync(join(root, 'g.txt'), 'new\n');
      sh(root, 'add', 'g.txt'); sh(root, 'commit', '-qm', 'mid-run commit');
      writeFileSync(join(root, 'g.txt'), 'edited after\n');
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.deepEqual(seen, { file: 'base\n', secret: 'private', nm: true, next: false, live: [false, false, false], odd: 'odd' });
    assert.equal(sh(root, 'symbolic-ref', '--short', 'HEAD'), 'work', 'still on the branch, not detached');
    assert.equal(sh(root, 'log', '-1', '--format=%s'), 'mid-run commit', 'HEAD is the commit made mid-run');
    assert.equal(fs.readFileSync(join(root, 'g.txt'), 'utf8'), 'edited after\n', 'edits made mid-run survive');
    assert.equal(fs.readFileSync(join(root, 'f.txt'), 'utf8'), 'head\n');
    assert.ok(fs.existsSync(join(root, 'node_modules/pkg/i.js')), 'removal did not follow the symlink into the caller data');
    assert.equal(fs.readFileSync(join(root, 'data/secret.json'), 'utf8'), 'private');
    assert.ok(!fs.existsSync(dir), 'worktree directory removed');
    assert.equal(sh(root, 'worktree', 'list').split('\n').length, 1, 'worktree entry pruned');
    // the worktree is also removed when fn throws
    assert.throws(() => withBaseWorktree(root, base, dir, () => { throw new Error('boom'); }), /boom/);
    assert.ok(!fs.existsSync(dir));
    assert.equal(sh(root, 'worktree', 'list').split('\n').length, 1);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('main exits 3 (not ready) when core data is missing, before any gate runs', () => {
  const src = require('fs').readFileSync(new URL('./land-local-check.js', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('function main('));
  assert.ok(main.indexOf('missingCoreData(ROOT)') > 0 && main.indexOf('missingCoreData(ROOT)') < main.indexOf('mkdtempSync'));
});

// BRO-6152: the base run executes a COPY of land-gauntlet.sh outside the tree it checks out.
// Every sibling it calls via $(dirname "${BASH_SOURCE[0]}")/<file> must be staged next to it,
// by stageGauntletHarness (land-local-check, codex daily runner) and by land.yml's harness step.
test('harness list covers every sibling the gauntlet calls, and land.yml stages all of them', () => {
  const { HARNESS_FILES } = require('./land-local-check.js');
  const g = fs.readFileSync(new URL('./land-gauntlet.sh', import.meta.url), 'utf8');
  const siblings = [...g.matchAll(/\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/([\w.-]+)/g)].map((m) => m[1]);
  assert.ok(siblings.includes('tsc-node-options.sh'), 'the sibling pattern still matches the tsc helper reference');
  for (const s of siblings) assert.ok(HARNESS_FILES.includes(s), `${s} is in HARNESS_FILES`);
  const yml = fs.readFileSync(new URL('../../.github/workflows/land.yml', import.meta.url), 'utf8');
  const step = yml.slice(yml.indexOf("name: Stage the branch's gauntlet harness"));
  const run = step.slice(0, step.indexOf('\n      - ')).match(/run: (.*)/)[1];
  for (const f of HARNESS_FILES) assert.ok(run.includes(`scripts/lib/${f}`), `land.yml stages ${f}: ${run}`);
  assert.match(run, /"\$RUNNER_TEMP\/"$/, 'land.yml copies into $RUNNER_TEMP, where the base step runs land-gauntlet.sh');
});

test('stageGauntletHarness copies the gauntlet and its siblings; a helper absent from the source is skipped', () => {
  const { stageGauntletHarness, HARNESS_FILES } = require('./land-local-check.js');
  const root = new URL('../..', import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), 'stage-harness-'));
  try {
    const out = join(dir, 'h');
    assert.equal(stageGauntletHarness(root, out), join(out, 'land-gauntlet.sh'));
    for (const f of HARNESS_FILES) assert.equal(fs.readFileSync(join(out, f), 'utf8'), fs.readFileSync(join(root, 'scripts/lib', f), 'utf8'));
    // The codex runner runs the copy as another user: a 0700 mkdtemp dir would be unreadable to it.
    const private700 = mkdtempSync(join(tmpdir(), 'stage-harness-700-'));
    try {
      stageGauntletHarness(root, private700);
      assert.equal(fs.statSync(private700).mode & 0o755, 0o755, 'harness dir readable and searchable by others, not writable');
    } finally { rmSync(private700, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    const old = join(dir, 'old');
    fs.mkdirSync(join(old, 'scripts/lib'), { recursive: true });
    writeFileSync(join(old, 'scripts/lib/land-gauntlet.sh'), '# old\n');
    stageGauntletHarness(old, join(dir, 'h2'));
    assert.ok(existsSync(join(dir, 'h2/land-gauntlet.sh')));
    assert.ok(!existsSync(join(dir, 'h2/tsc-node-options.sh')));
    assert.throws(() => stageGauntletHarness(join(dir, 'nowhere'), join(dir, 'h3')), /ENOENT/, 'a missing gauntlet is an error');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('gauntlet copied alone resolves tsc NODE_OPTIONS quietly to the floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lone-gauntlet-'));
  try {
    const g = fs.readFileSync(new URL('./land-gauntlet.sh', import.meta.url), 'utf8');
    const start = g.indexOf('TSC_HELPER=');
    const block = g.slice(start, g.indexOf('\n', g.indexOf('[ -n "$TSC_NODE_OPTIONS" ]')));
    for (const [name, withHelper] of [['alone', false], ['staged', true]]) {
      const d = join(dir, name); fs.mkdirSync(d);
      writeFileSync(join(d, 'probe.sh'), `${block}\nprintf '%s' "$TSC_NODE_OPTIONS"\n`);
      if (withHelper) fs.copyFileSync(new URL('./tsc-node-options.sh', import.meta.url), join(d, 'tsc-node-options.sh'));
      const r = spawnSync('bash', [join(d, 'probe.sh')], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
      assert.equal(r.stderr, '', `${name}: no stderr (BRO-6152 saw "No such file or directory")`);
      assert.match(r.stdout, /--max-old-space-size=6144/, name);
    }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// BRO-6114: the base worktree shares this checkout's node_modules, so a deps change must not be
// judged against a base run (a dependency regression would read as "red on base too").
test('depsChangedSince: true only when package.json or package-lock.json differ from the base', () => {
  const { depsChangedSince } = require('./land-local-check.js');
  const root = mkdtempSync(join(tmpdir(), 'deps-changed-'));
  try {
    const sh = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr }; };
    sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@example.com'); sh('config', 'user.name', 't');
    writeFileSync(join(root, 'package.json'), '{}\n'); writeFileSync(join(root, 'package-lock.json'), '{}\n'); writeFileSync(join(root, 'a.js'), '1\n');
    sh('add', '.'); sh('commit', '-q', '-m', 'base'); const base = sh('rev-parse', 'HEAD');
    writeFileSync(join(root, 'a.js'), '2\n'); sh('commit', '-q', '-am', 'code only'); const code = sh('rev-parse', 'HEAD');
    assert.equal(depsChangedSince(git, base, code), false);
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n'); sh('commit', '-q', '-am', 'lock'); const lock = sh('rev-parse', 'HEAD');
    assert.equal(depsChangedSince(git, base, lock), true);
    assert.equal(depsChangedSince(git, code, lock), true);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('main() skips the base run when deps changed, so red gates count as new', () => {
  const src = fs.readFileSync(new URL('./land-local-check.js', import.meta.url), 'utf8');
  assert.match(src, /const depsChanged = red && depsChangedSince\(git, base, head\);/);
  assert.match(src, /if \(red && !depsChanged\) \{[\s\S]*?withBaseWorktree\(/, 'the base worktree run is gated on !depsChanged');
});
