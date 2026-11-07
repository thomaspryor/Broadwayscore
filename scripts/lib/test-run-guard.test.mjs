// BRO-5261 retro-review of BRO-2664: ledger sinks must recognise a test file
// run directly with `node`, not only `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const GUARD = require.resolve('./test-run-guard.js');
const { isTestRun, argvIsTestFile } = require(GUARD);
const LEDGER = require.resolve('./dispatch-ledger.js');

test('isTestRun: node --test env, the inherited marker, and *.test.* entry points', () => {
  const prod = ['node', '/repo/scripts/bsc-next.js'];
  assert.equal(isTestRun({}, prod), false);
  assert.equal(isTestRun({ NODE_TEST_CONTEXT: 'child-v8' }, prod), true);
  assert.equal(isTestRun({ BSC_TEST_RUN: '1' }, prod), true);
  for (const f of ['a.test.mjs', 'a.test.js', 'a.test.cjs', 'a.test.ts']) assert.equal(isTestRun({}, ['node', `/x/${f}`]), true, f);
  for (const f of ['test-data.js', 'latest.js', 'a.test.json', 'contest.mjs']) assert.equal(argvIsTestFile(['node', `/x/${f}`]), false, f);
  assert.equal(argvIsTestFile([]), false);
});

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trg-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Child env WITHOUT the node:test markers, like a direct `node x.test.mjs` run.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.BSC_TEST_RUN;
  return env;
}

test('a directly-run *.test.mjs file sets BSC_TEST_RUN, and its children inherit it', (t) => {
  const d = tmpDir(t);
  const child = path.join(d, 'child.js');
  fs.writeFileSync(child, `process.stdout.write(String(require(${JSON.stringify(GUARD)}).isTestRun()))`);
  const entry = path.join(d, 'entry.test.mjs');
  fs.writeFileSync(entry, `import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
createRequire(import.meta.url)(${JSON.stringify(GUARD)});
const r = spawnSync(process.execPath, [${JSON.stringify(child)}], { encoding: 'utf8' });
process.stdout.write(r.stdout);`);
  const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.stdout, 'true', r.stderr);
  const prod = spawnSync(process.execPath, [child], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(prod.stdout, 'false', 'a production entry point is not a test run');
});

test('dispatch-ledger appendEntry() with no path never touches the real ledger in a direct test run', (t) => {
  const d = tmpDir(t);
  const entry = path.join(d, 'writer.test.mjs');
  fs.writeFileSync(entry, `import { createRequire } from 'node:module';
const dl = createRequire(import.meta.url)(${JSON.stringify(LEDGER)});
dl.appendEntry({ event: 'launch', taskId: 'linear:BRO-0', subject: 'guard probe' });
process.stdout.write(JSON.stringify({ def: dl.defaultLedgerPath(), real: dl.LEDGER_PATH, rows: dl.readEntries().length }));`);
  const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.notEqual(out.def, out.real);
  assert.ok(out.def.startsWith(os.tmpdir()), out.def);
  assert.equal(out.rows, 1, 'readEntries() reads back from the same test ledger');
  // DISPATCH_LEDGER_PATH still wins.
  const pinned = path.join(d, 'pinned.jsonl');
  const r2 = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: cleanEnv({ DISPATCH_LEDGER_PATH: pinned }) });
  assert.equal(JSON.parse(r2.stdout).def, pinned);
  assert.equal(fs.readFileSync(pinned, 'utf8').trim().split('\n').length, 1);
});

test('under node --test the guard leaves BSC_TEST_RUN unset (children simulating a real run stay real)', { skip: !process.env.NODE_TEST_CONTEXT && 'only meaningful under node --test' }, () => {
  assert.equal(process.env.BSC_TEST_RUN, undefined);
});
