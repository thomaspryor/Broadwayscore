// BRO-7324: the node batch's --test-concurrency knob. Runs the REAL functions sliced out of
// land-gauntlet.sh (no copied logic, CLAUDE.md §15) with `node` stubbed to print its argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const gauntlet = fs.readFileSync(new URL('./land-gauntlet.sh', import.meta.url), 'utf8');
const landYml = fs.readFileSync(new URL('../../.github/workflows/land.yml', import.meta.url), 'utf8');

const start = gauntlet.indexOf('node_batch_concurrency() {');
const end = gauntlet.indexOf('\ngate unit-tests-node unit_tests_node');
const FILES = ['tests/unit/a.test.mjs', 'tests/unit/b c.test.mjs', 'tests/unit/c.test.mjs'];

function runNodeGate(env) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-conc-'));
  try {
    const r = spawnSync('bash', ['-c', `
      set -u
      OUT="$1"; SCOPE_DIR=""
      scope_list() { :; }
      unit_tests_node_source() { echo collector; }
      unit_tests_node_list() { printf '%s\\n' ${FILES.map((f) => `'${f}'`).join(' ')}; }
      node() { printf 'ARG:%s\\n' "$@"; }
      ${gauntlet.slice(start, end)}
      unit_tests_node
    `, 'x', out], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    assert.equal(r.status, 0, r.stderr);
    const args = r.stdout.split('\n').filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4));
    return { args, stdout: r.stdout };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test('the slice markers exist (a rename must not silently skip these tests)', () => {
  assert.ok(start > 0, 'node_batch_concurrency() not found in land-gauntlet.sh');
  assert.ok(end > start, 'gate unit-tests-node line not found after node_batch_concurrency');
});

test('GAUNTLET_TEST_CONCURRENCY=6 adds exactly one --test-concurrency=6 and keeps every file once', () => {
  const { args } = runNodeGate({ GAUNTLET_TEST_CONCURRENCY: '6' });
  assert.deepEqual(args, ['--test', '--test-reporter=tap', '--test-timeout', '300000', '--test-concurrency=6', ...FILES]);
});

test('unset, 0, empty or junk -> no flag: the batch runs exactly as before BRO-7324', () => {
  const base = ['--test', '--test-reporter=tap', '--test-timeout', '300000', ...FILES];
  for (const v of [undefined, '', '0', 'abc', '-2', '6; echo pwned', ' 6', '06']) {
    const env = v === undefined ? {} : { GAUNTLET_TEST_CONCURRENCY: v };
    assert.deepEqual(runNodeGate(env).args, base, `value ${JSON.stringify(v)}`);
  }
});

test('the file list is identical with and without the knob (no file dropped or doubled)', () => {
  const on = runNodeGate({ GAUNTLET_TEST_CONCURRENCY: '8' }).args.filter((a) => a.startsWith('tests/'));
  const off = runNodeGate({}).args.filter((a) => a.startsWith('tests/'));
  assert.deepEqual(on, off);
  assert.deepEqual(on, FILES);
});

test('land.yml: every gauntlet step that sets GAUNTLET_PARALLEL also sets the same concurrency (branch and base judged alike)', () => {
  const par = landYml.match(/^\s+GAUNTLET_PARALLEL: .*$/gm) || [];
  const conc = landYml.match(/^\s+GAUNTLET_TEST_CONCURRENCY: .*$/gm) || [];
  assert.ok(par.length >= 3, `expected the branch, base and confirm gauntlet steps, found ${par.length}`);
  assert.equal(conc.length, par.length);
  assert.equal(new Set(conc.map((l) => l.trim())).size, 1, 'all steps must use the same expression');
  assert.match(conc[0], /vars\.LAND_GAUNTLET_TEST_CONCURRENCY \|\| '6'/);
});
