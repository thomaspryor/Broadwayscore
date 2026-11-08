// BRO-7111: exitFlushed(code) must deliver every byte already written before exiting, keep
// the code when the reader hangs up early, and the bare main-exit pattern may not spread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HELPER = path.join(HERE, 'exit-flushed.js');

function child(code) {
  return `const { exitFlushed } = require(${JSON.stringify(HELPER)});
const line = 'x'.repeat(199) + '\\n';
for (let i = 0; i < 5000; i++) process.stdout.write(line);
process.stdout.write('END\\n');
exitFlushed(${code});`;
}

test('a 1MB write then exitFlushed(3) reaches a piped reader whole, with status 3', () => {
  const r = spawnSync(process.execPath, ['-e', child(3)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.length, 5000 * 200 + 4);
  assert.ok(r.stdout.endsWith('END\n'));
});

test('a reader that closes early (| head) does not turn the code into an EPIPE crash', () => {
  const r = spawnSync('bash', ['-c', `"${process.execPath}" -e "$CHILD" | head -c 10 >/dev/null; echo "\${PIPESTATUS[0]}"`],
    { encoding: 'utf8', env: { ...process.env, CHILD: child(3) } });
  assert.equal(r.stdout.trim(), '3');
});

test('exit 0 and a falsy/undefined result exit 0; a non-integer truthy result exits 1', () => {
  for (const [arg, want] of [['0', 0], ['undefined', 0], ['true', 1]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(HELPER)}).exitFlushed(${arg})`], { encoding: 'utf8' });
    assert.equal(r.status, want, `exitFlushed(${arg})`);
  }
});

// The bare forms that drop queued output: process.exit(main(...)), .then(c => process.exit(c)),
// and const c = main(...); ... process.exit(c). scripts/lib/ (land and CI verdicts) has none;
// the rest of scripts/ may not grow (exact baseline, so a conversion must lower it).
const SITE_RES = [
  /process\.exit\(\s*main\(/g,
  /\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*process\.exit\(\s*\1\s*\)/g,
  /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?main\([^;]*\);[\s\S]{0,400}?process\.exit\(\s*\1\s*\)/g,
];
const BASELINE_OUTSIDE_LIB = 116;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(?:c|m)?js$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

function countSites(text) {
  return SITE_RES.reduce((n, re) => n + (text.match(re) || []).length, 0);
}

test('the site patterns match every bare form and not the flushed one', () => {
  assert.equal(countSites('process.exit(main(process.argv.slice(2)));'), 1);
  assert.equal(countSites('main().then((code) => process.exit(code), () => process.exit(1));'), 1);
  assert.equal(countSites('const code = main();\nrecord(code);\nprocess.exit(code);'), 1);
  assert.equal(countSites("require('./exit-flushed.js').exitFlushed(main());"), 0);
});

test('no bare main-exit in scripts/lib; the rest of scripts/ does not grow past its baseline', () => {
  const lib = [];
  let outside = 0;
  for (const f of walk(path.join(ROOT, 'scripts'))) {
    const n = countSites(fs.readFileSync(f, 'utf8'));
    if (!n) continue;
    const rel = path.relative(ROOT, f);
    if (rel.startsWith(`scripts${path.sep}lib${path.sep}`)) lib.push(`${rel} (${n})`);
    else outside += n;
  }
  assert.deepEqual(lib, [], 'use require(\'./exit-flushed.js\').exitFlushed(code) so piped output is not truncated (BRO-7111)');
  assert.ok(outside <= BASELINE_OUTSIDE_LIB, `${outside} bare main-exit sites outside scripts/lib (baseline ${BASELINE_OUTSIDE_LIB}): new scripts use exitFlushed from scripts/lib/exit-flushed.js`);
  assert.equal(outside, BASELINE_OUTSIDE_LIB, `converted some (${outside} < ${BASELINE_OUTSIDE_LIB}): lower BASELINE_OUTSIDE_LIB to ${outside}`);
});
