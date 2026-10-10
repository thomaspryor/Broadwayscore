'use strict';
/**
 * Static guard: every file that PARSES schema.org JSON-LD must route the
 * parsed payload through scripts/lib/jsonld.js, never hand-roll
 * `Array.isArray(parsed) ? parsed : [parsed]`.
 *
 * WHY A STATIC GUARD AND NOT A UNIT TEST: the Rhinoceros miss (2026-08-24) was
 * invisible to unit tests because the synthetic fixture was MORE GENEROUS than
 * the real site — it emitted both a `article:published_time` meta tag and a
 * top-level NewsArticle, so it passed no matter how the JSON-LD was walked.
 * A behavioural test only ever proves the shapes someone thought to write a
 * fixture for. This proves the property for every parse site at once, and
 * fails at authoring time on the NEXT one somebody adds.
 *
 * DETECTION: a file is a "JSON-LD parser" when a `application/ld+json`
 * reference is followed within PROXIMITY_CHARS by a `JSON.parse(`. Proximity
 * (rather than "file mentions both") is what keeps gather-reviews.js out —
 * it names the selector once in a Playwright waitForSelector and JSON.parses
 * unrelated files thousands of lines away.
 *
 * Such a file passes when it requires ./jsonld (or is jsonld.js itself, or is
 * explicitly exempt below with a reason).
 */

const path = require('path');

/** Chars after an `application/ld+json` hit within which a JSON.parse counts. */
const PROXIMITY_CHARS = 400;

const LD_JSON_RE = /application\/ld\+json/g;
const REQUIRES_HELPER_RE = /require\(\s*['"][^'"]*\/?jsonld(?:\.js)?['"]\s*\)/;
const IMPORTS_HELPER_RE = /from\s+['"][^'"]*\/?jsonld(?:\.js)?['"]/;

/**
 * Files that reference-and-parse but must NOT be required to use the helper,
 * each with the reason. Keep this list short and justified — an entry here is
 * a hole in the guard.
 */
const EXEMPT = new Map([
  ['scripts/lib/jsonld.js', 'is the helper'],
  ['scripts/lib/audit-jsonld-graph.js', 'is this guard (names the pattern it forbids)'],
]);

/**
 * Files whose JSON-LD parse runs inside `page.evaluate()` — a BROWSER context,
 * which cannot require() a Node module. These cannot use the helper, so the
 * guard holds them to the underlying property instead: every ld+json parse
 * site in them must handle `@graph` inline. That keeps the exemption honest —
 * if someone strips the inline handling, this still fails.
 */
const BROWSER_CONTEXT = new Map([
  [
    'scripts/verify-showscore-stars.js',
    'ratingValue lookup runs inside page.evaluate(); its findRating recurses through @graph',
  ],
  [
    'scripts/lib/dom-article-extractor.js',
    'the whole function is serialized via .toString() into page.evaluate() — a require() ' +
      'would not survive serialization (see its own header warning); handles @graph inline',
  ],
]);

/** Test files may construct deliberately malformed JSON-LD to assert handling. */
function isTestFile(rel) {
  return /\.test\.(mjs|js|ts)$/.test(rel);
}

/**
 * Does this source parse JSON-LD (a ld+json reference closely followed by a
 * JSON.parse)? Pure string scan — no AST, so it works on .js/.mjs/.ts alike.
 * @param {string} src
 * @returns {boolean}
 */
function parsesJsonLd(src) {
  const text = String(src || '');
  LD_JSON_RE.lastIndex = 0;
  let m;
  while ((m = LD_JSON_RE.exec(text)) !== null) {
    const window = text.slice(m.index, m.index + PROXIMITY_CHARS);
    if (window.includes('JSON.parse(')) return true;
  }
  return false;
}

/**
 * Does this source route through the shared helper?
 * @param {string} src
 * @returns {boolean}
 */
function usesHelper(src) {
  const text = String(src || '');
  return REQUIRES_HELPER_RE.test(text) || IMPORTS_HELPER_RE.test(text);
}

/**
 * The hand-rolled flattener this guard exists to eliminate. Reported as the
 * concrete line to replace, so the failure message is actionable rather than
 * just "this file is wrong".
 * @param {string} src
 * @returns {string|null} the offending snippet, or null
 */
function findHandRolledFlatten(src) {
  const m = String(src || '').match(
    /Array\.isArray\(\s*(\w+)\s*\)\s*\?\s*\1\s*:\s*\[\s*\1\s*\]/
  );
  return m ? m[0] : null;
}

/**
 * True when EVERY ld+json parse site in the source handles `@graph` within its
 * proximity window. Only meaningful for browser-context files, which cannot
 * import the shared helper.
 * @param {string} src
 * @returns {boolean}
 */
function handlesGraphAtEveryParseSite(src) {
  const text = String(src || '');
  LD_JSON_RE.lastIndex = 0;
  let m;
  let sites = 0;
  while ((m = LD_JSON_RE.exec(text)) !== null) {
    const window = text.slice(m.index, m.index + PROXIMITY_CHARS);
    if (!window.includes('JSON.parse(')) continue;
    sites += 1;
    // The inline handler may sit just past the parse, so widen for this check.
    const wide = text.slice(m.index, m.index + PROXIMITY_CHARS * 4);
    if (!wide.includes('@graph')) return false;
  }
  return sites > 0;
}

/**
 * Audit a set of files.
 *
 * @param {string[]} files - repo-relative paths
 * @param {(rel: string) => string} readFile - returns file contents
 * @returns {{file: string, reason: string, snippet: string|null}[]} offenders
 */
function findUnsafeJsonLdParsers(files, readFile) {
  const offenders = [];
  for (const rel of files) {
    const norm = rel.split(path.sep).join('/');
    if (EXEMPT.has(norm)) continue;
    if (isTestFile(norm)) continue;

    let src;
    try {
      src = readFile(rel);
    } catch {
      continue; // unreadable file is the caller's problem, not this guard's
    }
    if (!parsesJsonLd(src)) continue;
    if (usesHelper(src)) continue;

    if (BROWSER_CONTEXT.has(norm)) {
      if (handlesGraphAtEveryParseSite(src)) continue;
      offenders.push({
        file: norm,
        reason:
          'runs in a browser context so cannot use the helper, but a parse ' +
          'site no longer handles @graph inline',
        snippet: findHandRolledFlatten(src),
      });
      continue;
    }

    offenders.push({
      file: norm,
      reason:
        'parses JSON-LD without scripts/lib/jsonld.js — a @graph-wrapped ' +
        'payload (Playbill, any Yoast site) would be silently invisible',
      snippet: findHandRolledFlatten(src),
    });
  }
  return offenders;
}

module.exports = {
  PROXIMITY_CHARS,
  EXEMPT,
  BROWSER_CONTEXT,
  handlesGraphAtEveryParseSite,
  parsesJsonLd,
  usesHelper,
  findHandRolledFlatten,
  findUnsafeJsonLdParsers,
};
