// BRO-2123: lint-workflows must fail when a test.yml diff arms a NEW blocking
// --strict/--gate step without advisory mode, a baseline file or a proof
// annotation. Pure-logic cases + an end-to-end run of the CLI against a
// deliberately-bad fixture commit in a temp git repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { findUnprovenNewGates, parseSteps } = require(path.join(REPO, 'scripts/lib/new-gate-arming.js'));

const wf = (...steps) => `name: t\njobs:\n  a:\n    steps:\n${steps.join('')}`;
const wf2 = (a, b) => `name: t\njobs:\n  a:\n    steps:\n${a}  b:\n    steps:\n${b}`;
const step = (name, body) => `      - name: ${name}\n${body.split('\n').map(l => `        ${l}`).join('\n')}\n`;
const BASE = wf(step('Existing', 'run: node scripts/a.js --strict'));
const find = (head, changedFiles = ['.github/workflows/test.yml'], base = BASE) =>
  findUnprovenNewGates({ baseText: base, headText: head, changedFiles }).violations.map(v => v.name);

test('new blocking --strict step with no baseline is flagged', () => {
  assert.deepEqual(find(BASE + step('New gate', 'run: node scripts/b.js --strict')), ['New gate']);
});
test('new blocking --gate step is flagged', () => {
  assert.deepEqual(find(BASE + step('New gate', 'run: node scripts/b.js --gate')), ['New gate']);
});
test('advisory (continue-on-error) new gate passes', () => {
  assert.deepEqual(find(BASE + step('New gate', 'continue-on-error: true\nrun: node scripts/b.js --strict')), []);
});
test('new gate shipped with a baseline file passes', () => {
  assert.deepEqual(find(BASE + step('New gate', 'run: node scripts/audit-b.js --strict'), ['.github/workflows/test.yml', 'data/audit-b-baseline.json']), []);
});
test('an UNRELATED baseline file in the same range does not exempt the step', () => {
  assert.deepEqual(find(BASE + step('New gate', 'run: node scripts/b.js --strict'), ['.github/workflows/test.yml', 'data/zzz-other-baseline.json']), ['New gate']);
});
test('baseline named in the step text exempts it', () => {
  assert.deepEqual(find(BASE + step('New gate', 'run: node scripts/b.js --strict --baseline=data/q-baseline.json'), ['data/q-baseline.json']), []);
});
test('same step name in a different job is still a new step', () => {
  const base = wf2(step('Check', 'run: echo hi'), step('Other', 'run: echo hi'));
  const head = wf2(step('Check', 'run: echo hi'), step('Other', 'run: echo hi') + step('Check', 'run: node scripts/b.js --strict'));
  assert.deepEqual(find(head, undefined, base), ['Check']);
});
test('unnamed new step cannot bypass the check', () => {
  assert.deepEqual(find(BASE + '      - run: node scripts/b.js --gate\n'), ['run: node scripts/b.js --gate']);
});
test('id-first step is split from the previous step', () => {
  const head = BASE + '      - id: x\n        name: Late\n        run: node scripts/b.js --strict\n';
  assert.deepEqual(find(head), ['Late']);
});
test('gate-arm-ok annotation passes', () => {
  assert.deepEqual(find(BASE + step('New gate', '# gate-arm-ok: ran clean on live tree 2026-10-05\nrun: node scripts/b.js --strict')), []);
});
test('step without --strict/--gate is ignored', () => {
  assert.deepEqual(find(BASE + step('Other', 'run: node scripts/b.js --dry-run')), []);
});
test('--strict only in a comment is ignored', () => {
  assert.deepEqual(find(BASE + step('Other', '# was --strict\nrun: node scripts/b.js')), []);
});
test('pre-existing step (same name) is never flagged, including promotion to blocking', () => {
  const base = wf(step('G', 'continue-on-error: true\nrun: node scripts/a.js --gate'));
  assert.deepEqual(find(wf(step('G', 'run: node scripts/a.js --gate')), undefined, base), []);
});
test('renaming an existing blocking gate is not flagged', () => {
  assert.deepEqual(find(wf(step('Existing (BRO-1)', 'run: node scripts/a.js --strict'))), []);
});
test('flag followed by ; or ) is still detected', () => {
  assert.deepEqual(find(BASE + step('N', 'run: npm run audit:x -- --strict;')), ['N']);
});
test('parseSteps separates adjacent steps', () => {
  assert.deepEqual(parseSteps(BASE + step('Two', 'run: x')).map(s => s.name), ['Existing', 'Two']);
});
test('the live test.yml parses to many named steps', async () => {
  const { readFileSync } = await import('node:fs');
  assert.ok(parseSteps(readFileSync(path.join(REPO, '.github/workflows/test.yml'), 'utf8')).length > 200);
});

test('CLI: unresolvable base warns and exits 0 (fail-open on infra only)', () => {
  const r = spawnSync('node', [path.join(REPO, 'scripts/audit-new-gate-arming.js'), '--base=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SKIPPED/);
});

test('CLI: bad fixture commit fails (exit 1), advisory fixture commit passes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-arming-'));
  try {
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    for (const f of ['scripts/audit-new-gate-arming.js', 'scripts/lib/new-gate-arming.js', 'scripts/lib/cli-help.js']) {
      copyFileSync(path.join(REPO, f), path.join(dir, f));
    }
    const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'pipe' });
    const run = () => spawnSync('node', ['scripts/audit-new-gate-arming.js', '--base=HEAD~1'], { cwd: dir, encoding: 'utf8' });
    const wfPath = path.join(dir, '.github/workflows/test.yml');
    g('init', '-q');
    writeFileSync(wfPath, BASE);
    g('add', '-A'); g('commit', '-qm', 'base');
    writeFileSync(wfPath, BASE + step('Audit new thing (strict)', 'run: node scripts/audit-new.js --strict'));
    g('commit', '-qam', 'bad: arms a new gate blocking');
    const bad = run();
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /Audit new thing \(strict\)/);
    writeFileSync(wfPath, BASE + step('Audit new thing (strict)', 'continue-on-error: true\nrun: node scripts/audit-new.js --strict'));
    g('commit', '-qam', 'good: advisory');
    // base HEAD~1 is now the bad commit (step already present) so compare to root instead
    const good = spawnSync('node', ['scripts/audit-new-gate-arming.js', '--base=HEAD~2'], { cwd: dir, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stdout + good.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
