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

test('class guard: no gate in scripts/lib splits a command with a raw && || ; | regex', () => {
  const RAW = /\.split\(\/(?:&&\|\\\|\\\||\(\?:\\\|\\\|\|&&)/;
  const allow = new Set(['dispatch-timeout-match.js', 'cmux-launch-guard.js', 'always-commit-after-validate.js', 'infra-review-scope.js', 'audit-workflow-hygiene-rules.js']); // BRO-8095 follow-up card; shrink, never grow
  const hits = fs.readdirSync(new URL('.', import.meta.url)).filter((f) => /\.(m?js)$/.test(f) && !/\.test\./.test(f) && !allow.has(f) && RAW.test(fs.readFileSync(new URL(f, import.meta.url), 'utf8')));
  assert.deepEqual(hits, [], 'use shell-split-unquoted.js instead of a raw command regex split');
});
