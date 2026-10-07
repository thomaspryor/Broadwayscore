import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  extractFunctionSignatures,
  extractFunctionBodies,
  findBudgetParamIndex,
  getLibRequires,
  getModuleExportNames,
  countTopLevelArgs,
  callArgCounts,
  functionBodyHasRiskyLoop,
  findBudgetThreadingGaps,
  stripComments,
  hasRiskyLoop,
  extractBracedBody,
  collectFindings,
} = require('./audit-run-budget-coverage.js');

// --- regex-literal awareness in findMatching / stripComments -------------

// Regression: an unescaped brace inside a regex literal's character class
// (`/\{\{/`) is idiomatic HTML/wiki-markup scrubbing in this repo
// (scripts/lib/wiki-utils.js), and unskipped it desyncs findMatching's
// depth counter exactly like an unskipped string would. Verified live: this
// swallowed 2 of wiki-utils.js's 3 top-level functions into a sibling's body
// before the fix (adversarial review, BRO-109).
test('extractFunctionBodies does not let an unbalanced brace inside a regex literal desync function extraction', () => {
  const src = [
    'function stripBraces(s) {',
    "  return s.replace(/\\{\\{/g, '').replace(/\\}\\}/g, '');",
    '}',
    'function second(s) {',
    '  return s.trim();',
    '}',
  ].join('\n');
  const names = extractFunctionBodies(src).map((f) => f.name);
  assert.deepEqual(names, ['stripBraces', 'second']);
});

test('a regex character class containing an unescaped brace does not desync extractBracedBody on the real wiki-utils.js file', () => {
  const fs = require('fs');
  const path = require('path');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'wiki-utils.js'), 'utf8');
  const names = extractFunctionBodies(src).map((f) => f.name);
  assert.ok(names.length >= 3, `expected at least 3 top-level functions, got: ${names.join(', ')}`);
});

test('division after an identifier is NOT misread as a regex literal (would swallow real code as "regex")', () => {
  const src = 'function f(a, b) { const ratio = a / b; return fetchPage(ratio) / 2; }';
  const [fn] = extractFunctionBodies(src);
  assert.equal(fn.name, 'f');
  assert.ok(fn.body.includes('fetchPage(ratio)'), fn.body);
  assert.ok(fn.body.trim().endsWith('/ 2;'), fn.body);
});

test('stripComments does not misread an unbalanced brace inside a regex as real code needing comment treatment', () => {
  const src = "const clean = s.replace(/\\{\\{/g, ''); // trailing comment";
  const cleaned = stripComments(src);
  assert.ok(cleaned.includes("s.replace(/\\{\\{/g, '')"));
  assert.ok(!cleaned.includes('trailing comment'));
});

// --- findMatching (via extractBracedBody) — backtick-aware brace matching -

// Regression: findMatching's own comment-detection has the SAME bug as
// stripComments did — a raw `//` inside backtick template TEXT (a URL) must
// not be misread as a line comment. Before the fix, this desynced the whole
// scan: findMatching jumped past end-of-string looking for a newline that
// doesn't exist, returned null, and extractBracedBody (and therefore every
// loop/function extraction downstream of it) silently saw NOTHING after the
// URL — not just for this one loop, but for the rest of the file.
test('extractBracedBody finds the correct closing brace past a backtick URL', () => {
  const src = 'function f() { const u = `https://api.example.com/x`; return 1; }';
  const body = extractBracedBody(src, src.indexOf('{'));
  assert.equal(body, ' const u = `https://api.example.com/x`; return 1; ');
});

test('extractBracedBody still counts real nested braces inside a ${...} interpolation', () => {
  const src = 'function f() { const u = `${ { a: 1 } }`; return 1; }';
  const body = extractBracedBody(src, src.indexOf('{'));
  assert.equal(body, ' const u = `${ { a: 1 } }`; return 1; ');
});

test('extractBracedBody handles multiple backtick literals with URLs in the same body', () => {
  const src = [
    'function f() {',
    '  const a = `https://a.example.com/x`;',
    '  const b = `https://b.example.com/y`;',
    '  return fetchPage(a) + fetchPage(b);',
    '}',
  ].join('\n');
  const body = extractBracedBody(src, src.indexOf('{'));
  assert.ok(body.includes('fetchPage(a) + fetchPage(b)'), body);
});

