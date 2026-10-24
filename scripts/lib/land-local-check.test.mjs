import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs, { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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

for (const branch of ['codex/test-branch', '']) {
  test(`base comparison copies the helper and restores ${branch ? 'the starting branch' : 'a detached HEAD'}`, (t) => {
    const head = 'a'.repeat(40);
    const base = 'b'.repeat(40);
    const checkouts = [];
    const messages = [];
    let compared = false;
    t.mock.method(console, 'log', (message) => messages.push(message));
    t.mock.method(R, 'withFileMutex', (_lock, fn) => fn());
    const exists = fs.existsSync;
    t.mock.method(fs, 'existsSync', (p) => /data\/(shows|reviews|cast-manifest|actor-slugs)\.json$/.test(String(p)) || exists(p));
    const checker = checkerWithRunner(t, (cmd, args) => {
      const result = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (cmd === 'git') {
        switch (args[0]) {
          case 'status': case 'fetch': return result();
          case 'rev-parse': return result(head);
          case 'symbolic-ref': return { ...result(branch), status: branch ? 0 : 1 };
          case 'merge-base': return result(base);
          case 'rev-list': return result('0');
          case 'checkout': checkouts.push(args); return result();
        }
      }
      if (cmd === 'bash' && args[0] === 'scripts/lib/land-gauntlet.sh') {
        fs.mkdirSync(args[1], { recursive: true });
        fs.writeFileSync(join(args[1], 'meta.json'), '{}');
        t.after(() => rmSync(join(args[1], '..'), { recursive: true, force: true }));
        return result();
      }
      if (cmd === 'bash') {
        compared = true;
        assert.deepEqual(args.slice(2), ['--checkout', base, '--return-to', head]);
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
    assert.deepEqual(checkouts, branch ? [['checkout', '-q', branch]] : []);
    assert.ok(messages.some((message) => message.includes('CLEAN, no new failures')));
  });
}

test('main exits 3 (not ready) when core data is missing, before any gate runs', () => {
  const src = require('fs').readFileSync(new URL('./land-local-check.js', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('function main('));
  assert.ok(main.indexOf('missingCoreData(ROOT)') > 0 && main.indexOf('missingCoreData(ROOT)') < main.indexOf('mkdtempSync'));
});
