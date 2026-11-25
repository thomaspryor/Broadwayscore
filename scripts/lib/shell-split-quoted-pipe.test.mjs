// BRO-8106: the five hook libs that split a shell command now ignore `|`, `&&`, `;` inside quotes (BRO-8095 class).
// Each test require()s the real function (CLAUDE.md rule 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { splitUnquoted } = require('./shell-split-unquoted.js');
const { segments } = require('./dispatch-timeout-match.js');
const { splitSegments, findUnsafeClaudeInvocation } = require('./cmux-launch-guard.js');
const { invokesValidate, protectedStaged } = require('./always-commit-after-validate.js');
const { shellSegments } = require('./infra-review-scope.js');
const { findGitDiffOnIgnoredPaths } = require('./audit-workflow-hygiene-rules.js');

test('splitUnquoted options leave the default untouched and opt in per flag', () => {
  assert.deepEqual(splitUnquoted('a | b && c'), ['a ', ' b ', ' c']);
  assert.deepEqual(splitUnquoted('a | b || c', { pipe: false }), ['a | b ', ' c']);
  assert.deepEqual(splitUnquoted('a\nb', { newline: true }), ['a', 'b']);
  assert.deepEqual(splitUnquoted('a & b 2>&1', { background: true }), ['a ', ' b 2>', '1']);
  assert.deepEqual(splitUnquoted("echo 'a\n& b'", { newline: true, background: true }), ["echo 'a\n& b'"]);
});

test('dispatch-timeout-match segments: unquoted unchanged, quoted separators kept', () => {
  assert.deepEqual(segments('a && b || c ; d & e\nf | g'), ['a ', ' b ', ' c ', ' d ', ' e', 'f | g']);
  assert.deepEqual(segments("echo 'timeout 5 && x' && y"), ["echo 'timeout 5 && x' ", ' y']);
});

test('cmux-launch-guard splitSegments: unquoted unchanged, quoted separators kept', () => {
  assert.deepEqual(splitSegments('a && b | c ; d\ne'), ['a ', ' b ', ' c ', ' d', 'e']);
  assert.deepEqual(splitSegments("echo 'x | claude --model y'"), ["echo 'x | claude --model y'"]);
  assert.equal(findUnsafeClaudeInvocation("echo 'x | claude --model y'", 0, null), null);
  assert.ok(findUnsafeClaudeInvocation('echo x | claude --model y', 0, null));
});

test('always-commit-after-validate: a quoted pipe does not create a validate command', () => {
  assert.equal(invokesValidate('node scripts/validate-data.js | tail'), true);
  assert.equal(invokesValidate("echo 'x | node scripts/validate-data.js'"), false, 'an echoed string is not a run');
  assert.deepEqual(protectedStaged("git add 'a|b' data/shows.json"), ['data/shows.json'], 'quoted pipe must not hide the later protected path');
});

test('infra-review-scope stays quote-blind on purpose: a write wrapped in bash -c is still seen', () => {
  const { bashWriteTargets } = require('./infra-review-scope.js');
  assert.ok(bashWriteTargets('bash -c "cd x; tee .github/workflows/x.yml"').some((t) => t.includes('.github/workflows/x.yml')));
  assert.ok(bashWriteTargets("bash -c 'echo hi && sed -i s/a/b/ .github/workflows/x.yml'").some((t) => t.includes('.github/workflows/x.yml')));
  assert.deepEqual(shellSegments('a || b && c ; d | e\nf'), ['a ', ' b ', ' c ', ' d ', ' e', 'f']);
});

test('audit-workflow-hygiene findGitDiffOnIgnoredPaths: quoted pipe stays in the git args', () => {
  const ignored = (p) => p === 'data/x.json';
  const wf = (cmd) => `jobs:\n  a:\n    steps:\n      - run: ${cmd}\n`;
  assert.equal(findGitDiffOnIgnoredPaths(wf('git diff --quiet data/x.json | cat'), ignored).length, 1);
  assert.equal(findGitDiffOnIgnoredPaths(wf('git diff --quiet -- "data/a|b" data/x.json'), ignored).length, 1, 'a quoted pipe must not hide the later ignored path');
});
