const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyIssue, isStaleDeployIssue } = require('../../scripts/lib/sentry-triage-classify.js');

const ev = frames => ({ entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames } }] } }] });
// Real Sentry shape: `filename` is the RELATIVE path, `absPath` the full URL
// (BRO-7722: fixtures with a full-URL filename hid that real events never match).
const chunk = (name, lineNo = 1) => ({ filename: `/_next/static/chunks/${name}.js`, absPath: `https://broadwayscorecard.com/_next/static/chunks/${name}.js`, lineNo, colNo: 143, inApp: true });
const doc = (path, lineNo) => ({ filename: path.replace(/[?#].*$/, ''), absPath: `https://broadwayscorecard.com${path}`, lineNo, colNo: 63, inApp: true });

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

// --- BRO-7722: real shapes from the 2026-11 issues that were all wrongly ignored ---

test('UgcError from our bundles (relative filename, absPath on our domain) is REAL', () => {
  // BROADWAY-SCORECARD-35: UGC insert reviews failed (23503), 5 users.
  const issue = { title: 'UgcError: UGC insert reviews failed (23503)', culprit: 'y(chunks/20993)', count: '5', userCount: '5' };
  const frames = [
    { ...chunk('82344-5729705db6f36412'), function: null },
    { ...chunk('5174-c22701ffd1066681'), function: 'async f' },
    { ...chunk('20993-096a3ed9af0a336a'), function: 'y' },
  ];
  const r = classifyIssue(issue, ev(frames));
  assert.equal(r.noise, false, r.reason);
});

test('history.replaceState flood with our frames + Sentry CDN frame is REAL', () => {
  const issue = { title: 'SecurityError: Attempt to use history.replaceState() more than 100 times per 10 seconds', culprit: '?(chunks/b468fba8)', count: '2', userCount: '2' };
  const frames = [
    { ...chunk('4bd1b696-989fb15544b4f183'), function: 'ug' },
    { filename: '../../../browser-utils/build/esm/instrument/history.js', absPath: 'https://browser.sentry-cdn.com/browser-utils/build/esm/instrument/history.js', lineNo: 57, function: '<anonymous>' },
    { filename: '[native code]', absPath: '[native code]', function: 'replaceState', inApp: false },
  ];
  assert.equal(classifyIssue(issue, ev(frames)).noise, false);
});

test('a SyntaxError parsing one of our bundles (truncated download / crawler) is noise', () => {
  // BROADWAY-SCORECARD-37: 50 events, 50 "users", all Chrome 133.0.6943 Windows.
  const issue = { title: 'SyntaxError: missing ) after argument list', culprit: '?(chunks/b468fba8)', count: '50', userCount: '50' };
  const f = { filename: '/_next/static/chunks/b468fba8.47bfaad1005addc2.js', absPath: 'https://broadwayscorecard.com/_next/static/chunks/b468fba8.47bfaad1005addc2.js?dpl=7c66', lineNo: 2, function: null, inApp: true };
  const r = classifyIssue(issue, ev([f]));
  assert.equal(r.noise, true);
  assert.match(r.reason, /failed to parse/);
});

test('a SyntaxError raised inside a named function of ours (e.g. JSON.parse) stays out of the parse-error rule', () => {
  const issue = { title: 'SyntaxError: Unexpected end of JSON input', culprit: 'load(chunks/app)', count: '9', userCount: '6' };
  const f = { ...chunk('app-1', 1), function: 'load' };
  assert.equal(require('../../scripts/lib/sentry-triage-classify.js').isBundleParseError(issue, [f]), false);
});

test('frameUrl prefers the absolute URL and resolves a bare /_next path to our origin', () => {
  const { frameUrl } = require('../../scripts/lib/sentry-triage-classify.js');
  assert.equal(frameUrl({ filename: '/_next/static/chunks/a.js', absPath: 'https://broadwayscorecard.com/_next/static/chunks/a.js' }), 'https://broadwayscorecard.com/_next/static/chunks/a.js');
  assert.equal(frameUrl({ filename: '/_next/static/chunks/a.js' }), 'https://broadwayscorecard.com/_next/static/chunks/a.js');
  assert.equal(frameUrl({ filename: '[native code]', absPath: '[native code]' }), '[native code]');
});

test('parse errors that mean unsupported syntax (not truncation) stay REAL', () => {
  const lookbehind = { title: 'SyntaxError: Invalid regular expression: invalid group specifier name', culprit: '?(chunks/app)', count: '400', userCount: '300' };
  const f = { ...chunk('app-9'), function: null };
  assert.equal(classifyIssue(lookbehind, ev([f])).noise, false);
  const optional = { title: "SyntaxError: Unexpected token '?'", culprit: '?(chunks/app)', count: '40', userCount: '30' };
  assert.equal(classifyIssue(optional, ev([f])).noise, false);
});

test("Safari's truncated-bundle form ('global code', query string on absPath) is noise", () => {
  const issue = { title: 'SyntaxError: Unexpected end of script', culprit: 'global code(chunks/x)', count: '3', userCount: '3' };
  const f = { filename: '/_next/static/chunks/x.js', absPath: 'https://broadwayscorecard.com/_next/static/chunks/x.js?dpl=abc', function: 'global code', lineNo: 1 };
  assert.equal(classifyIssue(issue, ev([f])).noise, true);
});

test('a frame with only a relative /_next filename (no absPath) counts as ours', () => {
  const issue = { title: 'TypeError: x is not a function', culprit: 'f(chunks/app)', count: '9', userCount: '5' };
  assert.equal(classifyIssue(issue, ev([{ filename: '/_next/static/chunks/app.js', function: 'f', lineNo: 1 }])).noise, false);
});

test('noise is ignored only until it escalates, never forever (BRO-7722)', () => {
  const { NOISE_IGNORE_BODY } = require('../../scripts/lib/sentry-triage-classify.js');
  assert.equal(NOISE_IGNORE_BODY.status, 'ignored');
  assert.ok(NOISE_IGNORE_BODY.statusDetails.ignoreUserCount > 0);
  assert.ok(NOISE_IGNORE_BODY.statusDetails.ignoreUserWindow > 0);
  const src = require('fs').readFileSync(require.resolve('../../scripts/triage-sentry.js'), 'utf8');
  assert.doesNotMatch(src, /status: 'ignored' \}/, 'triage-sentry.js must use NOISE_IGNORE_BODY, not a bare forever-ignore');
});

test('Firefox and old-Safari truncation wording is noise too', () => {
  const f = { ...chunk('x'), function: null };
  for (const title of ['SyntaxError: expected expression, got end of script', 'SyntaxError: unterminated string literal', 'SyntaxError: Unexpected EOF']) {
    assert.equal(classifyIssue({ title, culprit: '?(chunks/x)', count: '3', userCount: '3' }, ev([f])).noise, true, title);
  }
});

test('a truncation-shaped parse error hitting 200+ users stays REAL (corrupt bundle for everyone)', () => {
  const issue = { title: 'SyntaxError: missing ) after argument list', culprit: '?(chunks/x)', count: '900', userCount: '850' };
  assert.equal(classifyIssue(issue, ev([{ ...chunk('x'), function: null }])).noise, false);
});

test("an HTML page served for a chunk (Unexpected token '<') is still noise", () => {
  const issue = { title: "SyntaxError: Unexpected token '<'", culprit: '?(chunks/x)', count: '9', userCount: '9' };
  assert.equal(classifyIssue(issue, ev([{ ...chunk('x'), function: 'a' }, { ...chunk('y'), function: 'b' }])).noise, true);
});

test('PostHog SDK frames proxied through our /ingest/ path are third-party', () => {
  const issue = { title: 'SyntaxError: Invalid or unexpected token', culprit: 'clampToRange(ingest/core/dist/utils/number-utils)', count: '5', userCount: '5' };
  const f = { filename: '/ingest/core/dist/utils/number-utils.mjs', absPath: 'https://broadwayscorecard.com/ingest/core/dist/utils/number-utils.mjs', function: 'clampToRange', lineNo: 15 };
  assert.equal(classifyIssue(issue, ev([f])).noise, true);
});
