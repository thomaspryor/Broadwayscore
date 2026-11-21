// BRO-7171 class guard: content-quality.js decides contentTier (and so a
// review's confidence weight); every local module it requires either sits on
// the scoring watchlist or is named here as not tier-deciding. A new helper
// pulled into content-quality.js fails this test until someone classifies it,
// so a tier-changing edit can no longer skip scoring-delta.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('./scoring-watchlists.js');
const here = path.dirname(new URL(import.meta.url).pathname);

// Required by content-quality.js but they only extract bylines / parse dates.
// byline-* only resolve the critic's name (BRO-7745 added byline-from-text's
// printed-credit override and byline-normalization's suffix strip to
// extractAuthorFromHtml / cleanAuthorName); none decides tier or score.
const NOT_TIER_DECIDING = new Set(['byline-extraction', 'byline-recovery', 'byline-from-text', 'byline-normalization', 'date-utils']);

test('every local require of content-quality.js is watched or explicitly not tier-deciding', () => {
  const src = fs.readFileSync(path.join(here, 'content-quality.js'), 'utf8');
  const deps = [...new Set([...src.matchAll(/require\(['"]\.\/([a-z0-9-]+)(?:\.js)?['"]\)/g)].map((m) => m[1]))];
  assert.ok(deps.length >= 5, `parsed ${deps.length} requires`);
  const watched = new Set([...W.INCLUSION_FILES, ...W.SCORE_VALUE_FILES, ...W.LLM_INPUT_FILES]);
  const missing = deps.filter((d) => !NOT_TIER_DECIDING.has(d) && !watched.has(`scripts/lib/${d}.js`));
  assert.deepEqual(missing, [], `add to INCLUSION_FILES (or NOT_TIER_DECIDING with a reason): ${missing.join(', ')}`);
});

test('the trailer stripper and paywall detector are on the inclusion watchlist', () => {
  assert.ok(W.INCLUSION_FILES.includes('scripts/lib/trailer-signatures.js'));
  assert.ok(W.INCLUSION_FILES.includes('scripts/lib/paywall-detector.js'));
});
