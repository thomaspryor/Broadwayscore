/**
 * Every HISTORICAL show inserted by discover-historical-shows.js must get
 * BOTH category and market stamped from classifyShow() before the row is
 * pushed to shows.json. This mirrors tests/unit/discover-new-shows-category.test.mjs
 * for the discover-NEW-shows path; the historical path was unprotected by a
 * wiring test until ship-check of commit 073db6bab0 surfaced it.
 *
 * Why a wiring test instead of a workflow-level jq assertion:
 *   The original commit added a jq step that read data/historical-shows-pending.json
 *   and asserted .category/.market — but the pending file writer never persists
 *   those fields (only id/title/slug/venue/openingDate/closingDate/type/isRevival/
 *   season/ibdbUrl land there). The assertion would have failed every real run.
 *   Codex caught this during /ship-check. The right gate is at the producer:
 *   verify scripts/discover-historical-shows.js still imports + calls classifyShow
 *   when building the completed entry, before its duplicate check and push.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC_PATH = join(ROOT, 'scripts/discover-historical-shows.js');

test('discover-historical-shows.js imports classifyShow from scripts/lib/classify-show', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.ok(
    /require\(['"]\.\/lib\/classify-show['"]\)/.test(src)
      || /require\(['"]\.\/lib\/classify-show\.js['"]\)/.test(src),
    'discover-historical-shows.js no longer requires ./lib/classify-show — someone inlined the logic again. ' +
      'Keep classification in one place per CLAUDE.md §15.'
  );
});

test('discover-historical-shows.js calls classifyShow on every new show', () => {
  const src = readFileSync(SRC_PATH, 'utf8');
  assert.ok(
    /classifyShow\(/.test(src),
    'discover-historical-shows.js imports classifyShow but never calls it. ' +
      'Historical shows will ship with null category+market again.'
  );
});

test('classifyShow call site is adjacent to the completed entry (no overwrite gap)', () => {
  // The call must stay near the push so nothing can null out category/market
  // between classification and write. discover-historical-shows.js currently has
  // a duplicate check between building the entry and data.shows.push.
  const src = readFileSync(SRC_PATH, 'utf8');
  const entryIdx = src.indexOf('const entry = {');
  assert.ok(entryIdx > -1, 'completed entry not found in discover-historical-shows.js');
  const preceding = src.slice(Math.max(0, entryIdx - 600), entryIdx);
  assert.ok(
    /classifyShow\(/.test(preceding),
    'classifyShow() must run before building the completed entry so the duplicate check sees its category/market.'
  );
});

test('the pushed row includes both category and market fields', () => {
  // Inspect the completed row, then verify that same row reaches the push.
  const src = readFileSync(SRC_PATH, 'utf8');
  const entryStart = src.indexOf('const entry = {');
  const pushStart = src.indexOf('data.shows.push(entry)', entryStart);
  assert.ok(entryStart > -1 && pushStart > entryStart, 'completed entry must reach data.shows.push(entry)');
  const pushBlock = src.slice(entryStart, src.indexOf('\n      };', entryStart));
  assert.ok(
    /\bcategory\b/.test(pushBlock),
    'data.shows.push(...) object literal does not mention `category` — historical rows will ship without it.'
  );
  assert.ok(
    /\bmarket\b/.test(pushBlock),
    'data.shows.push(...) object literal does not mention `market` — opening-night-orchestrator misroutes without it.'
  );
});