// --- extractFunctionSignatures -------------------------------------------

test('extractFunctionSignatures captures params for async function declarations', () => {
  const src = `async function batchScrapeAgeRecommendations(runtimeEntries, shows, enrichments, budget = null) {\n  return 1;\n}`;
  const [fn] = extractFunctionSignatures(src);
  assert.equal(fn.name, 'batchScrapeAgeRecommendations');
  assert.deepEqual(fn.params, ['runtimeEntries', 'shows', 'enrichments', 'budget']);
});

test('extractFunctionSignatures captures params for const-assigned async arrow functions', () => {
  const src = `const batchDiscoverSlugs = async (siteDomain, shows, pathPrefix, delayMs = 3000, budget = null) => {\n  return 1;\n};`;
  const [fn] = extractFunctionSignatures(src);
  assert.equal(fn.name, 'batchDiscoverSlugs');
  assert.deepEqual(fn.params, ['siteDomain', 'shows', 'pathPrefix', 'delayMs', 'budget']);
});

// Regression: a default param value that itself contains parens — an inline
// arrow function default — must not truncate the param list at the arrow's
// OWN `()`. A naive `\([^)]*\)` regex stops at the first `)`, which lands
// inside `onProgress = ()`, so the whole function silently fails to match at
// all — a risky helper with this shape would be invisible to the BRO-109
// threading check (false negative), not just mis-parsed.
test('extractFunctionSignatures handles a default param value containing its own parens', () => {
  const src = `async function batchThing(items, onProgress = () => {}, budget = null) {\n  return 1;\n}`;
  const sigs = extractFunctionSignatures(src);
  const fn = sigs.find((f) => f.name === 'batchThing');
  assert.ok(fn, 'batchThing must still be found');
  assert.deepEqual(fn.params, ['items', 'onProgress', 'budget']);
});

// --- findBudgetParamIndex -------------------------------------------------

test('findBudgetParamIndex finds a budget param that is actually checked via .exceeded()', () => {
  const src = `async function f(a, b, budget = null) {\n  for (const x of a) {\n    if (budget && budget.exceeded()) break;\n  }\n}`;
  const [fn] = extractFunctionSignatures(src);
  assert.equal(findBudgetParamIndex(fn), 2);
});

test('findBudgetParamIndex returns -1 when no param looks budget-shaped', () => {
  const src = `async function f(a, b) {\n  return a + b;\n}`;
  const [fn] = extractFunctionSignatures(src);
  assert.equal(findBudgetParamIndex(fn), -1);
});

test('findBudgetParamIndex returns -1 when a budget-named param exists but is never checked (dead param, not real support)', () => {
  const src = `async function f(a, budget = null) {\n  console.log(budget);\n  return a;\n}`;
  const [fn] = extractFunctionSignatures(src);
  assert.equal(findBudgetParamIndex(fn), -1);
});

test('findBudgetParamIndex handles optional-chaining .exceeded() checks', () => {
  const src = `async function f(a, timeBudget) {\n  while (true) {\n    if (timeBudget?.exceeded()) break;\n  }\n}`;
  const [fn] = extractFunctionSignatures(src);
  assert.equal(findBudgetParamIndex(fn), 1);
});

// --- getLibRequires / getModuleExportNames --------------------------------

test('getLibRequires parses destructured local lib requires (exported === local when unaliased)', () => {
  const src = `const { batchScrapeAgeRecommendations, scrapeCurrentRuntimes } = require('./lib/broadway-com-runtimes');\nconst { cleanup } = require('./lib/scraper');`;
  const reqs = getLibRequires(src);
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs[0], {
    names: [
      { exported: 'batchScrapeAgeRecommendations', local: 'batchScrapeAgeRecommendations' },
      { exported: 'scrapeCurrentRuntimes', local: 'scrapeCurrentRuntimes' },
    ],
    relPath: 'broadway-com-runtimes',
  });
  assert.deepEqual(reqs[1], { names: [{ exported: 'cleanup', local: 'cleanup' }], relPath: 'scraper' });
});

