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
 *   adjacent to data.shows.push(), exactly as discover-new-shows-category.test.mjs
 *   does for the new-shows path.
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

test('classifyShow call site is adjacent to data.shows.push (no overwrite gap)', () => {
  // The call must stay near the push so nothing can null out category/market
  // between classification and write. discover-historical-shows.js currently has
  // ~6 lines between classifyShow and data.shows.push.
  const src = readFileSync(SRC_PATH, 'utf8');
  const pushIdx = src.indexOf('data.shows.push(');
  assert.ok(pushIdx > -1, 'data.shows.push(...) call not found in discover-historical-shows.js');
  const preceding = src.slice(Math.max(0, pushIdx - 600), pushIdx);
  assert.ok(
    /classifyShow\(/.test(preceding),
    'classifyShow() is no longer called in the ~600 chars before data.shows.push(). ' +
      'The call must stay adjacent to the push so nothing can overwrite category/market between.'
  );
});

test('the pushed row includes both category and market fields', () => {
  // Regex-walk the push call: it must mention category AND market as keys.
  const src = readFileSync(SRC_PATH, 'utf8');
  const pushStart = src.indexOf('data.shows.push(');
  assert.ok(pushStart > -1, 'data.shows.push(...) call not found');
  // Take ~1200 chars after the push to capture the object literal.
  const pushBlock = src.slice(pushStart, pushStart + 1200);
  assert.ok(
    /\bcategory\b/.test(pushBlock),
    'data.shows.push(...) object literal does not mention `category` — historical rows will ship without it.'
  );
  assert.ok(
    /\bmarket\b/.test(pushBlock),
    'data.shows.push(...) object literal does not mention `market` — opening-night-orchestrator misroutes without it.'
  );
});
