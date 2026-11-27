import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs, { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { parseArgs, newFailureFiles, DEFAULT_GATES, LOCAL_SKIPPED_GATES } = require('./land-local-check.js');
const { GATES, ADVISORY_GATES } = require('./land-gate-delta.js');
const R = require('./codex-runner.js');

test('BRO-7652: stale runs remove registered base worktrees and logs, preserving recent and unrelated paths', (t) => {
  const { cleanupStaleRuns } = require('./land-local-check.js');
  const scratch = mkdtempSync(join(tmpdir(), 'llc-cleanup-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(scratch, 'repo');
  const temp = join(scratch, 'tmp');
  fs.mkdirSync(root); fs.mkdirSync(temp);
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q'); g('config', 'user.name', 'test'); g('config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'tracked'), 'base'); g('add', '.'); g('commit', '-qm', 'base');
  const now = Date.now();
  const old = new Date(now - 3 * 3600_000);
  const stale = join(temp, 'land-local-check-aaaaaaaaaa-ABC123');
  const logs = join(temp, 'land-local-check-bbbbbbbbbb-DEF456');
  const fresh = join(temp, 'land-local-check-cccccccccc-GHI789');
  const locked = join(temp, 'land-local-check-eeeeeeeeee-MNO456');
  const unrelated = join(temp, 'unrelated');
  for (const dir of [stale, logs, fresh, locked, unrelated]) fs.mkdirSync(dir);
  g('worktree', 'add', '--detach', join(stale, 'basewt'), 'HEAD');
  g('worktree', 'add', '--detach', join(locked, 'basewt'), 'HEAD');
  g('worktree', 'lock', join(locked, 'basewt'));
  fs.symlinkSync(root, join(stale, 'basewt', 'private-data'));
  writeFileSync(join(logs, 'head.log'), 'diagnostics');
  for (const dir of [stale, logs, locked, unrelated]) fs.utimesSync(dir, old, old);
  const link = join(temp, 'land-local-check-dddddddddd-JKL123');
  fs.symlinkSync(unrelated, link);
  assert.deepEqual(cleanupStaleRuns(root, temp, now).sort(), [stale, logs].sort());
  for (const dir of [stale, logs]) assert.ok(!existsSync(dir), dir);
  for (const dir of [fresh, locked, unrelated, link, join(root, 'tracked')]) assert.ok(existsSync(dir), dir);
  assert.ok(!g('worktree', 'list', '--porcelain').includes(stale), 'registration removed before pruning');
  assert.deepEqual(cleanupStaleRuns(root, temp, now), [], 'repeat cleanup is harmless');
});

test('BRO-7652: staleRunDecision keeps live runs at any age, reclaims a dead run\'s checkout at any age', () => {
  const { staleRunDecision } = require('./land-local-check.js');
  const name = 'land-local-check-aaaaaaaaaa-ABC123';
  const h = 3600_000;
  const d = (o) => staleRunDecision({ name, isDirectory: true, ageMs: 0, hasBaseWorktree: false, hasLiveProcess: false, ...o });
  assert.equal(d({ name: 'unrelated' }), 'skip');
  assert.equal(d({ isDirectory: false, ageMs: 3 * h }), 'skip', 'a link or file is never followed');
  assert.equal(d({ ageMs: 3 * h }), 'remove', 'old logs go (the 2h rule)');
  assert.equal(d({ ageMs: h }), 'keep', 'recent logs stay for diagnosis');
  assert.equal(d({ ageMs: h, hasBaseWorktree: true }), 'remove', 'a dead run\'s fresh checkout goes before the disk guard');
  assert.equal(d({ ageMs: h, hasBaseWorktree: true, hasLiveProcess: true }), 'keep', 'a process inside: live');
  assert.equal(d({ ageMs: 3 * h, hasBaseWorktree: true, hasLiveProcess: true }), 'keep', 'live at every age');
  assert.equal(d({ ageMs: 3 * h, hasLiveProcess: true }), 'keep');
  assert.equal(d({ ageMs: h, hasBaseWorktree: true, hasLiveProcess: 'unknown' }), 'keep', 'no /proc: fall back to the age rule');
  assert.equal(d({ ageMs: 3 * h, hasBaseWorktree: true, hasLiveProcess: 'unknown' }), 'remove');
  assert.equal(d({ ageMs: 1.5 * h, hasBaseWorktree: true }), 'remove');
  assert.equal(staleRunDecision({ name, isDirectory: true, ageMs: 10, hasLiveProcess: false }, { maxAgeMs: 5 }), 'remove');
});

test('BRO-7652: processCwds ignores exited pids, reports unreadable ones and a missing /proc as unknown', (t) => {
  const { processCwds, liveProcessIn, parseWorktreeList } = require('./land-local-check.js');
  const scratch = mkdtempSync(join(tmpdir(), 'llc-proc-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const proc = join(scratch, 'proc');
  const runDir = join(scratch, 'land-local-check-aaaaaaaaaa-ABC123');
  fs.mkdirSync(join(runDir, 'basewt'), { recursive: true });
  for (const pid of ['1', '2']) fs.mkdirSync(join(proc, pid), { recursive: true });
  fs.mkdirSync(join(proc, 'self'));
  fs.symlinkSync(join(runDir, 'basewt'), join(proc, '1', 'cwd'));
  // pid 2 has no cwd entry: exited between readdir and readlink (ENOENT)
  const scan = processCwds(proc);
  assert.equal(scan.unknown, false);
  assert.equal(liveProcessIn(runDir, scan), true);
  assert.equal(liveProcessIn(runDir + '-sibling', scan), false, 'a prefix-sharing sibling is not inside');
  assert.equal(liveProcessIn(runDir, processCwds(join(scratch, 'none'))), 'unknown');
  const readlink = fs.readlinkSync;
  t.mock.method(fs, 'readlinkSync', (p) => {
    if (String(p) === join(proc, '2', 'cwd')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return readlink(p);
  });
  assert.equal(liveProcessIn(join(scratch, 'elsewhere'), processCwds(proc)), 'unknown', 'EACCES: possibly live');
  const wts = parseWorktreeList(`worktree ${scratch}\nHEAD abc\nbranch refs/heads/x\n\nworktree ${join(runDir, 'basewt')}\nHEAD abc\ndetached\nlocked\n`);
  assert.deepEqual(wts.get(fs.realpathSync(join(runDir, 'basewt'))), { locked: true });
  assert.deepEqual(wts.get(fs.realpathSync(scratch)), { locked: false });
});

test('BRO-7652: a recent dead run\'s registered base worktree is reclaimed; locked, linked or live ones are not', (t) => {
  const { cleanupStaleRuns } = require('./land-local-check.js');
  const scratch = fs.realpathSync(mkdtempSync(join(tmpdir(), 'llc-fresh-')));
  const children = [];
  t.after(() => { for (const c of children) c.kill('SIGKILL'); rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const root = join(scratch, 'repo');
  const temp = join(scratch, 'tmp');
  const noProcs = join(scratch, 'proc');
  fs.mkdirSync(root); fs.mkdirSync(temp); fs.mkdirSync(noProcs);
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q'); g('config', 'user.name', 'test'); g('config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'tracked'), 'base'); g('add', '.'); g('commit', '-qm', 'base');
  const dead = join(temp, 'land-local-check-aaaaaaaaaa-ABC123');
  const locked = join(temp, 'land-local-check-bbbbbbbbbb-DEF456');
  const linked = join(temp, 'land-local-check-cccccccccc-GHI789');
  const unregistered = join(temp, 'land-local-check-dddddddddd-JKL012');
  for (const dir of [dead, locked, linked, unregistered]) fs.mkdirSync(dir);
  g('worktree', 'add', '--detach', join(dead, 'basewt'), 'HEAD');
  g('worktree', 'add', '--detach', join(locked, 'basewt'), 'HEAD');
  g('worktree', 'lock', join(locked, 'basewt'));
  fs.symlinkSync(join(locked, 'basewt'), join(linked, 'basewt'));
  fs.mkdirSync(join(unregistered, 'basewt'));
  const now = Date.now();
  assert.deepEqual(cleanupStaleRuns(root, temp, now, { procDir: join(scratch, 'no-proc') }), [], 'no /proc: recent dirs fall back to the 2h rule');
  assert.deepEqual(cleanupStaleRuns(root, temp, now, { procDir: noProcs }), [dead]);
  assert.ok(!existsSync(dead));
  assert.ok(!g('worktree', 'list', '--porcelain').includes(dead), 'registration removed');
  for (const dir of [locked, join(locked, 'basewt', 'tracked'), linked, unregistered]) assert.ok(existsSync(dir), dir);

  if (!existsSync('/proc')) { t.diagnostic('no /proc: live-cwd case skipped'); return; }
  const live = join(temp, 'land-local-check-eeeeeeeeee-MNO345');
  fs.mkdirSync(live);
  g('worktree', 'add', '--detach', join(live, 'basewt'), 'HEAD');
  const child = spawn('sleep', ['60'], { cwd: join(live, 'basewt'), stdio: 'ignore' });
  children.push(child);
  const old = new Date(now - 3 * 3600_000);
  fs.utimesSync(live, old, old);
  assert.ok(!cleanupStaleRuns(root, temp, now).includes(live), 'a process working in the checkout keeps it, even when old');
  assert.ok(existsSync(join(live, 'basewt', 'tracked')));
});

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
  let baseScope;
  let held = false;
  let swept = false;
  let sweepHeld = false;
  let earlyDiskChecks = 0;
  t.mock.method(console, 'log', (message) => messages.push(message));
  t.mock.method(R, 'withFileMutex', (_lock, fn) => {
    held = true;
    try { return fn(); } finally { held = false; }
  });
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, opts) => {
    if (dir === tmpdir()) { swept = true; sweepHeld = held; return []; }
    return readdir(dir, opts);
  });
  t.mock.method(fs, 'statfsSync', () => {
    if (!swept) earlyDiskChecks++;
    return { bavail: 10 * 1024 ** 3, bsize: 1 };
  });
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => /data\/(shows|reviews|cast-manifest|actor-slugs)\.json$|\/node_modules$|\/node_modules\/.+\/package\.json$/.test(String(p)) || exists(p));
  const checker = checkerWithRunner(t, (cmd, args, opts) => {
    const result = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (cmd === 'pgrep') return result();
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
      fs.writeFileSync(join(args[1], 'tsc.exit'), '1');
      fs.writeFileSync(join(args[1], 'tsc.log'), "src/example.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.\n");
      fs.writeFileSync(join(args[1], 'unit-tests-node.exit'), '1');
      fs.writeFileSync(join(args[1], 'unit-tests-node.log'), 'TAP version 13\n# Subtest: staged output regression\nnot ok 1 - staged output regression\n  ---\n  location: \'tests/unit/example.test.mjs:3:1\'\n  failureType: \'testCodeFailure\'\n  ...\n');
      fs.writeFileSync(join(args[1], 'unit-tests-node.files'), 'tests/unit/example.test.mjs\ntests/unit/green.test.mjs\n');
      t.after(() => rmSync(join(args[1], '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      return result();
    }
    if (cmd === 'bash') {
      compared = true;
      messages.push('base run started');
      assert.equal(args.length, 2, 'no --checkout/--return-to: the tree under test is already the base');
      assert.match(opts.cwd, /basewt$/, 'the base gates run inside the throwaway worktree');
      baseScope = opts.env.GAUNTLET_SCOPE_DIR;
      for (const name of ['land-gauntlet.sh', 'tsc-node-options.sh']) {
        assert.equal(fs.readFileSync(join(args[0], '..', name), 'utf8'),
          fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
      }
      return result();
    }
    if (cmd === 'node' && args[1] === '--red-gates') return result('tsc,unit-tests-node');
    if (cmd === 'node' && args[1] === '--rerun-scope') return spawnSync(cmd, args, opts);
    if (cmd === 'node' && args[1] === '--base-dir') return result('no new failures');
    assert.fail(`unexpected command: ${cmd} ${args.join(' ')}`);
  });
  assert.equal(checker.main(['--gates', 'tsc,unit-tests-node']), 0);
  assert.ok(swept && sweepHeld, 'cleanup runs under the mutex, preserving any active run');
  assert.equal(earlyDiskChecks, 0, 'reclaim disk before refusing for low space');
  assert.ok(compared, 'the red gate was compared against the base');
  assert.ok(baseScope, 'BRO-7652: base rechecks only failing test files');
  assert.equal(fs.readFileSync(join(baseScope, 'unit-tests-node.files'), 'utf8'), 'tests/unit/example.test.mjs\n');
  assert.ok(!existsSync(join(baseScope, 'tsc.files')), 'non-test gates still run in full');
  const beforeBase = messages.slice(0, messages.indexOf('base run started'));
  assert.ok(beforeBase.some((m) => /tsc.*tsc\.log/.test(m)), 'print the gate log path before the base run');
  assert.ok(beforeBase.some((m) => m.includes('src/example.ts') && m.includes('TS2322')), 'print the tsc finding before the base run');
  assert.ok(beforeBase.some((m) => /unit-tests-node.*unit-tests-node\.log/.test(m)), 'print the test gate log path');
  assert.ok(beforeBase.some((m) => m.includes('staged output regression')), 'print failing test names before the base run');
  assert.equal(gitCalls.filter((a) => a[0] === 'checkout').length, 0, 'this checkout is never switched');
  const add = gitCalls.find((a) => a[0] === 'worktree' && a[1] === 'add');
  assert.deepEqual([add[2], add[add.length - 1]], ['--detach', base]);
  assert.ok(gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'remove'), 'the worktree is removed afterwards');
  assert.ok(messages.some((message) => message.includes('CLEAN, no new failures')));
});

test('pre-commit warns for staged prebuild outputs without generator changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'prebuild-warning-'));
  const repo = new URL('../..', import.meta.url).pathname;
  const sh = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    sh('init', '-q');
    fs.mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    const helper = join(repo, 'scripts/lib/prebuild-outputs.js');
    if (existsSync(helper)) fs.copyFileSync(helper, join(root, 'scripts/lib/prebuild-outputs.js'));
    const stage = (file) => {
      fs.mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '{}\n');
      sh('add', '--', file);
    };
    const hook = () => {
      const r = spawnSync('bash', [join(repo, 'scripts/hooks/pre-commit')], { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout + r.stderr;
    };
    for (const file of ['data/gold-lists-computed.json', 'public/data/mobile-shows.json', 'src/config/outlet-logos-generated.json']) {
      sh('read-tree', '--empty');
      stage(file);
      const output = hook();
      assert.match(output, /WARNING: staged prebuild outputs/);
      assert.ok(output.includes(file), file);
    }
    stage('docs/example.md');
    assert.match(hook(), /WARNING: staged prebuild outputs/, 'docs do not suppress the warning');
    stage('scripts/generate-mobile-data.js');
    assert.doesNotMatch(hook(), /WARNING: staged prebuild outputs/, 'generator change explains the output');
    sh('read-tree', '--empty');
    stage('public/data/research/example.json');
    assert.doesNotMatch(hook(), /WARNING: staged prebuild outputs/, 'unrelated datasets are not prebuild output');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
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

test('BRO-7110: a checkout with no node_modules of its own is not ready, checked before any gate runs', () => {
  const { hasOwnNodeModules } = require('./land-local-check.js');
  assert.equal(hasOwnNodeModules('/r', (p) => p === '/r/node_modules'), true);
  assert.equal(hasOwnNodeModules('/r', () => false), false, 'a parent checkout\'s node_modules does not count');
  const src = require('fs').readFileSync(new URL('./land-local-check.js', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('function main('));
  const at = main.indexOf('hasOwnNodeModules(ROOT)');
  assert.ok(at > 0 && at < main.indexOf('mkdtempSync'), 'checked before the base copy is built');
  assert.match(main.slice(at, at + 600), /return 3;/);
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

test('BRO-7110: restorePrebuildResidue puts back regenerated prebuild outputs only', () => {
  const { restorePrebuildResidue } = require('./land-local-check.js');
  const calls = [];
  const git = (...a) => { calls.push(a); return { stdout: a[0] === 'diff' ? 'data/gold-lists-computed.json\nscripts/x.js\npublic/data/mobile-shows.json\n' : '' }; };
  assert.deepEqual(restorePrebuildResidue('/r', git), ['data/gold-lists-computed.json', 'public/data/mobile-shows.json']);
  assert.deepEqual(calls[1], ['checkout', '--', 'data/gold-lists-computed.json', 'public/data/mobile-shows.json'], 'a real edit (scripts/x.js) is never touched');
  const quiet = [];
  assert.deepEqual(restorePrebuildResidue('/r', (...a) => { quiet.push(a); return { stdout: '' }; }), []);
  assert.equal(quiet.length, 1, 'nothing to restore: no checkout');
  const src = fs.readFileSync(new URL('./land-local-check.js', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('function main('));
  assert.ok(main.indexOf('restorePrebuildResidue(ROOT)') > main.indexOf("'scripts/lib/land-gauntlet.sh', branchDir"), 'restored right after the branch run');
});

test('BRO-7110: the node_modules remedy links a worktree to the main checkout, and installs in the main checkout itself', () => {
  const { nodeModulesRemedy } = require('./land-local-check.js');
  assert.equal(nodeModulesRemedy('/repo/.claude/worktrees/x', '/repo/.git'), 'Link them first: ln -sfn /repo/node_modules node_modules');
  assert.equal(nodeModulesRemedy('/repo', '.git'), 'Install them first: npm ci');
  assert.equal(nodeModulesRemedy('/repo', ''), 'Install them first: npm ci');
});

test('BRO-7110: a tree dirty only with prebuild outputs names them and the restore command', () => {
  const { dirtyTreeMessage } = require('./land-local-check.js');
  const onlyGenerated = dirtyTreeMessage(' M data/gold-lists-computed.json\n');
  assert.match(onlyGenerated, /commit or discard tracked changes first/);
  assert.match(onlyGenerated, /git checkout HEAD -- data\/gold-lists-computed\.json$/, 'HEAD: a staged output goes back too');
  const many = Array.from({ length: 40 }, (_, i) => ` M public/data/shows/show-${i}.json`).join('\n');
  assert.match(dirtyTreeMessage(many), /\(40 file\(s\).*git checkout HEAD -- public\/data\/shows$/, 'many files: their directory, one line');
  assert.match(dirtyTreeMessage('M data/gold-lists-computed.json'), /git checkout HEAD -- data\/gold-lists-computed\.json$/, 'trimmed status, as run() returns it');
  const mixed = dirtyTreeMessage(' M data/gold-lists-computed.json\n M scripts/foo.js\n');
  assert.doesNotMatch(mixed, /git checkout HEAD --/, 'a real edit in the mix gets no discard hint');
});

test('BRO-7110: declared packages are checked against the install owner (a worktree link resolves to main)', () => {
  const { missingDeclaredPackages } = require('./declared-packages.js');
  const present = new Set(['/main/node_modules/next/package.json', '/main/node_modules/@types/node/package.json']);
  const reads = [];
  const readPkg = (dir) => { reads.push(dir); return { dependencies: { next: '1' }, devDependencies: { '@types/node': '1', acorn: '8' } }; };
  assert.deepEqual(missingDeclaredPackages('/wt', { owner: '/main', exists: (p) => present.has(p), readPkg }), { owner: '/main', missing: ['acorn'] });
  assert.deepEqual(reads, ['/main'], "the owner's package.json, which its npm ci installs");
  assert.deepEqual(missingDeclaredPackages('/wt', { owner: '/main', exists: () => true, readPkg }).missing, []);
  assert.deepEqual(missingDeclaredPackages('/wt', { owner: null, exists: () => false, readPkg }), { owner: null, missing: [] }, 'no node_modules: nothing to judge');
  assert.deepEqual(missingDeclaredPackages('/wt', { owner: '/main', exists: () => false, readPkg: () => { throw new Error('none'); } }).missing, [], 'unreadable package.json: no opinion');
});

test('BRO-7110: main() refuses an incomplete install before fetching or running any gate', (t) => {
  const { missingDeclaredPackages } = require('./declared-packages.js');
  const real = missingDeclaredPackages(decodeURIComponent(new URL('../..', import.meta.url).pathname));
  // A checkout with no node_modules anywhere up the tree (a fresh worktree) has no install to break.
  if (!real.owner) { t.skip('no node_modules install above this checkout'); return; }
  const declared = Object.keys(JSON.parse(fs.readFileSync(join(real.owner, 'package.json'), 'utf8')).devDependencies || {});
  const gone = declared[0];
  const errors = [];
  t.mock.method(console, 'error', (m) => errors.push(String(m)));
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => {
    const s = String(p);
    if (s.endsWith(`/node_modules/${gone}/package.json`)) return false;
    return /data\/(shows|reviews|cast-manifest|actor-slugs)\.json$|\/node_modules$|\/node_modules\/.+\/package\.json$/.test(s) || exists(p);
  });
  const gitCalls = [];
  const checker = checkerWithRunner(t, (cmd, args) => {
    if (cmd === 'git') { gitCalls.push(args[0]); return { status: 0, stdout: args[0] === 'rev-parse' ? '.git' : '', stderr: '' }; }
    assert.fail(`no command may run before the install check: ${cmd} ${args.join(' ')}`);
  });
  assert.equal(checker.main([]), 3);
  assert.ok(errors.some((m) => m.includes('node_modules is incomplete') && m.includes(gone) && m.includes('npm ci')), errors.join('\n'));
  assert.ok(!gitCalls.includes('fetch'), 'refused before git fetch');
});

// BRO-7186: false results from land tooling
const { lowDiskMessage, looksLikeEnvFailure, landedOnMain, envFailureLogs, MIN_FREE_BYTES } = require('./land-check-resources.js');

test('BRO-7186: under 4 GB free refuses; enough or unreadable does not', () => {
  assert.match(lowDiskMessage(1024 ** 3), /1\.0 GB free before the run.*ENOSPC/s);
  assert.equal(lowDiskMessage(MIN_FREE_BYTES), null);
  assert.equal(lowDiskMessage(NaN), null);
  assert.match(lowDiskMessage(0, { when: 'after the run' }), /after the run/);
});

test('BRO-7186: ENOSPC output is an environment failure', () => {
  assert.ok(looksLikeEnvFailure('Error: ENOSPC: no space left on device, write'));
  assert.ok(!looksLikeEnvFailure('AssertionError: expected 1'));
});

test('BRO-7315: a test NAMED after ENOSPC is not a disk failure; the same error in a test body still is', () => {
  // The four real title pairs that made every run "not a valid verdict" (unit-tests-node.log, scripts-lib-tests.log).
  const titles = [
    '# Subtest: isDiskFailure: the system message counts on its own, a bare ENOSPC only while the disk is low',
    'ok 7238 - isDiskFailure: the system message counts on its own, a bare ENOSPC only while the disk is low',
    '    # Subtest: BRO-7186: ENOSPC output is an environment failure',
    '    not ok 7403 - BRO-7186: ENOSPC output is an environment failure',
  ].join('\n');
  assert.ok(!looksLikeEnvFailure(titles));
  assert.ok(looksLikeEnvFailure(`${titles}\n  ---\n  error: "ENOSPC: no space left on device, write"\n  ...`));
  assert.ok(looksLikeEnvFailure('not ok 3 - writes the ledger\n  stack: |-\n    Error: ENOSPC\n'));
  const d = mkdtempSync(join(tmpdir(), 'enospc-title-'));
  writeFileSync(join(d, 'unit-tests-node.log'), `${titles}\n`);
  assert.deepEqual(envFailureLogs([d]), []);
  rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('BRO-7186: a gone ref counts as landed only via an exact-branch recent ledger row and no red run', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600_000).toISOString();
  const ref = 'land/bro-7137-fallback-date';
  const row = { branch: ref, sha: 'abc', tip: 't1', ts: ago(1) };
  assert.deepEqual(landedOnMain({ ref, nowMs: now, ledgerRows: [row] }), { landed: true, sha: 'abc', tip: 't1', via: 'landings ledger' });
  assert.equal(landedOnMain({ ref, nowMs: now, ledgerRows: [{ ...row, ts: ago(9) }] }).landed, false);
  assert.equal(landedOnMain({ ref, nowMs: now, ledgerRows: [{ ...row, ts: undefined }] }).landed, false);
  assert.equal(landedOnMain({ ref: 'land/other', nowMs: now, ledgerRows: [row] }).landed, false);
  assert.equal(landedOnMain({ ref, nowMs: now, ledgerRows: [row], run: { conclusion: 'failure' } }).landed, false);
  assert.equal(landedOnMain({ ref, nowMs: now, ledgerRows: [row], run: { conclusion: 'success' } }).landed, true);
  // BRO-7324: a red run whose Land job succeeded (only an advisory job red) landed, when its jobs are known.
  const landOk = { name: 'Land', conclusion: 'success' };
  const shardRed = { name: 'Checks (shard 2/2)', conclusion: 'failure' };
  for (const conclusion of ['failure', 'cancelled']) {
    assert.deepEqual(landedOnMain({ ref, nowMs: now, ledgerRows: [row], run: { conclusion, jobs: [landOk, shardRed] } }), { landed: true, sha: 'abc', tip: 't1', via: 'landings ledger' });
    // Land itself red, or jobs unknown: still refused, never landed.
    assert.equal(landedOnMain({ ref, nowMs: now, ledgerRows: [row], run: { conclusion, jobs: [{ ...landOk, conclusion: 'failure' }, shardRed] } }).landed, false);
    assert.equal(landedOnMain({ ref, nowMs: now, ledgerRows: [row], run: { conclusion, jobs: null } }).landed, false);
    assert.equal(landedOnMain({ ref, nowMs: now, ledgerRows: [row], run: { conclusion } }).landed, false);
    // Land succeeded but no ledger row: not landed (the ledger is still the proof).
    assert.equal(landedOnMain({ ref, nowMs: now, ledgerRows: [], run: { conclusion, jobs: [landOk, shardRed] } }).landed, false);
  }
});

test('BRO-7186: envFailureLogs finds ENOSPC in raw gate logs, not in clean ones', () => {
  const d = mkdtempSync(join(tmpdir(), 'enospc-'));
  writeFileSync(join(d, 'a.log'), 'ok 1\n'); writeFileSync(join(d, 'b.log'), 'Error: ENOSPC: no space left');
  const hits = envFailureLogs([d, join(d, 'missing')]);
  assert.deepEqual(hits, [join(d, 'b.log')]);
  rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('BRO-7186: parseMainLog reads git log rows', () => {
  const { parseMainLog } = require('./land-check-resources.js');
  assert.deepEqual(parseMainLog('abc\t2026-11-08T00:00:00Z\tfix(BRO-1): a\tb\n\n'), [{ sha: 'abc', ts: '2026-11-08T00:00:00Z', subject: 'fix(BRO-1): a\tb' }]);
});

test('BRO-7431: a stale .next/dev/types is removed before the gates run; a live next dev is reported', () => {
  const { clearStaleDevTypes } = require('./land-local-check.js');
  const root = mkdtempSync(join(tmpdir(), 'lcc-devtypes-'));
  try {
    fs.mkdirSync(join(root, '.next', 'dev', 'types'), { recursive: true });
    writeFileSync(join(root, '.next', 'dev', 'types', 'routes.d.ts'), '');
    fs.mkdirSync(join(root, '.next', 'types'), { recursive: true });
    const r = clearStaleDevTypes(root, { pgrep: () => '123\n' });
    assert.deepEqual(r, { removed: true, devAlive: true });
    assert.equal(existsSync(join(root, '.next', 'dev')), false, 'stale dev types gone');
    assert.equal(existsSync(join(root, '.next', 'types')), true, 'production types untouched');
    assert.deepEqual(clearStaleDevTypes(root, { pgrep: () => '' }), { removed: false, devAlive: false });
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  const src = fs.readFileSync(new URL('./land-local-check.js', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('function main('));
  assert.ok(main.indexOf('clearStaleDevTypes(ROOT)') > 0 && main.indexOf('clearStaleDevTypes(ROOT)') < main.indexOf('land-gauntlet.sh'), 'cleared before the gauntlet');
});

// ── BRO-7752: alone vs alone, so a timing failure no longer forces a full base gate ──
const tapOf = (failures, total = failures.length + 1) => ['TAP version 13',
  ...failures.flatMap(([file, name, type = 'testCodeFailure'], i) => [`not ok ${i + 1} - ${name}`, '  ---', `  location: '${file}:3:1'`, `  failureType: '${type}'`, '  ...']),
  `ok ${total} - passes`, `# tests ${total}`, `# fail ${failures.length}`, ''].join('\n');

function gateDir(dir, gate, { exit, log, files }) {
  fs.mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'meta.json'))) writeFileSync(join(dir, 'meta.json'), '{}');
  writeFileSync(join(dir, `${gate}.exit`), String(exit));
  writeFileSync(join(dir, `${gate}.log`), log);
  if (files) writeFileSync(join(dir, `${gate}.files`), files.join('\n') + '\n');
}

const BATCH_FILES = ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs', 'tests/unit/c.test.mjs'];
const BATCH_LOG = tapOf([['tests/unit/a.test.mjs', 'slow under load', 'testTimeoutFailure'], ['tests/unit/b.test.mjs', 'red on main too']]);

test('BRO-7752: isolatedRecheckPlan scopes a finished batch with a timing failure; not a killed batch, a tsx gate or too many files', (t) => {
  const { isolatedRecheckPlan, aloneRunFinished } = require('./land-local-check.js');
  const dir = mkdtempSync(join(tmpdir(), 'llc-iso-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  gateDir(dir, 'unit-tests-node', { exit: 1, log: BATCH_LOG, files: BATCH_FILES });
  gateDir(dir, 'unit-tests-tsx', { exit: 1, log: BATCH_LOG, files: BATCH_FILES });
  assert.deepEqual(isolatedRecheckPlan(['unit-tests-node', 'unit-tests-tsx', 'tsc'], dir),
    [{ gate: 'unit-tests-node', files: ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs'] }]);
  assert.deepEqual(isolatedRecheckPlan(['unit-tests-node'], dir, { maxFiles: 1 }), [], 'over the cap: keep the batch path');
  gateDir(dir, 'scripts-lib-tests', { exit: 1, log: BATCH_LOG.replace(/# tests \d+\n/, ''), files: BATCH_FILES });
  assert.deepEqual(isolatedRecheckPlan(['scripts-lib-tests'], dir), [], 'a batch cut short never ran the rest');
  assert.equal(aloneRunFinished({ exit: 1, text: tapOf([['x.test.mjs', 'y']]) }), true);
  assert.equal(aloneRunFinished({ exit: 0, text: tapOf([]) }), true);
  assert.equal(aloneRunFinished({ exit: 1, text: 'killed' }), false);
  assert.equal(aloneRunFinished({ exit: 143, text: tapOf([]) }), false);
  assert.equal(aloneRunFinished(null), false);
});

function runMainWithAlone(t, aloneLog, baseLog = tapOf([['tests/unit/b.test.mjs', 'red on main too']], 2)) {
  const seen = { aloneEnv: null, baseScope: undefined, baseRan: false };
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(R, 'withFileMutex', (_lock, fn) => fn());
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, opts) => (dir === tmpdir() ? [] : readdir(dir, opts)));
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 10 * 1024 ** 3, bsize: 1 }));
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => /data\/(shows|reviews|cast-manifest|actor-slugs)\.json$|\/node_modules$|\/node_modules\/.+\/package\.json$/.test(String(p)) || exists(p));
  const checker = checkerWithRunner(t, (cmd, args, opts) => {
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (cmd === 'pgrep') return ok();
    if (cmd === 'git') return ok({ 'rev-parse': 'a'.repeat(40), 'merge-base': 'b'.repeat(40), 'rev-list': '0' }[args[0]] || '');
    if (cmd === 'bash' && args[0] === 'scripts/lib/land-gauntlet.sh' && /branch$/.test(args[1])) {
      t.after(() => rmSync(join(args[1], '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      seen.branchDir = args[1];
      gateDir(args[1], 'unit-tests-node', { exit: 1, log: BATCH_LOG, files: BATCH_FILES });
      return ok();
    }
    if (cmd === 'bash' && args[0] === 'scripts/lib/land-gauntlet.sh' && /branch-alone$/.test(args[1])) {
      seen.aloneEnv = { ...opts.env, scopeFiles: readFileSafe(join(opts.env.GAUNTLET_SCOPE_DIR, 'unit-tests-node.files')) };
      gateDir(args[1], 'unit-tests-node', { exit: /^not ok/m.test(aloneLog) ? 1 : 0, log: aloneLog });
      return ok();
    }
    if (cmd === 'bash') {
      seen.baseRan = true;
      seen.baseScope = opts.env.GAUNTLET_SCOPE_DIR ? readFileSafe(join(opts.env.GAUNTLET_SCOPE_DIR, 'unit-tests-node.files')) : null;
      gateDir(args[1], 'unit-tests-node', { exit: /^not ok/m.test(baseLog) ? 1 : 0, log: baseLog });
      return ok();
    }
    if (cmd === 'node' && args[0] === 'scripts/lib/land-gate-delta.js') return spawnSync(cmd, args, opts);
    if (cmd === 'node' && args[0] === '--test') return { status: 1, stdout: '', stderr: '' }; // the post-delta re-run: still failing
    assert.fail(`unexpected command: ${cmd} ${args.join(' ')}`);
  });
  seen.code = checker.main(['--gates', 'unit-tests-node']);
  return seen;
}
const readFileSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

test('BRO-7752: a timing failure re-runs the failing files alone on HEAD and scopes the base to them', (t) => {
  const seen = runMainWithAlone(t, tapOf([['tests/unit/b.test.mjs', 'red on main too']], 2));
  assert.equal(seen.aloneEnv.scopeFiles, 'tests/unit/a.test.mjs\ntests/unit/b.test.mjs\n', 'alone run gets only the failing files');
  assert.equal(seen.aloneEnv.GAUNTLET_GATES, 'unit-tests-node');
  assert.equal(seen.aloneEnv.GAUNTLET_PARALLEL, undefined);
  assert.ok(seen.baseRan);
  assert.equal(seen.baseScope, 'tests/unit/a.test.mjs\ntests/unit/b.test.mjs\n', 'base runs the same files, never the full gate');
  assert.equal(seen.code, 0, 'b fails alone on both sides: pre-existing');
  assert.equal(fs.readFileSync(join(seen.branchDir, 'unit-tests-node.batch.log'), 'utf8'), BATCH_LOG, 'the batch log is kept');
  assert.match(fs.readFileSync(join(seen.branchDir, 'unit-tests-node.log'), 'utf8'), /^# tests 2$/m, 'the alone result is the verdict');
});

test('BRO-7752: a failure still red alone and green on base is new', (t) => {
  const seen = runMainWithAlone(t, tapOf([['tests/unit/b.test.mjs', 'red on main too']], 2), tapOf([], 2));
  assert.equal(seen.code, 1);
  assert.ok(seen.aloneEnv, 'BRO-7752: the failing files re-ran alone on HEAD (fails if the isolated re-run is reverted)');
  assert.equal(seen.aloneEnv.scopeFiles, 'tests/unit/a.test.mjs\ntests/unit/b.test.mjs\n');
  assert.equal(seen.baseScope, 'tests/unit/a.test.mjs\ntests/unit/b.test.mjs\n', 'base re-runs only the failing files');
});

test('BRO-7752: failing files that all pass alone need no base run', (t) => {
  const seen = runMainWithAlone(t, tapOf([], 2));
  assert.equal(seen.baseRan, false);
  assert.equal(seen.code, 0);
});

test('BRO-7752: an alone run that did not finish keeps the batch verdict and its full base', (t) => {
  const seen = runMainWithAlone(t, 'TAP version 13\nnot ok 1 - b\n');
  assert.ok(seen.baseRan);
  assert.equal(seen.baseScope, null, 'the timing failure still forces a full base gate');
});

// BRO-7731: a shallow cloud checkout cut from an older base has no merge-base in its fetched history.
test('BRO-7731: nextHistoryStep deepens a shallow clone in bounded rounds and stops early', () => {
  const { nextHistoryStep, deepenRounds } = require('./land-local-check.js');
  const rounds = deepenRounds();
  assert.deepEqual(rounds.map((r) => r.depth), [200, 1000], 'no promisor remote: no 5000-commit full-blob round');
  assert.ok(rounds.every((r) => !r.args.includes('--filter=blob:none')));
  const partial = deepenRounds({ promisor: true });
  assert.deepEqual(partial.map((r) => r.depth), [200, 1000, 5000]);
  assert.ok(partial.every((r) => r.args.includes('--filter=blob:none') && r.args.at(-1) === 'main'));
  assert.deepEqual(nextHistoryStep({ shallow: true, mergeBase: 'abc', rounds }), { action: 'done' });
  assert.deepEqual(nextHistoryStep({ shallow: false, mergeBase: '', rounds }), { action: 'give-up', reason: 'not-shallow' });
  assert.deepEqual(nextHistoryStep({ shallow: true, mergeBase: '', round: 0, rounds }), { action: 'deepen', round: rounds[0] });
  assert.deepEqual(nextHistoryStep({ shallow: true, mergeBase: '', round: 1, rounds, last: { ok: true, progressed: true } }), { action: 'deepen', round: rounds[1] });
  assert.deepEqual(nextHistoryStep({ shallow: true, mergeBase: '', round: 1, rounds, last: { ok: false, progressed: false } }), { action: 'give-up', reason: 'fetch-failed' });
  assert.deepEqual(nextHistoryStep({ shallow: true, mergeBase: '', round: 1, rounds, last: { ok: true, progressed: false } }), { action: 'give-up', reason: 'no-progress' });
  assert.deepEqual(nextHistoryStep({ shallow: true, mergeBase: '', round: 2, rounds, last: { ok: true, progressed: true } }), { action: 'give-up', reason: 'rounds-exhausted' });
});

test('BRO-7731: the recipe lists SHAs only when a merge-base makes origin/main..HEAD trustworthy', () => {
  const { noCommonHistoryRecipe } = require('./land-local-check.js');
  const none = noCommonHistoryRecipe({ branch: 'claude/x', reason: 'rounds-exhausted', cutOffRoots: ['0123456789abcdef'], commits: ['deadbeef'] });
  assert.match(none, /shares no history with origin\/main/);
  assert.match(none, /cut off at 0123456789/);
  assert.match(none, /git switch -c claude\/x-v2 origin\/main/);
  assert.match(none, /git log --oneline -n 20 claude\/x/);
  assert.doesNotMatch(none, /deadbeef/, 'no merge-base: never print HEAD^origin/main as the commit list');
  const withBase = noCommonHistoryRecipe({ branch: 'claude/x', mergeBase: 'base', commits: ['aaa', 'bbb'] });
  assert.match(withBase, /git cherry-pick aaa bbb/);
  assert.doesNotMatch(withBase, /shares no history/);
  const many = noCommonHistoryRecipe({ branch: 'HEAD', mergeBase: 'base', commits: Array.from({ length: 21 }, (_, i) => `c${i}`) });
  assert.doesNotMatch(many, /git cherry-pick c0/);
  assert.match(many, /my-branch-v2/);
});

function shallowScenario(t, { offMain }) {
  const scratch = mkdtempSync(join(tmpdir(), 'llc-shallow-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const src = join(scratch, 'src');
  fs.mkdirSync(src);
  g(src, 'init', '-q', '-b', 'main');
  const commit = (file, msg) => { writeFileSync(join(src, file), msg); g(src, 'add', file); g(src, 'commit', '-qm', msg); };
  for (let i = 1; i <= 30; i++) commit('f', `c${i}`);
  g(src, 'branch', 'old');
  if (offMain) { g(src, 'switch', '-q', 'old'); for (let i = 1; i <= 3; i++) commit('h', `feat${i}`); g(src, 'switch', '-q', 'main'); }
  for (let i = 31; i <= 60; i++) commit('f', `c${i}`);
  const clone = join(scratch, 'clone');
  g(scratch, 'clone', '-q', '--depth=1', '--branch', 'old', `file://${src}`, clone);
  writeFileSync(join(clone, 'mine'), 'x'); g(clone, 'add', 'mine'); g(clone, 'commit', '-qm', 'mine');
  g(clone, 'fetch', '-q', '--depth=1', 'origin', 'main:refs/remotes/origin/main');
  return { clone, head: g(clone, 'rev-parse', 'HEAD'), g };
}

test('BRO-7731: findMergeBase recovers a real shallow branch cut from an older base, on or off main', (t) => {
  const { findMergeBase, headShallowRoots } = require('./land-local-check.js');
  const rounds = (depths) => depths.map((depth) => ({ depth, args: ['-c', 'protocol.file.allow=always', 'fetch', '-q', `--deepen=${depth}`, 'origin', 'main'] }));
  for (const offMain of [false, true]) {
    const { clone, head, g } = shallowScenario(t, { offMain });
    assert.equal(spawnSync('git', ['merge-base', head, 'origin/main'], { cwd: clone }).status, 1, 'precondition: no merge-base');
    assert.equal(headShallowRoots(head, clone).length, 1, 'HEAD is itself cut off');
    const r = findMergeBase(head, { cwd: clone, rounds: rounds([5, 50]), log: () => {} });
    if (!offMain) {
      assert.ok(r.base, 'on main: merge-base found after deepening');
      assert.equal(r.base, g(clone, 'merge-base', head, 'origin/main'));
      assert.equal(r.deepened, 2);
    } else if (r.base) {
      // Whether --deepen on main also deepens a branch-only shallow root depends on the git
      // version; when it does, the base must be the real one.
      assert.equal(r.base, g(clone, 'merge-base', head, 'origin/main'));
    } else {
      // Otherwise it must give up cleanly (bounded) rather than throw or loop.
      assert.ok(r.reason, 'gave up with a reason after a bounded attempt');
    }
  }
});

test('BRO-7731: findMergeBase gives up after bounded rounds instead of unshallowing', (t) => {
  const { findMergeBase } = require('./land-local-check.js');
  const { clone, head } = shallowScenario(t, { offMain: false });
  const r = findMergeBase(head, { cwd: clone, rounds: [{ depth: 2, args: ['-c', 'protocol.file.allow=always', 'fetch', '-q', '--deepen=2', 'origin', 'main'] }], log: () => {} });
  assert.deepEqual([r.base, r.reason, r.deepened], ['', 'rounds-exhausted', 1]);
  const failed = findMergeBase(head, { cwd: clone, rounds: [{ depth: 2, args: ['fetch', '-q', '--deepen=2', 'no-such-remote', 'main'] }, { depth: 9, args: [] }], log: () => {} });
  assert.deepEqual([failed.reason, failed.deepened], ['fetch-failed', 1], 'a failed fetch stops the rounds');
});

test('BRO-7150: linkIgnored links the ancestor node_modules a job worktree resolves (none of its own)', (t) => {
  const { linkIgnored, resolvedNodeModules } = require('./land-local-check.js');
  const top = fs.realpathSync(mkdtempSync(join(tmpdir(), 'lic-nm-')));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  fs.mkdirSync(join(top, 'node_modules', 'typescript'), { recursive: true });
  const root = join(top, '.claude', 'worktrees', 'job-x');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  assert.equal(resolvedNodeModules(root), join(top, 'node_modules'));
  const dir = mkdtempSync(join(tmpdir(), 'lic-nm-dst-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const made = linkIgnored(root, dir);
  assert.ok(made.includes(join(dir, 'node_modules')), 'node_modules linked');
  assert.equal(fs.realpathSync(join(dir, 'node_modules')), join(top, 'node_modules'));
  assert.ok(existsSync(join(dir, 'node_modules', 'typescript')));
  // a destination that already has node_modules is left alone
  const dir2 = mkdtempSync(join(tmpdir(), 'lic-nm-dst2-'));
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  fs.mkdirSync(join(dir2, 'node_modules'));
  assert.ok(!linkIgnored(root, dir2).includes(join(dir2, 'node_modules')));
});
