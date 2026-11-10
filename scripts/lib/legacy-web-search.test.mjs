// Class guard for the writer that invented review urls (BRO-7171 weak-outlet
// audit). gather-reviews.js searchForReview() asked an LLM with no web access
// for a review url and wrote the answer tagged source:'web-search'; those rows
// are most of the dead WaPo / WSJ / New Yorker / NYT / USA Today urls the gap
// engine kept fetching. The writer was deleted (df2f305f80e); this keeps the
// tag from being written again anywhere under scripts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findWebSearchSourceWrites, isLegacyWebSearchOnly } = require('./legacy-web-search.js');
const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Writes a cast file (data/cast/), never a review record.
const ALLOW = new Set(['backfill-cast-web.js']);

test('detects the deleted writer and its variants; ignores reads and comments', () => {
  // The exact lines from the deleted searchForReview() (df2f305f80e^:scripts/gather-reviews.js).
  assert.equal(findWebSearchSourceWrites("          originalRating: result.originalRating,\n          source: 'web-search'\n").length, 1);
  assert.equal(findWebSearchSourceWrites('data.source = "web-search";').length, 1);
  assert.equal(findWebSearchSourceWrites("review.sources.push('web-search')").length, 1);
  assert.equal(findWebSearchSourceWrites("if (data.source === 'web-search') skip();").length, 0);
  assert.equal(findWebSearchSourceWrites("const legacy = sources.every((x) => x === 'web-search');").length, 0);
  assert.equal(findWebSearchSourceWrites("  // source: 'web-search' was the old tag").length, 0);
});

test('no script under scripts/ writes source "web-search" (outside the cast backfill)', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'fixtures') walk(p); continue; }
      if (!/\.(c?js|mjs|ts)$/.test(e.name) || /\.test\.|\.spec\./.test(e.name) || ALLOW.has(e.name)) continue;
      for (const hit of findWebSearchSourceWrites(fs.readFileSync(p, 'utf8'))) offenders.push(`${path.relative(SCRIPTS, p)}:${hit.line}: ${hit.text}`);
    }
  };
  walk(SCRIPTS);
  assert.deepEqual(offenders, []);
});

test('legacyWebSearchFlagPatch: flags only on dead/no url AND no fetched text (BRO-7171 sweep)', () => {
  const { legacyWebSearchFlagPatch } = require('./legacy-web-search.js');
  const ws = (x) => ({ source: 'web-search', url: 'https://www.washingtonpost.com/x_story.html', contentTier: 'excerpt', fullText: '', ...x });
  assert.match(legacyWebSearchFlagPatch(ws({ httpStatus: 404 })).fabricatedReason, /url answered 404/);
  assert.ok(legacyWebSearchFlagPatch(ws({ url: null })));
  assert.ok(legacyWebSearchFlagPatch(ws({ incompleteReason: 'url_dead' })));
  assert.ok(legacyWebSearchFlagPatch(ws({}), { ffReason: 'url_dead_404' }));
  assert.ok(legacyWebSearchFlagPatch(ws({}), { probeStatus: 410 }));
  // The stored "text" is the step's own excerpt, even if a fetch stamp exists.
  const ex = 'A dazzling, heartfelt revival that earns every one of its standing ovations.';
  assert.ok(legacyWebSearchFlagPatch(ws({ httpStatus: 404, contentTier: 'truncated', fullText: ex, dtliExcerpt: ex, textFetchedAt: '2026-01-01' })));
  // Not flagged: live url, paywall/blocked (no dead evidence), complete text,
  // real fetched text, another source vouching, an earlier deliberate clear.
  assert.equal(legacyWebSearchFlagPatch(ws({}), { probeStatus: 200 }), null);
  assert.equal(legacyWebSearchFlagPatch(ws({}), { probeStatus: 403 }), null);
  assert.equal(legacyWebSearchFlagPatch(ws({ httpStatus: 404, contentTier: 'complete' })), null);
  assert.equal(legacyWebSearchFlagPatch(ws({ httpStatus: 404, contentTier: 'truncated', fullText: 'Real body text fetched from the page. '.repeat(20), textFetchedAt: '2026-01-01' })), null);
  assert.equal(legacyWebSearchFlagPatch(ws({ httpStatus: 404, sources: ['dtli'] })), null);
  assert.equal(legacyWebSearchFlagPatch(ws({ httpStatus: 404, fabricatedEntry: false })), null);
  assert.equal(legacyWebSearchFlagPatch(ws({ httpStatus: 404, fabricatedEntry: true })), null);
});

test('isLegacyWebSearchOnly: every source must be the legacy tag', () => {
  assert.equal(isLegacyWebSearchOnly({ source: 'web-search' }), true);
  assert.equal(isLegacyWebSearchOnly({ source: 'web-search', sources: ['dtli'] }), false);
  assert.equal(isLegacyWebSearchOnly({ source: 'serp-discovery' }), false);
});
