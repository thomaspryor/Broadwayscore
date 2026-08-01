import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkFile,
  blankStringContents,
  RISKY_CALL_RE,
} = require('./audit-help-flag-safety.js');

const riskyHits = (src) => (src.match(new RegExp(RISKY_CALL_RE.source, 'g')) || []).length;

// --- blankStringContents: the view RISKY_CALL_RE scans (task #684) ---

test('blanks string CONTENT but preserves length, so reported offsets stay true', () => {
  for (const src of [
    `const U = 'use fetchPage() here';`,
    'const t = `line one\nline two`;\nexecSync("x");',
    `const esc = 'it\\'s fine'; const d = "a\\"b";`,
    `const unterminated = 'oops`,
  ]) {
    assert.equal(blankStringContents(src).length, src.length, `length changed for: ${src}`);
  }
});

test('a risky function NAMED inside a string is not a call', () => {
  assert.equal(riskyHits(blankStringContents(`const U = 'run fetchPage() first';`)), 0);
  assert.equal(riskyHits(blankStringContents('const U = `bypassing fetchPage()/fetchJSON()`;')), 0);
});

test('a real call outside strings is still seen', () => {
  assert.equal(riskyHits(blankStringContents(`const r = await fetchPage(url, {});`)), 1);
});

test('template ${...} substitutions stay visible — they are evaluated code', () => {
  assert.equal(riskyHits(blankStringContents('const x = `a${execSync("id")}b`;')), 1);
});

// Regression: a quote inside a REGEX literal opened a phantom string that
// swallowed the rest of the file and hid real calls (adjudicate-seat-research.js
// `.replace(/&quot;/g, '"')` hid `await fetchPage(url, {})` 4,800 chars later).
test('a quote inside a regex literal cannot hide a real call on a LATER line', () => {
  const src = [
    `const clean = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'");`,
    `const result = await fetchPage(url, {});`,
  ].join('\n');
  assert.equal(riskyHits(blankStringContents(src)), 1);
});

// Regression: the FIRST fix for the string false-positive newline-scoped '/"
// but left BACKTICKS multi-line, so a backtick inside a regex CHARACTER CLASS
// (a shell-arg sanitizer — precisely the shape that then calls execSync) opened
// a phantom template literal that ran to EOF and hid every later risky call.
// Caught by ship-check corpus parity: 8 genuine calls vanished, including in
// fetch-show-images-auto.js, one of the scripts this guard was built for (#477).
// A false negative here is far worse than a false positive, so this must stay green.
test('a backtick inside a regex character class cannot hide a later real call', () => {
  const src = [
    `const args = (process.argv[2] || '').replace(/[;&|\`$()]/g, '');`,
    `const { execSync } = require('child_process');`,
    `execSync('rm -rf /tmp/x', { stdio: 'inherit' });`,
  ].join('\n');
  assert.equal(riskyHits(blankStringContents(src)), 1);
});

test('a regex containing // is not mistaken for a comment', () => {
  const src = [
    `const isHttp = /^https?:\\/\\//.test(url);`,
    `execSync('date');`,
  ].join('\n');
  assert.equal(riskyHits(blankStringContents(src)), 1);
});

test('unparseable source fails OPEN — never silently blanks real code', () => {
  const broken = `function ( { this is not valid javascript >>> ; execSync('rm -rf /');`;
  // Must not hide the call: either returned unchanged, or at minimum still visible.
  assert.ok(riskyHits(blankStringContents(broken)) >= 1);
});

test("a '/\"-string never runs past its own line", () => {
  const blanked = blankStringContents(`const bad = 'unterminated\nexecSync('x');`);
  assert.equal(riskyHits(blanked), 1);
  assert.equal(blanked.length, `const bad = 'unterminated\nexecSync('x');`.length);
});

// --- checkFile: end-to-end classification ---

test('Rule A does not fire when the only match is USAGE text before the gate', () => {
  const src = [
    `const { hasHelpFlag } = require('./lib/cli-help.js');`,
    'const USAGE = `tool.js — flag scripts bypassing fetchPage()/fetchJSON().`;',
    `if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }`,
    `const r = fetchPage('x');`,
  ].join('\n');
  assert.equal(checkFile('tool.js', src), null);
});

test('Rule A still fires on a REAL call before the gate', () => {
  const src = [
    `const { hasHelpFlag } = require('./lib/cli-help.js');`,
    `const boom = execSync('rm -rf /tmp/x');`,
    `if (hasHelpFlag(process.argv.slice(2))) { process.exit(0); }`,
  ].join('\n');
  const finding = checkFile('tool.js', src);
  assert.equal(finding?.rule, 'A');
});

test('Rule B still fires on risky work with no --help check anywhere', () => {
  const finding = checkFile('tool.js', `function main() { execSync('date'); }\nmain();`);
  assert.equal(finding?.rule, 'B');
});
