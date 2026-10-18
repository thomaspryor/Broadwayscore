const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyIssue } = require('../../scripts/lib/sentry-triage-classify.js');

const ev = frames => ({ entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames } }] } }] });
const chunk = (name, lineNo = 1) => ({ filename: `https://broadwayscorecard.com/_next/static/chunks/${name}.js`, absPath: `https://broadwayscorecard.com/_next/static/chunks/${name}.js`, lineNo, colNo: 143, inApp: true });
const doc = (path, lineNo) => ({ filename: `https://broadwayscorecard.com${path}`, lineNo, colNo: 63, inApp: true });

// Real shape of BROADWAY-SCORECARD-2J (webpack module factory missing after a deploy).
test("our own TypeError 'reading call' in a webpack chunk is a real issue, not noise", () => {
  const issue = { title: "TypeError: Cannot read properties of undefined (reading 'call')", culprit: 'a(chunks/webpack)', count: '8', userCount: '4' };
  assert.equal(classifyIssue(issue, ev([chunk('webpack-d17dd301cb48573d')])).noise, false);
});

test('Safari wording of the same webpack crash is also real', () => {
  const issue = { title: "TypeError: undefined is not an object (evaluating 'd[e].call')", culprit: 's(chunks/webpack)', count: '6', userCount: '3' };
  assert.equal(classifyIssue(issue, ev([chunk('webpack-ac2c76546faf8362'), chunk('5357-33740d9e281866b7')])).noise, false);
});

// Real shape of BROADWAY-SCORECARD-2G/2H/2F: Chrome-iOS injected script, filename is the page URL, line 225.
test('stack overflow inside the page document past its last line is browser-injected noise', () => {
  const frames = [doc('/', 186), doc('/', 197), ...Array.from({ length: 20 }, (_, i) => doc('/', 225 + (i % 2)))];
  const r = classifyIssue({ title: 'RangeError: Maximum call stack size exceeded.', culprit: '?(<unknown module>)', count: '3', userCount: '1' }, ev(frames));
  assert.equal(r.noise, true);
  assert.match(r.reason, /injected/);
});

test('a stack overflow in one of our bundles stays real', () => {
  const r = classifyIssue({ title: 'RangeError: Maximum call stack size exceeded.', culprit: 'walk(chunks/app)', count: '3', userCount: '2' }, ev([chunk('app-123', 40), chunk('app-123', 41)]));
  assert.equal(r.noise, false);
});

test('an error in our real inline script near the top of the document stays real', () => {
  const r = classifyIssue({ title: 'ReferenceError: foo is not defined', culprit: 'global code', count: '5', userCount: '3' }, ev([doc('/', 3)]));
  assert.equal(r.noise, false);
});

test('mixed injected + bundle frames stay real (the bundle frame is ours)', () => {
  const r = classifyIssue({ title: 'RangeError: Maximum call stack size exceeded.', culprit: 'x', count: '5', userCount: '3' }, ev([doc('/', 225), chunk('app-123', 7)]));
  assert.equal(r.noise, false);
});

test('known extension noise is still ignored', () => {
  assert.equal(classifyIssue({ title: 'ResizeObserver loop limit exceeded', culprit: '' }, null).noise, true);
  assert.equal(classifyIssue({ title: 'Error: x', culprit: '' }, ev([{ filename: 'chrome-extension://abc/x.js', lineNo: 1 }])).noise, true);
});
