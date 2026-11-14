// BRO-7163 F09: current-run corroboration clears a stale prior-run citation of the same URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { weUrlIsPriorRun } = require('../../scripts/lib/we-prior-run.js');
const U = 'https://www.theguardian.com/stage/2026/nov/01/the-glass-menagerie-review';

test('only a prior-run citation: prior-run', () => assert.equal(weUrlIsPriorRun(U, new Set([U]), new Map()), true));
test('prior-run citation AND a current-run source: not prior-run', () => assert.equal(weUrlIsPriorRun(U, new Set([U]), new Map([[U, new Set(['theatre-reviews'])]])), false));
test('not cited as prior-run: false', () => assert.equal(weUrlIsPriorRun(U, new Set(), new Map()), false));
test('audit applies the resolver, not a bare set lookup', () => {
  const src = fs.readFileSync(new URL('../../scripts/audit-show-review-gap.js', import.meta.url), 'utf8');
  assert.match(src, /weUrlIsPriorRun\(m\.url, weRefPriorRunUrls, weRefUrlSources\)/);
  assert.doesNotMatch(src, /if \(weRefPriorRunUrls\.has\(m\.url\)\) m\.priorRun = true/);
});