test('getLibRequires ignores non-local requires (npm packages, node builtins)', () => {
  const src = `const fs = require('fs');\nconst { foo } = require('some-npm-package');`;
  assert.deepEqual(getLibRequires(src), []);
});

test('getLibRequires separates exported name from local alias — `exported: local` destructure', () => {
  const src = `const { batchScrapeAgeRecommendations: batchScrape } = require('./lib/broadway-com-runtimes');`;
  const reqs = getLibRequires(src);
  assert.deepEqual(reqs[0].names, [{ exported: 'batchScrapeAgeRecommendations', local: 'batchScrape' }]);
});

test('getModuleExportNames parses a shorthand export list', () => {
  const src = `module.exports = {\n  discoverSlug,\n  batchDiscoverSlugs,\n};`;
  assert.deepEqual([...getModuleExportNames(src)], ['discoverSlug', 'batchDiscoverSlugs']);
});

// Regression: a nested object VALUE in the export list must not truncate
// parsing at its own inner `}` — a naive `[^}]*` regex stops there and
// silently drops every export named after it.
test('getModuleExportNames does not truncate at a nested object value', () => {
  const src = `module.exports = {\n  batchDiscoverSlugs,\n  CONFIG: { retries: 3 },\n  discoverSlug,\n};`;
  assert.deepEqual([...getModuleExportNames(src)], ['batchDiscoverSlugs', 'CONFIG', 'discoverSlug']);
});

// --- countTopLevelArgs / callArgCounts ------------------------------------

test('countTopLevelArgs ignores commas nested in parens, brackets, braces, and strings', () => {
  assert.equal(countTopLevelArgs(''), 0);
  assert.equal(countTopLevelArgs('a, b, c'), 3);
  assert.equal(countTopLevelArgs('a, fn(x, y), b'), 3);
  assert.equal(countTopLevelArgs('a, { x: 1, y: 2 }, b'), 3);
  assert.equal(countTopLevelArgs(`a, 'x, y', b`), 3);
});

test('callArgCounts finds every call site and its arg count', () => {
  const src = `foo(a, b);\ndoStuff();\nfoo(a, b, c, opts);`;
  assert.deepEqual(callArgCounts(src, 'foo'), [2, 4]);
});

// --- functionBodyHasRiskyLoop / stripComments -----------------------------

test('functionBodyHasRiskyLoop is true for a direct network call in a for-loop', () => {
  const libSrc = `async function batchThing(items) {\n  for (const item of items) {\n    await fetchPage(item.url);\n  }\n}`;
  const [fn] = extractFunctionSignatures(libSrc);
  assert.equal(functionBodyHasRiskyLoop(fn.body, libSrc), true);
});

test('functionBodyHasRiskyLoop is true via one-hop indirection through a sibling helper in the same lib file', () => {
  const libSrc = [
    `async function discoverOne(url) {`,
    `  return fetchPage(url);`,
    `}`,
    `async function batchDiscover(urls) {`,
    `  for (const url of urls) {`,
    `    await discoverOne(url);`,
    `  }`,
    `}`,
  ].join('\n');
  const sigs = extractFunctionSignatures(libSrc);
  const fn = sigs.find((f) => f.name === 'batchDiscover');
  assert.equal(functionBodyHasRiskyLoop(fn.body, libSrc), true);
});

test('functionBodyHasRiskyLoop is false when the loop is explicitly bounded via .slice()', () => {
  const libSrc = `async function batchThing(items) {\n  for (const item of items.slice(0, 5)) {\n    await fetchPage(item.url);\n  }\n}`;
  const [fn] = extractFunctionSignatures(libSrc);
  assert.equal(functionBodyHasRiskyLoop(fn.body, libSrc), false);
});

test('functionBodyHasRiskyLoop is false when the loop body has no network call at all', () => {
  const libSrc = `function batchThing(items) {\n  for (const item of items) {\n    console.log(item);\n  }\n}`;
  const [fn] = extractFunctionSignatures(libSrc);
  assert.equal(functionBodyHasRiskyLoop(fn.body, libSrc), false);
});

