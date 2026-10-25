const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyIssue, isStaleDeployIssue } = require('../../scripts/lib/sentry-triage-classify.js');

const ev = frames => ({ entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames } }] } }] });
const chunk = (name, lineNo = 1) => ({ filename: `https://broadwayscorecard.com/_next/static/chunks/${name}.js`, absPath: `https://broadwayscorecard.com/_next/static/chunks/${name}.js`, lineNo, colNo: 143, inApp: true });
const doc = (path, lineNo) => ({ filename: `https://broadwayscorecard.com${path}`, lineNo, colNo: 63, inApp: true });

// Real shape of BROADWAY-SCORECARD-2J (webpack module factory missing after a deploy).
test("the webpack 'reading call' crash is ignored with a stale-deploy reason, not left to flood GitHub", () => {
  const issue = { title: "TypeError: Cannot read properties of undefined (reading 'call')", culprit: 'a(chunks/webpack)', count: '8', userCount: '4' };
  const r = classifyIssue(issue, ev([chunk('webpack-d17dd301cb48573d')]));
  assert.equal(r.noise, true);
  assert.match(r.reason, /Stale tab after a deploy/);
});

test('Safari and Firefox wording of the same crash are recognised too', () => {
  const safari = { title: "TypeError: undefined is not an object (evaluating 'd[e].call')", culprit: 's(chunks/webpack)', count: '6', userCount: '3' };
  assert.equal(classifyIssue(safari, ev([chunk('webpack-ac2c76546faf8362'), chunk('5357-33740d9e281866b7')])).noise, true);
  const firefox = { title: 'TypeError: e[o] is undefined', culprit: 'a(chunks/webpack)', count: '1', userCount: '1' };
  assert.equal(isStaleDeployIssue(firefox, ev([chunk('webpack-abc')])), true);
  assert.equal(isStaleDeployIssue({ ...safari, title: "TypeError: undefined is not an object (evaluating '$[e].call')" }, ev([chunk('webpack-x')])), true);
});

test("a 'reading call' bug that is NOT in the webpack runtime stays real", () => {
  const issue = { title: "TypeError: Cannot read properties of undefined (reading 'call')", culprit: 'onClick(chunks/app)', count: '8', userCount: '4' };
  const r = classifyIssue(issue, ev([chunk('app-123', 40)]));
  assert.equal(r.noise, false);
  assert.equal(isStaleDeployIssue(issue, null), false);
});

test('with no latest event, the webpack culprit alone identifies the stale-deploy crash', () => {
  assert.equal(isStaleDeployIssue({ title: "TypeError: Cannot read properties of undefined (reading 'call')", culprit: 'a(chunks/webpack)' }, null), true);
});

test('any other TypeError from our code is no longer auto-ignored by its message', () => {
  const issue = { title: "TypeError: Cannot read properties of undefined (reading 'map')", culprit: 'List(chunks/app)', count: '8', userCount: '4' };
  assert.equal(classifyIssue(issue, ev([chunk('app-123', 40)])).noise, false);
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

test('a .js bundle frame on our domain past line 20 stays real (only bare document URLs are injected)', () => {
  const r = classifyIssue({ title: 'RangeError: Maximum call stack size exceeded.', culprit: 'x', count: '5', userCount: '3' }, ev([chunk('app-123', 500)]));
  assert.equal(r.noise, false);
});

test('a page URL with a query string or hash is still treated as the document', () => {
  const r = classifyIssue({ title: 'RangeError: Maximum call stack size exceeded.', culprit: 'x', count: '3', userCount: '1' }, ev([doc('/lists/box-office-gold/all-time?ref=x#top', 225)]));
  assert.equal(r.noise, true);
});

// Real titles from BROADWAY-SCORECARD-A (iOS Safari, frame "global code" at /browse/...:1:3) and -2D (KaiOS Firefox 84).
test('known injected / ancient-engine errors are noise even when their frame is on our domain', () => {
  const g = classifyIssue({ title: "ReferenceError: Can't find variable: _G", culprit: 'global code(browse/short-broadway-shows)', count: '11', userCount: '2' }, ev([doc('/browse/short-broadway-shows', 1)]));
  assert.equal(g.noise, true);
  const k = classifyIssue({ title: 'SyntaxError: private fields are not currently supported', culprit: '?(chunks/7757)', count: '1', userCount: '1' }, ev([chunk('7757-abc', 1)]));
  assert.equal(k.noise, true);
});
