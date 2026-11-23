// BRO-8179: test temp dirs clean themselves up; the lint flags leakers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { makeTmpDir, scopedTestTmpdir, mkdtempWithoutCleanup } = require('./test-tmpdir.js');

test('lint: a test file with mkdtempSync and no cleanup is flagged', () => {
  assert.equal(mkdtempWithoutCleanup("const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orj-'));"), true);
  assert.equal(mkdtempWithoutCleanup("import { mkdtempSync } from 'node:fs'; const d = mkdtempSync('/tmp/x-');"), true);
  assert.equal(mkdtempWithoutCleanup("execSync('d=$(mktemp -d); echo hi > $d/f')"), true);
});

test('lint: cleanup anywhere in the file passes it; no mkdtemp passes', () => {
  assert.equal(mkdtempWithoutCleanup("const d = fs.mkdtempSync('x'); after(() => fs.rmSync(d, { recursive: true }));"), false);
  assert.equal(mkdtempWithoutCleanup("const d = makeTmpDir(t, 'orj-');"), false);
  assert.equal(mkdtempWithoutCleanup("d=$(mktemp -d); trap 'rm -rf $d' EXIT; const x = fs.mkdtempSync('y')"), false);
  assert.equal(mkdtempWithoutCleanup("fs.writeFileSync('/tmp/a', 'b')"), false);
});

test('makeTmpDir registers an after() that removes the dir', async (t) => {
  let dir;
  await t.test('inner', (tt) => { dir = makeTmpDir(tt, 'bro8179-mk-'); fs.writeFileSync(`${dir}/f`, 'x'); assert.ok(fs.existsSync(dir)); });
  assert.equal(fs.existsSync(dir), false, 'removed after the subtest');
  assert.throws(() => makeTmpDir(null, 'x-'));
});

test('scopedTestTmpdir: child os.tmpdir() lands inside it; cleanup removes everything', () => {
  const s = scopedTestTmpdir('bro8179-scope-');
  const r = spawnSync(process.execPath, ['-e', "const fs=require('fs'),os=require('os'),p=require('path');const d=fs.mkdtempSync(p.join(os.tmpdir(),'leak-'));fs.writeFileSync(p.join(d,'f'),'x');console.log(d)"],
    { env: { ...process.env, ...s.env }, encoding: 'utf8' });
  const made = r.stdout.trim();
  assert.ok(fs.realpathSync(made).startsWith(`${s.dir}/`), `${made} under ${s.dir}`);
  s.cleanup();
  assert.equal(fs.existsSync(s.dir), false);
  assert.equal(fs.existsSync(made), false);
});

test('audit CLI --strict: a new leaking file fails, the baseline passes', () => {
  const tmp = scopedTestTmpdir('bro8179-lint-');
  try {
    const f = `${tmp.dir}/leaky.test.mjs`;
    fs.writeFileSync(f, "import fs from 'node:fs'; fs.mkdtempSync('/tmp/orj-');\n");
    const bad = spawnSync(process.execPath, ['scripts/lib/test-tmpdir-cleanup-audit.js', '--strict', '--files', f], { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stdout, /NEW .*leaky\.test\.mjs/);
    const ok = spawnSync(process.execPath, ['scripts/lib/test-tmpdir-cleanup-audit.js', '--strict'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout);
  } finally { tmp.cleanup(); }
});

// Root-cause guard: the land floor's and land-fast-tests' `node --test`
// children run in a throwaway TMPDIR, so a legacy test that mkdtemps and
// never cleans up leaves nothing behind once the run returns.
for (const [label, run] of [
  ['merge-post-merge-test-gate defaultExec', (cwd, file) => require('./merge-post-merge-test-gate.js').defaultExec(cwd, [file], 60000)],
  ['land-fast-tests runGateFiles', (cwd, file) => require('./land-fast-tests.js').runGateFiles(cwd, 'node', [file], { timeoutMs: 60000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) })],
]) {
  test(`${label}: a leaking test leaves no temp dir behind`, async (t) => {
    const work = makeTmpDir(t, 'bro8179-runner-');
    const marker = `bro8179-leak-${process.pid}-${label.length}-`;
    const file = `${work}/leak.test.mjs`;
    fs.writeFileSync(file, `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
test('leak', () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), '${marker}')); fs.writeFileSync(path.join(d, 'x'), 'x'); fs.writeFileSync(path.join(os.tmpdir(), '..', '${marker}where'), d); });\n`);
    const r = await run(work, file);
    assert.equal(r.status ?? r.exit, 0, String(r.stdout || r.text || '').slice(-800));
    // The leaked dir's path was written next to the scoped TMPDIR (its parent);
    // the dir itself must be gone.
    const whereFiles = [];
    for (const root of [os.tmpdir()]) {
      for (const n of fs.readdirSync(root)) if (n === `${marker}where`) whereFiles.push(`${root}/${n}`);
    }
    assert.equal(whereFiles.length, 1, 'leak test ran and recorded its dir');
    const leaked = fs.readFileSync(whereFiles[0], 'utf8');
    fs.rmSync(whereFiles[0], { force: true });
    assert.ok(leaked.includes('bro-testrun-'), `test ran inside the scoped TMPDIR: ${leaked}`);
    assert.equal(fs.existsSync(leaked), false, `leaked dir removed: ${leaked}`);
  });
}