// Regression: scripts/lib/review-write-guard.js#safeWriteReview matched via a
// prose comment ("fetchPage() unwraps at FETCH time") elsewhere in the same
// file — extractFunctionBodies() found safeWriteReview "networky" purely
// because NETWORK_CALL_RE matched inside a docstring, and a later loop
// referencing safeWriteReview by name (also possibly in a comment) tripped
// the one-hop indirection check. A big, heavily-documented lib file with zero
// actual network calls got reported as having an unbounded network loop.
test('a docstring mentioning a network-call-shaped name does not create a false "networky" function', () => {
  const libSrc = [
    `// fetchPage() unwraps at FETCH time, unrelated comment text here.`,
    `function safeWriteReview(filePath, data) {`,
    `  for (const key of Object.keys(data)) {`,
    `    if (key === 'retry') safeWriteReview(filePath, data);`,
    `  }`,
    `  return true;`,
    `}`,
  ].join('\n');
  const [fn] = extractFunctionSignatures(libSrc);
  assert.equal(functionBodyHasRiskyLoop(fn.body, libSrc), false);
});

test('stripComments blanks // and /* */ comments but leaves string literals intact', () => {
  const src = [
    `const a = 'keep this // not a comment';`,
    `// a real comment mentioning fetchPage()`,
    `/* a block comment with fetchPage() too */`,
    `const b = fetchPage(url);`,
  ].join('\n');
  const cleaned = stripComments(src);
  assert.ok(cleaned.includes(`'keep this // not a comment'`));
  assert.ok(!cleaned.includes('a real comment'));
  assert.ok(!cleaned.includes('a block comment'));
  assert.ok(cleaned.includes('fetchPage(url)'));
  assert.equal(cleaned.length, src.length);
});

test('hasRiskyLoop (whole-script check) still works after comment-stripping was added', () => {
  assert.equal(hasRiskyLoop(`for (const x of xs) { await fetchPage(x); }`), true);
  assert.equal(hasRiskyLoop(`// await fetchPage(x) mentioned only in a comment\nfor (const x of xs) { console.log(x); }`), false);
});

// Regression (adversarial code-review, BRO-109): a template literal NESTED
// inside another template literal's ${...} interpolation — `` `outer
// ${`inner`} end` `` — must not mis-pair the outer literal's closing
// backtick with the inner literal's opening one. Before the fix,
// stripComments treated backticks as plain quoted strings (skip to the next
// backtick unconditionally), so it paired backtick 1 with backtick 2 (the
// INNER literal's open), leaving "end`" to be scanned as ordinary code and
// corrupting parsing of everything after it on the same line.
test('stripComments does not mis-pair a nested template literal inside a ${...} interpolation', () => {
  const src = 'for (const x of xs) { const u = `outer ${`http://inner`} end`; await fetchPage(x); }';
  const cleaned = stripComments(src);
  assert.ok(cleaned.includes('await fetchPage(x)'), cleaned);
  assert.equal(hasRiskyLoop(src), true);
});

// Regression: a bare URL inside a backtick template literal — `https://x` —
// contains a literal `//` that stripComments's line-comment check must NOT
// treat as a comment start; doing so blanked the rest of the line, including
// a real fetchPage() call appearing after the URL on the SAME line. A false
// negative here (a hidden real network call) is worse than the false
// positive of under-stripping a rare comment nested inside a template
// literal's ${...}, so backtick content is now copied verbatim like a
// regular string, never scanned for // or /* */.
test('a bare URL inside a backtick template literal does not get misread as a line comment', () => {
  const src = 'for (const x of xs) { const r = await fetchPage(`https://api.example.com/${x}`); }';
  const cleaned = stripComments(src);
  assert.ok(cleaned.includes('fetchPage(`https://api.example.com/${x}`)'), cleaned);
  assert.equal(hasRiskyLoop(src), true);
});

