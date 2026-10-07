import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  checkFile,
  blankStringContents,
  tokenizerStatus,
  RISKY_CALL_RE,
  findMatching,
  stripNonInvokedFunctionBodies,
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

// --- degraded mode must name itself, not manufacture findings (2026-08-12) ---
//
// Without acorn, blankStringContentsViaAcorn() returns null and the naive
// fallback reports audit-digest-clip-safety.js (Rule A) and
// audit-fetchpage-cleanup.js (Rule B) as blocking violations on a tree where
// both files are clean — reproduced on two byte-identical checkouts of
// a058762fb37 (one with node_modules: exit 0; one without: exit 1, same two
// files). main() now refuses to emit findings it cannot trust.
//
// TWO tests, because the obvious single one is unfalsifiable HERE. Worktrees
// live at .claude/worktrees/<name>/ — nested INSIDE the main repo — and node
// resolution walks up parent directories, so a worktree with no node_modules
// of its own still resolves acorn from /Users/<user>/Broadwayscore/node_modules.
// Since CLAUDE.md requires every code edit to happen in a worktree, a runtime
// probe alone can never fail in the place this repo does its work, and would
// have read as a passing guard while guarding nothing (second-opinion finding,
// 2026-08-12).
//
// (a) runtime: the tokenizer path is live wherever this suite runs.
test('the precise tokenizer resolves at runtime', () => {
  const status = tokenizerStatus();
  assert.equal(status.ok, true, status.detail);
});

// (b) declaration: acorn is a REAL declared dependency, so `npm ci` installs it
// in CI and in a fresh clone. This is the falsifiable half — parent-directory
// node_modules cannot mask a missing package.json entry, so deleting acorn from
// dependencies fails here with a readable reason instead of turning Lint
// Workflows red against two innocent files.
test('acorn is declared in package.json, not just ambiently resolvable', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assert.ok(
    declared.acorn,
    'acorn is missing from package.json — `npm ci` will not install it, so the help-flag audit ' +
      'degrades to its naive scanner in CI and reports clean files as blocking violations'
  );
});

// --- findMatching must not desync on regex literals (cousin of BRO-109) ---
//
// An unescaped brace/paren inside a regex character class (e.g.
// `.replace(/\{\{/g, '')`) is idiomatic markup-scrubbing in this repo (see
// scripts/lib/wiki-utils.js). If findMatching() doesn't skip regex literals,
// it desyncs its depth counter on the stray `{`/`}` inside `/\{\{/` and
// `/\}\}/`, truncating whatever brace body it's tasked with matching.

test('findMatching skips regex-literal braces (real scripts/lib/wiki-utils.js)', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'wiki-utils.js'), 'utf8');
  const openIdx = src.indexOf('function stripWikiMarkup');
  const openBrace = src.indexOf('{', openIdx);
  const closeBrace = findMatching(src, openBrace, '{', '}');
  assert.ok(closeBrace != null, 'findMatching returned null — desynced before reaching the real close brace');
  const body = src.slice(openBrace + 1, closeBrace);
  assert.ok(body.includes('return cleaned;'), 'body truncated before its own return statement');
  assert.ok(!body.includes('function hasWikiMarkup'), 'body swallowed the NEXT function — depth desynced');
});

test('findMatching: bare division after an operand is not mistaken for a regex', () => {
  const src = 'function f() { const x = a / b; return x; }';
  const openBrace = src.indexOf('{');
  const closeBrace = findMatching(src, openBrace, '{', '}');
  assert.equal(src.slice(openBrace, closeBrace + 1), src.slice(openBrace, src.lastIndexOf('}') + 1));
});

test('stripNonInvokedFunctionBodies does not desync on a regex-literal brace in a helper body', () => {
  const src = [
    'function helper(text) {',
    "  return text.replace(/\\{\\{/g, '');",
    '}',
    'execSync("rm -rf /");',
  ].join('\n');
  const stripped = stripNonInvokedFunctionBodies(src);
  assert.ok(stripped.includes('execSync("rm -rf /");'), 'top-level call after the helper got swallowed — depth desynced');
});
