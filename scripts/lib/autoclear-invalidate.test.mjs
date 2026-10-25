import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findWrongShowAssignments,
  computeTemplateLiteralOpenLines,
  hasNearbyInvalidateCall,
  scanFileForInvalidateViolations,
} = require('./autoclear-invalidate.js');

test('findWrongShowAssignments finds member assignment and object-literal writes', () => {
  const content = [
    'function f(data) {',
    '  data.wrongShow = true;',
    '  const g = { wrongShow: true, note: "x" };',
    '}',
  ].join('\n');
  const hits = findWrongShowAssignments(content);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[1].line, 3);
});

test('findWrongShowAssignments skips comments, comparisons, and string-literal prose', () => {
  const content = [
    '// data.wrongShow = true; (comment)',
    'if (data.wrongShow === true) return;',
    'const note = "Already wrongShow:true (excluded)";',
  ].join('\n');
  assert.deepEqual(findWrongShowAssignments(content), []);
});

test('findWrongShowAssignments skips prose inside a multi-line template literal', () => {
  const content = [
    'const USAGE = `audit.js',
    '',
    '  --apply   write wrongShow:true (+ reason/flag fields) to matched files.',
    '`;',
    'data.wrongShow = true;',
  ].join('\n');
  const hits = findWrongShowAssignments(content);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 5);
});

test('computeTemplateLiteralOpenLines marks only lines inside an open template', () => {
  const content = ['const a = `line1', 'line2`;', 'const b = 1;'].join('\n');
  const openLines = computeTemplateLiteralOpenLines(content);
  assert.equal(openLines.has(1), false, 'line that OPENS the template is not marked (write can precede the backtick)');
  assert.equal(openLines.has(2), true, 'line fully inside the open template is marked');
  assert.equal(openLines.has(3), false);
});

test('hasNearbyInvalidateCall finds a call within the window, ignoring comment lines', () => {
  const content = [
    'data.wrongProduction = true;',
    '// a comment mentioning invalidateWrongProductionAutoClear should not count',
    'x();',
    'invalidateWrongProductionAutoClear(data);',
  ].join('\n');
  assert.equal(hasNearbyInvalidateCall(content, 1, 'invalidateWrongProductionAutoClear'), true);
});

test('hasNearbyInvalidateCall returns false when no call is within the window', () => {
  const content = ['data.wrongProduction = true;', ...Array(50).fill('x();')].join('\n');
  assert.equal(hasNearbyInvalidateCall(content, 1, 'invalidateWrongProductionAutoClear'), false);
});

test('scanFileForInvalidateViolations flags an uncovered wrongProduction write', () => {
  const content = [
    'function f(data) {',
    '  data.wrongProduction = true;',
    '  save(data);',
    '}',
  ].join('\n');
  const violations = scanFileForInvalidateViolations(content, 'scripts/example.js');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].flag, 'wrongProduction');
  assert.equal(violations[0].fn, 'invalidateWrongProductionAutoClear');
});

test('scanFileForInvalidateViolations flags an uncovered wrongShow write', () => {
  const content = [
    'function f(data) {',
    '  data.wrongShow = true;',
    '  save(data);',
    '}',
  ].join('\n');
  const violations = scanFileForInvalidateViolations(content, 'scripts/example.js');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].flag, 'wrongShow');
  assert.equal(violations[0].fn, 'invalidateWrongShowAutoClear');
});

test('scanFileForInvalidateViolations passes clean when the invalidate call is present', () => {
  const content = [
    'function f(data) {',
    '  data.wrongProduction = true;',
    '  invalidateWrongProductionAutoClear(data);',
    '  data.wrongShow = true;',
    '  invalidateWrongShowAutoClear(data);',
    '  save(data);',
    '}',
  ].join('\n');
  assert.deepEqual(scanFileForInvalidateViolations(content, 'scripts/example.js'), []);
});

test('scanFileForInvalidateViolations ignores writes inside a multi-line USAGE template', () => {
  const content = [
    'const USAGE = `tool.js',
    '  --apply   write wrongShow:true and wrongProduction:true to matched files.',
    '`;',
  ].join('\n');
  assert.deepEqual(scanFileForInvalidateViolations(content, 'scripts/example.js'), []);
});

test('scanFileForInvalidateViolations passes the shared-call-after-branches pattern (verify-existing-reviews.js shape)', () => {
  // Two mutually-exclusive branches each set the flag; ONE shared invalidate
  // call after the if/else covers both (BRO-3895's own pattern). Regression
  // test for the Codex adversarial ship-check finding that a naive
  // per-hit-bounded window broke this exact real-world shape.
  const content = [
    'function f(data, isFilmTv) {',
    '  if (isFilmTv) {',
    '    data.wrongShow = true;',
    '  } else {',
    '    data.wrongShow = true;',
    '  }',
    '  invalidateWrongShowAutoClear(data);',
    '  save(data);',
    '}',
  ].join('\n');
  assert.deepEqual(scanFileForInvalidateViolations(content, 'scripts/example.js'), []);
});

test('computeTemplateLiteralOpenLines does not desync on a stray backtick inside a comment', () => {
  const content = [
    "// this is like a `pseudo-code snippet, not a real template",
    'data.wrongShow = true;',
    'invalidateWrongShowAutoClear(data);',
  ].join('\n');
  // Without skipping comment lines, the odd backtick above would flip
  // inTemplate=true for the rest of the file, hiding the real write below
  // behind a false "inside an open template" (Codex adversarial finding).
  const openLines = computeTemplateLiteralOpenLines(content);
  assert.equal(openLines.has(2), false);
  assert.deepEqual(scanFileForInvalidateViolations(content, 'scripts/example.js'), []);
});

test('computeTemplateLiteralOpenLines still counts a closing backtick on a line that LOOKS like a comment but is inside an open template', () => {
  // A line starting with `//` that is actually STRING CONTENT (the template
  // opened on an earlier line and hasn't closed yet) must still have its
  // backtick counted, or the template never closes and every later real
  // write is hidden behind a false "still inside a template" (second Codex
  // adversarial finding on the first fix for this exact function).
  const content = [
    'const help = `usage',
    '// example`;',
    'data.wrongShow = true;',
    'invalidateWrongShowAutoClear(data);',
  ].join('\n');
  const openLines = computeTemplateLiteralOpenLines(content);
  assert.equal(openLines.has(2), true, 'line 2 is inside the template opened on line 1');
  assert.equal(openLines.has(3), false, 'the template closed on line 2 — line 3 is real code');
  assert.deepEqual(scanFileForInvalidateViolations(content, 'scripts/example.js'), []);
});