test('a comment AFTER a backtick URL on the same line is still stripped', () => {
  const src = [
    'for (const x of xs) {',
    '  const url = `https://api.example.com/${x}`; // fetch it',
    '  await fetchPage(url);',
    '}',
  ].join('\n');
  const cleaned = stripComments(src);
  assert.ok(!cleaned.includes('// fetch it'));
  assert.ok(cleaned.includes('`https://api.example.com/${x}`'));
});

// --- findBudgetThreadingGaps: the end-to-end BRO-109 check ----------------

const BATCH_HELPER_LIB = [
  `async function batchScrapeAgeRecommendations(entries, shows, enrichments, budget = null) {`,
  `  for (const entry of entries) {`,
  `    if (budget && budget.exceeded()) break;`,
  `    await fetchPage(entry.url);`,
  `  }`,
  `}`,
  `module.exports = { batchScrapeAgeRecommendations };`,
].join('\n');

test('flags "not-passed": helper supports a budget param but the call site omits it', () => {
  const scriptSrc = [
    `const { batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');`,
    `await batchScrapeAgeRecommendations(currentEntries, shows, enrichments);`,
  ].join('\n');
  const gaps = findBudgetThreadingGaps(scriptSrc, { 'broadway-com-runtimes': BATCH_HELPER_LIB });
  assert.deepEqual(gaps, [{ name: 'batchScrapeAgeRecommendations', relPath: 'broadway-com-runtimes', reason: 'not-passed' }]);
});

test('does not flag when the call site threads the budget through', () => {
  const scriptSrc = [
    `const { batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');`,
    `await batchScrapeAgeRecommendations(currentEntries, shows, enrichments, budget);`,
  ].join('\n');
  const gaps = findBudgetThreadingGaps(scriptSrc, { 'broadway-com-runtimes': BATCH_HELPER_LIB });
  assert.deepEqual(gaps, []);
});

// A short call site still leaves the helper's loop with no way to stop early
// even if a SIBLING call site threads the budget correctly — flag it (a
// missed short call site is a worse failure mode than the extra noise of
// flagging a genuinely-safe second call site).
test('flags "not-passed" when ANY call site omits the budget, even if another call site includes it', () => {
  const scriptSrc = [
    `const { batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');`,
    `await batchScrapeAgeRecommendations(a, b, c);`,
    `await batchScrapeAgeRecommendations(a, b, c, budget);`,
  ].join('\n');
  const gaps = findBudgetThreadingGaps(scriptSrc, { 'broadway-com-runtimes': BATCH_HELPER_LIB });
  assert.deepEqual(gaps, [{ name: 'batchScrapeAgeRecommendations', relPath: 'broadway-com-runtimes', reason: 'not-passed' }]);
});

// Regression: a JSDoc example call mentioning the full-arg-count call must
// not count as a real call site — that would mask a genuine short call site
// elsewhere in the same script (false negative).
test('a call site mentioned only in a comment does not mask a real short call site', () => {
  const scriptSrc = [
    `const { batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');`,
    `// e.g. batchScrapeAgeRecommendations(entries, shows, enrichments, budget)`,
    `await batchScrapeAgeRecommendations(currentEntries, shows, enrichments);`,
  ].join('\n');
  const gaps = findBudgetThreadingGaps(scriptSrc, { 'broadway-com-runtimes': BATCH_HELPER_LIB });
  assert.deepEqual(gaps, [{ name: 'batchScrapeAgeRecommendations', relPath: 'broadway-com-runtimes', reason: 'not-passed' }]);
});

test('resolves a require reached via ../lib/ from a one-level-deep subdirectory script', () => {
  const scriptSrc = [
    `const { batchScrapeAgeRecommendations } = require('../lib/broadway-com-runtimes');`,
    `await batchScrapeAgeRecommendations(currentEntries, shows, enrichments);`,
  ].join('\n');
  const gaps = findBudgetThreadingGaps(scriptSrc, { 'broadway-com-runtimes': BATCH_HELPER_LIB });
  assert.deepEqual(gaps, [{ name: 'batchScrapeAgeRecommendations', relPath: 'broadway-com-runtimes', reason: 'not-passed' }]);
});

