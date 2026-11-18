/**
 * BRO-7766: scripts/lib/require-memo.js must not change what require() returns
 * or the module.children graph fingerprint-memo.js versions its cache from.
 * Each case runs in a fresh child process, once with the memo and once without.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (code) => execFileSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8' });

test('fingerprint-memo versionedSources() is identical with and without the memo', () => {
  const body = `
    const g = require('./scripts/lib/review-guards.js');
    require('./scripts/lib/outlet-mismatch-heal.js');
    const fm = require('./scripts/lib/fingerprint-memo.js');
    console.log(JSON.stringify(fm.versionedSources().map(f => require('path').relative(process.cwd(), f))));`;
  const plain = run(body);
  const memo = run(`require('./scripts/lib/require-memo').installRequireMemo();${body}`);
  assert.equal(memo, plain);
  assert.ok(JSON.parse(plain).length > 3);
});

test('repeat lazy requires return the live exports; children edges match stock require', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'require-memo-'));
  fs.writeFileSync(path.join(dir, 'a.js'), "exports.v = () => require('./b').n; exports.kids = () => module.children.map(c => require('path').basename(c.id));");
  fs.writeFileSync(path.join(dir, 'b.js'), "module.exports = { n: 1 }; require('./c');");
  // c requires a (a cycle back to an already-loading module) and swaps its own exports later.
  fs.writeFileSync(path.join(dir, 'c.js'), "const a = require('./a'); module.exports = { aKeys: Object.keys(a) };");
  fs.writeFileSync(path.join(dir, 'main.js'), `
    if (process.argv[2] === 'memo') require(${JSON.stringify(path.join(ROOT, 'scripts/lib/require-memo.js'))}).installRequireMemo();
    require('./b'); // loaded first by ANOTHER module in the same dir: a's first require of it must still record the edge
    const a = require('./a');
    const out = [a.v(), a.v()];
    require('./b').n = 2; out.push(a.v());
    delete require.cache[require.resolve('./b')]; out.push(a.v());
    out.push(a.kids().join(','), JSON.stringify(require('./c')));
    console.log(JSON.stringify(out));`);
  const go = (mode) => execFileSync(process.execPath, [path.join(dir, 'main.js'), mode], { encoding: 'utf8' });
  const plain = go('plain');
  assert.equal(go('memo'), plain);
  assert.deepEqual(JSON.parse(plain).slice(0, 4), [1, 1, 2, 1]);
  assert.match(JSON.parse(plain)[4], /b\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installRequireMemo is idempotent and only installed by the rebuild entry point', () => {
  assert.equal(run("const m=require('./scripts/lib/require-memo');console.log(m.installRequireMemo(), m.installRequireMemo())").trim(), 'true false');
  assert.equal(execFileSync(process.execPath, ['-e', "console.log(require('./scripts/lib/require-memo').installRequireMemo())"], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, REQUIRE_MEMO: 'off' } }).trim(), 'false');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  const guard = src.indexOf('if (require.main !== module) return;');
  const install = src.indexOf("require('./lib/require-memo').installRequireMemo()");
  assert.ok(guard > 0 && install > guard, 'memo must be installed below the require.main guard');
});
