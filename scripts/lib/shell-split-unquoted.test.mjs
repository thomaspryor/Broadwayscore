// BRO-8095 class guard: a shell command is split only on separators OUTSIDE quotes. Fails if a gate goes back to a raw regex split.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { splitUnquoted } = require('./shell-split-unquoted.js');
const { acceptanceIsReal } = require('./outside-setting.js');
const trim = (c) => splitUnquoted(c).map((s) => s.trim());

test('splits on unquoted && || ; |, not inside quotes', () => {
  assert.deepEqual(trim('a && b | c ; d || e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(trim("node --test --test-name-pattern='lead|pickLead' f.mjs"), ["node --test --test-name-pattern='lead|pickLead' f.mjs"]);
  assert.deepEqual(trim('echo "a;b||c" || x'), ['echo "a;b||c"', 'x']);
  assert.deepEqual(trim('echo a \\| b'), ['echo a \\| b'], 'escaped pipe');
});

test('a stray apostrophe does not swallow later separators or reopen the quoted-pipe hole', () => {
  assert.deepEqual(trim("echo it's fine && node --test f"), ["echo it's fine", 'node --test f']);
  assert.deepEqual(trim("echo 'x | node --test f' # it's"), ["echo 'x | node --test f' # it's"]);
});

test('cousin: outside-setting acceptanceIsReal judges the command, not a string inside quotes', () => {
  assert.equal(acceptanceIsReal("grep 'a|node --test x.test.mjs' f"), false, 'grep with a quoted pipe is still existence-only');
  assert.equal(acceptanceIsReal('cd x && node scripts/check.js'), true);
});

test('BRO-8095 skeptic: tricky real-world strings split as a shell would', () => {
  assert.deepEqual(trim("echo 'x | node --test f'"), ["echo 'x | node --test f'"]);
  assert.deepEqual(trim('cmd --flag="a && b"'), ['cmd --flag="a && b"']);
  assert.deepEqual(trim("# it's not closed && next"), ["# it's not closed", 'next']);
  assert.deepEqual(trim('node --test a.mjs \\&\\& b'), ['node --test a.mjs \\&\\& b'], 'escaped && stays one command');
  assert.deepEqual(trim('a;b'), ['a', 'b']);
  assert.deepEqual(trim(''), ['']);
  assert.deepEqual(trim("echo 'unclosed | node --test f"), ["echo 'unclosed", 'node --test f'], 'unclosed quote falls back to splitting');
});

test('BRO-8095 skeptic: live consumers keep their verdicts on known-good and known-bad commands', () => {
  const real = ["node --test --test-name-pattern='lead|pickLead' a.test.mjs", 'cd x && node scripts/check.js', 'cat x | node --test a.test.mjs', 'npm test; node --test b.test.mjs'];
  const bad = ["echo 'node --test a.test.mjs'", "echo 'x | node --test f.test.mjs'", "grep 'a|node --test x.test.mjs' f", 'echo "a && node --test f.test.mjs"'];
  for (const c of real) assert.equal(acceptanceIsReal(c), true, c);
  for (const c of bad) assert.equal(acceptanceIsReal(c), false, c);
});

test('class guard: no gate in scripts/lib splits a command with a raw && || ; | regex', () => {
  const RAW = /\.split\(\/(?:&&\|\\\|\\\||\(\?:\\\|\\\|\|&&)/;
  const allow = new Set([]); // BRO-8106 migrated the last five; never grow
  const hits = fs.readdirSync(new URL('.', import.meta.url)).filter((f) => /\.(m?js)$/.test(f) && !/\.test\./.test(f) && !allow.has(f) && RAW.test(fs.readFileSync(new URL(f, import.meta.url), 'utf8')));
  assert.deepEqual(hits, [], 'use shell-split-unquoted.js instead of a raw command regex split');
});
