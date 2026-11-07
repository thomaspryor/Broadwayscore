#!/usr/bin/env node
/**
 * test-bww-roundup-parser.js
 *
 * Regression test for parseArticleBodyReviews — the 2026-04-26 critic-name
 * truncation fix. Confirms first-name initials like "J. Kelly Nestruck" are
 * preserved and that all other multi-word names extract unchanged.
 *
 * Includes a real-HTML fixture (the-prom-2018) that pre-fix produced "Kelly
 * Nestruck" instead of "J. Kelly Nestruck". Per CLAUDE.md rule 15, the test
 * `require()`s the production function — synthetic copies are not enough.
 *
 * Run: node scripts/test-bww-roundup-parser.js
 * Exit 0 on pass, 1 on fail.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArticleBodyReviews } = require('./lib/bww-roundup-parser');

let failed = 0;
let passed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.log(`  ✗ ${label}`); }
}

function parseFromArchive(archivePath) {
  const html = fs.readFileSync(archivePath, 'utf8');
  const scriptMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const sm of scriptMatches) {
    const cleaned = sm[1].replace(/[\x00-\x1F\x7F]/g, ' ');
    try {
      const json = JSON.parse(cleaned);
      if (json.articleBody) return parseArticleBodyReviews(json.articleBody);
      if (json['@graph']) {
        for (const g of json['@graph']) if (g.articleBody) return parseArticleBodyReviews(g.articleBody);
      }
    } catch (e) {}
  }
  return null;
}

console.log('--- Synthetic cases ---');
{
  const cases = [
    { input: 'J. Kelly Nestruck, The Globe and Mail: Lorem ipsum.', expectCritic: 'J. Kelly Nestruck' },
    { input: 'Randall David Cook, The Recs: Lorem ipsum.',          expectCritic: 'Randall David Cook' },
    { input: 'Melissa Rose Bernardo, NYSR: Lorem.',                 expectCritic: 'Melissa Rose Bernardo' },
    { input: 'Jesse Green, NYT: Lorem.',                            expectCritic: 'Jesse Green' },
    { input: 'Mary-Louise Burke, NYT: Lorem.',                      expectCritic: 'Mary-Louise Burke' },
    { input: "Laura Collins-Hughes, NYT: Lorem.",                   expectCritic: 'Laura Collins-Hughes' },
  ];
  for (const c of cases) {
    const result = parseArticleBodyReviews(c.input);
    assert(result.length === 1 && result[0].criticName === c.expectCritic,
      `${JSON.stringify(c.input.slice(0, 50))} → critic="${result[0]?.criticName ?? '(none)'}" (want "${c.expectCritic}")`);
  }
}

console.log('\n--- Two-critic boundary cases ---');
{
  const input = 'Jesse Green, NYT: First. J. Kelly Nestruck, The Globe and Mail: Second.';
  const result = parseArticleBodyReviews(input);
  assert(result.length === 2, 'two-critic input → 2 hits');
  assert(result[0]?.criticName === 'Jesse Green', `first critic Jesse Green (got "${result[0]?.criticName}")`);
  assert(result[1]?.criticName === 'J. Kelly Nestruck', `second critic J. Kelly Nestruck (got "${result[1]?.criticName}")`);
}

console.log('\n--- Sentence-ending period false positives (must not absorb as initial) ---');
{
  const cases = [
    { input: 'X, A: prev. AIDS. Joe Dziemianowicz, NY Daily News: lorem.',           wantLast: 'Joe Dziemianowicz' },
    { input: 'X, A: prev. U.K. Frank Rizzo, Variety: lorem.',                        wantLast: 'Frank Rizzo' },
    { input: 'X, A: prev. World War II. Jeremy Gerard, Deadline: lorem.',            wantLast: 'Jeremy Gerard' },
    { input: 'X, A: prev. in D.C. Adam Feldman, TimeOut: lorem.',                    wantLast: 'Adam Feldman' },
  ];
  for (const c of cases) {
    const r = parseArticleBodyReviews(c.input);
    const last = r[r.length - 1]?.criticName;
    assert(last === c.wantLast,
      `${JSON.stringify(c.input.slice(0, 60))} → last critic "${last}" (want "${c.wantLast}")`);
  }
}

console.log('\n--- Real BWW fixture: the-prom-2018 ---');
{
  const archivePath = '/Users/tompryor/broadway-review-texts/aggregator-archive/bww-roundups/the-prom-2018.html';
  if (!fs.existsSync(archivePath)) {
    console.log(`  ⚠ skip — fixture not found at ${archivePath}`);
  } else {
    const result = parseFromArchive(archivePath);
    assert(Array.isArray(result) && result.length > 0, 'extracted reviews from articleBody');

    const nestruck = result.find(r => r.outletRaw.toLowerCase().includes('globe and mail'));
    assert(nestruck, 'Globe and Mail entry exists');
    assert(nestruck && nestruck.criticName === 'J. Kelly Nestruck',
      `Globe and Mail critic name preserves "J." prefix (got "${nestruck?.criticName}")`);

    // Sanity: other 3-word and standard 2-word names still parse
    const bernardoLikely = result.find(r => /Green|Rooney|Teachout|Hofler|Rizzo/.test(r.criticName));
    assert(bernardoLikely, 'standard 2-word critic names still extracted');

    // Confirm full slate of critics — the-prom-2018 article has 17 in the regex's reach
    assert(result.length >= 15, `expected ≥15 critics extracted (got ${result.length})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