// Regression: an aliased destructure (`exported: local`, a real pattern in
// this repo — e.g. `fetchPage: fetchPageScraper`) must be flagged by
// searching the script for the LOCAL alias's call sites, not the lib file's
// exported name — the script never contains the exported name as a literal
// call, so searching for that name found zero call sites and silently
// reported no gap at all.
test('flags "not-passed" through an aliased destructure import (exported name != local call-site name)', () => {
  const scriptSrc = [
    `const { batchScrapeAgeRecommendations: batchScrape } = require('./lib/broadway-com-runtimes');`,
    `await batchScrape(currentEntries, shows, enrichments);`,
  ].join('\n');
  const gaps = findBudgetThreadingGaps(scriptSrc, { 'broadway-com-runtimes': BATCH_HELPER_LIB });
  assert.deepEqual(gaps, [{ name: 'batchScrapeAgeRecommendations', relPath: 'broadway-com-runtimes', reason: 'not-passed' }]);
});

test('flags "unsupported": helper has a risky loop with no budget param at all', () => {
  const libSrc = [
    `async function batchDiscoverSlugs(shows) {`,
    `  for (const show of shows) {`,
    `    await fetchPage(show.url);`,
    `  }`,
    `}`,
    `module.exports = { batchDiscoverSlugs };`,
  ].join('\n');
  const scriptSrc = [
    `const { batchDiscoverSlugs } = require('./lib/serp-slug-discovery');`,
    `await batchDiscoverSlugs(notFound);`,
  ].join('\n');
  const gaps = findBudgetThreadingGaps(scriptSrc, { 'serp-slug-discovery': libSrc });
  assert.deepEqual(gaps, [{ name: 'batchDiscoverSlugs', relPath: 'serp-slug-discovery', reason: 'unsupported' }]);
});

test('does not flag a helper whose loop is explicitly bounded', () => {
  const libSrc = [
    `async function batchThing(items) {`,
    `  for (const item of items.slice(0, 5)) {`,
    `    await fetchPage(item.url);`,
    `  }`,
    `}`,
    `module.exports = { batchThing };`,
  ].join('\n');
  const scriptSrc = [
    `const { batchThing } = require('./lib/some-lib');`,
    `await batchThing(items);`,
  ].join('\n');
  assert.deepEqual(findBudgetThreadingGaps(scriptSrc, { 'some-lib': libSrc }), []);
});

test('does not flag an imported name the lib file does not actually export', () => {
  const libSrc = [
    `async function internalOnly(items) {`,
    `  for (const item of items) { await fetchPage(item.url); }`,
    `}`,
    `module.exports = {};`,
  ].join('\n');
  const scriptSrc = [
    `const { internalOnly } = require('./lib/some-lib');`,
    `await internalOnly(items);`,
  ].join('\n');
  assert.deepEqual(findBudgetThreadingGaps(scriptSrc, { 'some-lib': libSrc }), []);
});

test('returns [] when the script has no local lib requires', () => {
  assert.deepEqual(findBudgetThreadingGaps(`console.log('hi');`, {}), []);
});

test('returns [] when a required lib file was not resolvable (not in the provided map)', () => {
  const scriptSrc = `const { foo } = require('./lib/missing-lib');\nfoo();`;
  assert.deepEqual(findBudgetThreadingGaps(scriptSrc, {}), []);
});

// --- collectFindings: end-to-end regression against the live corpus (BRO-107) ---

// The job-vs-step blind-spot fix (#425, commits 6b849750994/50958ae36ca)
// re-run against the live .github/workflows/ corpus surfaced 8 scripts
// missing scripts/lib/run-budget.js plus one script→lib-helper threading
// gap (audit-opening-dates.js -> closing-date-discovery.js#discoverAnnouncedDate).
// BRO-107 wired run-budget.js into all of them (see git history for the list).
// This asserts the audit now sees the live corpus as clean — a regression
// here means either a wiring reverted or a new unguarded candidate was added
// without run-budget.js.
test('collectFindings reports zero candidates against the live .github/workflows/ + scripts/ corpus', () => {
  const { warnings, threadingWarnings } = collectFindings();
  assert.deepEqual(warnings, []);
  assert.deepEqual(threadingWarnings, []);
});
