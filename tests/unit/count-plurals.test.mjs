// BRO-6410: web port of BroadwayScorecard-app's BRO-6269 guard.
// Run: node --test tests/unit/count-plurals.test.mjs
// The scanner is shared with its self-tests, rather than copied into them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ALLOWED, findBareCounts, listSourceFiles, scanSource } = require('../../scripts/lib/count-plurals.js');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// CLAUDE.md section 19: baseline existing findings outside this card's labels
// before arming a wider guard. These are legacy findings, NOT assertions that
// each count can never be 1. Counts per expression prevent new occurrences
// being hidden by an old finding. The card's components have no baseline.
const BASELINE = JSON.parse(readFileSync(new URL('../fixtures/count-plurals-baseline.json', import.meta.url), 'utf8'));
const CARD_FILES = [
  'HomePageClient', 'WestEndPageClient', 'OffBroadwayPageClient', 'OffWestEndPageClient',
  'MarketFilterBar', 'VideoReviewsShelf', 'biz/OriginMixTable',
].map(name => `src/components/${name}.tsx`);

test('show and review counts in web source agree with their noun', t => {
  assert.ok(listSourceFiles(`${ROOT}/src`).length > 100, 'expected to enumerate src/');
  for (const file of CARD_FILES) assert.ok(!BASELINE[file], `${file} must not be baselined`);
  for (const entries of Object.values(ALLOWED)) {
    for (const reason of Object.values(entries)) assert.ok(reason.length > 20, 'allow-listed counts need a reason');
  }

  const remaining = structuredClone(BASELINE);
  const violations = [];
  let legacy = 0;
  for (const hit of scanSource(ROOT)) {
    const key = `${hit.expr} | ${hit.noun}`;
    if (remaining[hit.file]?.[key] > 0) {
      remaining[hit.file][key]--;
      legacy++;
    } else {
      violations.push(`${hit.file}:${hit.line}: ${hit.text}`);
    }
  }
  t.diagnostic(`${legacy} pre-existing labels outside BRO-6410 remain in the section 19 baseline.`);
  assert.deepEqual(violations, [],
    "Use {n} {n === 1 ? 'show' : 'shows'}, or ALLOWED with proof the count cannot be 1:\n" + violations.join('\n'));
});

test('the scanner catches bare JSX and template counts', () => {
  for (const src of [
    '<span>{list.length} shows</span>',
    'aria-label={`${n} reviews`}',
    "<span>{n}{' '}shows</span>",
    '<span>{n}&nbsp;reviews</span>',
    '<span>\n{n}\nshows\n</span>',
    '<span>across {n} shows.</span>',
    'aria-label={`${broadwayOnlyCount ?? primaryCount} shows`}',
  ]) assert.equal(findBareCounts(src).length, 1, src);
});

test('the scanner passes singular guards, comments, props and decimal counts', () => {
  for (const src of [
    "<span>{n} {n === 1 ? 'show' : 'shows'}</span>",
    "`${n} ${n === 1 ? 'review' : 'reviews'}`",
    '// {n} shows was the old label',
    '/* {n} reviews */',
    '<List items={a}\n shows={b} />',
    'if (x) { skipped++; continue; }\n reviews.push(e);',
    '`${n.toFixed(1)} reviews`',
  ]) assert.equal(findBareCounts(src).length, 0, src);
  assert.equal(findBareCounts('{total} shows', { total: 'whole catalog total' }).length, 0);
  assert.equal(findBareCounts('{other} shows', { total: 'whole catalog total' }).length, 1);
});

test('comment stripping preserves line numbers and URL strings', () => {
  const hits = findBareCounts('/* old\n{n} shows */\n<a href="https://example.com">{n} reviews</a>');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});
