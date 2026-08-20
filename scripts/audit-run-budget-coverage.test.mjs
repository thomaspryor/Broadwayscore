import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractFunctionSignatures,
  findBudgetParamIndex,
  getLibRequires,
  getModuleExportNames,
  countTopLevelArgs,
  callArgCounts,
  functionBodyHasRiskyLoop,
  findBudgetThreadingGaps,
  stripComments,
  hasRiskyLoop,
} = require('./audit-run-budget-coverage.js');

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

test('getLibRequires parses destructured local lib requires', () => {
  const src = `const { batchScrapeAgeRecommendations, scrapeCurrentRuntimes } = require('./lib/broadway-com-runtimes');\nconst { cleanup } = require('./lib/scraper');`;
  const reqs = getLibRequires(src);
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs[0], { names: ['batchScrapeAgeRecommendations', 'scrapeCurrentRuntimes'], relPath: 'broadway-com-runtimes' });
  assert.deepEqual(reqs[1], { names: ['cleanup'], relPath: 'scraper' });
});

test('getLibRequires ignores non-local requires (npm packages, node builtins)', () => {
  const src = `const fs = require('fs');\nconst { foo } = require('some-npm-package');`;
  assert.deepEqual(getLibRequires(src), []);
});

test('getModuleExportNames parses a shorthand export list', () => {
  const src = `module.exports = {\n  discoverSlug,\n  batchDiscoverSlugs,\n};`;
  assert.deepEqual([...getModuleExportNames(src)], ['discoverSlug', 'batchDiscoverSlugs']);
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

test('does not flag when AT LEAST ONE call site threads the budget through', () => {
  const scriptSrc = [
    `const { batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');`,
    `await batchScrapeAgeRecommendations(a, b, c);`,
    `await batchScrapeAgeRecommendations(a, b, c, budget);`,
  ].join('\n');
  const gaps = findBudgetThreadingGaps(scriptSrc, { 'broadway-com-runtimes': BATCH_HELPER_LIB });
  assert.deepEqual(gaps, []);
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
