'use strict';
/**
 * BRO-7649 class guard: a Playwright screenshot baseline taken on a LIVE route
 * (production data: review counts, LLM Critics' Take, tallies) drifts whenever
 * the data does, turning main red with no code change. Every toHaveScreenshot
 * in a spec that may visit a live route must be preceded, in the same test (or
 * a beforeEach), by freezeLiveShowData() from tests/e2e/helpers/freeze-live-data.ts.
 *
 * Fail closed: a screenshot spec is exempt only when it visibly navigates to
 * mock/fixture pages and nothing else (route literals under /test/ or with
 * ?mock=1, or the goToMock/goToRatingEditor helpers). A spec whose navigation
 * this parser cannot see counts as live.
 *
 * Known limit: a freezing beforeEach counts for every test in the file, not
 * only its own describe block.
 */

const FREEZE_CALL = 'freezeLiveShowData(';
const MOCK_NAV_HELPERS = /\b(goToMock|goToRatingEditor)\(/;

/**
 * Blank out comments and string/template contents (keeping quotes, newlines and
 * length) so braces and calls inside them are not parsed as code. Template
 * `${...}` expressions are blanked too, which is fine for brace matching.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += c; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Route literals the spec navigates to: goto('/x'), goto(`/x...`), and *_URL/_PATH = '/x' constants. */
function routeLiterals(source) {
  const out = [];
  const re = /(?:goto\(\s*|_(?:URL|PATH)\s*=\s*)(['"`])(\/[^'"`]*)/g;
  let m;
  while ((m = re.exec(source))) out.push(m[2]);
  return out;
}

function isMockRoute(route) {
  return /^\/test(\/|$)/.test(route) || /[?&]mock=1/.test(route);
}

/**
 * True unless every navigation the spec shows is a mock: at least one mock
 * route literal or mock helper call, and no non-mock route literal.
 */
function visitsLiveRoute(source) {
  const code = stripCommentsAndStrings(source);
  const routes = routeLiterals(source);
  if (routes.some((r) => !isMockRoute(r))) return true;
  const mockEvidence = routes.length > 0 || MOCK_NAV_HELPERS.test(code);
  return !mockEvidence;
}

/** Index of the function body's `{` (after `=>` or `function(...)`), skipping `({ page })` destructuring. */
function bodyOpen(code, from) {
  const arrow = code.indexOf('=>', from);
  const fn = code.slice(from).search(/\bfunction\b/);
  let start = arrow;
  if (fn >= 0 && (arrow < 0 || from + fn < arrow)) {
    const close = code.indexOf(')', from + fn);
    start = close;
  }
  return start < 0 ? -1 : code.indexOf('{', start);
}

function matchBody(code, open) {
  let depth = 0;
  let i = open;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) break;
  }
  return code.slice(open, i + 1);
}

/** Split a spec into test() bodies (comments and string contents blanked). */
function testBlocks(source) {
  const code = stripCommentsAndStrings(source);
  const blocks = [];
  // Names come from the raw source (the stripped copy blanks them); the
  // backreference lets a double-quoted name contain an apostrophe.
  const re = /\btest(?:\.(?:only|skip|fixme))?\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*,/g;
  let m;
  while ((m = re.exec(source))) {
    if (code.slice(m.index, m.index + 4) !== 'test') continue; // inside a comment or string
    const open = bodyOpen(code, m.index + m[0].length);
    if (open < 0) continue;
    blocks.push({ name: m[2], start: m.index, body: matchBody(code, open) });
  }
  return blocks;
}

function beforeEachBodies(source) {
  const code = stripCommentsAndStrings(source);
  const bodies = [];
  const re = /test\.beforeEach\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = bodyOpen(code, m.index + m[0].length);
    if (open >= 0) bodies.push(matchBody(code, open));
  }
  return bodies;
}

/**
 * Returns the names of tests that screenshot a live route without first
 * freezing its data. Empty array = compliant (or not a live screenshot spec).
 */
function findUnfrozenLiveScreenshots(source) {
  const code = stripCommentsAndStrings(source);
  if (!code.includes('toHaveScreenshot') || !visitsLiveRoute(source)) return [];
  const frozenInHook = beforeEachBodies(source).some((b) => b.includes(FREEZE_CALL));
  const offenders = [];
  for (const { name, body } of testBlocks(source)) {
    const shot = body.indexOf('toHaveScreenshot');
    if (shot < 0) continue;
    const freeze = body.indexOf(FREEZE_CALL);
    if (frozenInHook || (freeze >= 0 && freeze < shot)) continue;
    offenders.push(name);
  }
  return offenders;
}

module.exports = {
  findUnfrozenLiveScreenshots,
  visitsLiveRoute,
  routeLiterals,
  isMockRoute,
  stripCommentsAndStrings,
  FREEZE_CALL,
};
