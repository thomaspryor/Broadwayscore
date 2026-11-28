// BRO-5729 (BRO-3425 pattern): live-data assertions split out of scripts/lib/automated-clear-not-manual.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/review-texts), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health, which checks out core data and
// review-texts), excluded from the unit batches in scripts/lib/unit-test-collection.js. Pure-logic tests stay in scripts/lib/automated-clear-not-manual.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isAutomatedClearStoredAsManual } = require('../../scripts/lib/automated-clear-not-manual.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.REVIEW_TEXTS_DIR || path.join(repoRoot, 'data', 'review-texts');

test('corpus: no review file stores an automated clear as ManualClear', (t) => {
  let shows;
  try { shows = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')); }
  catch { shows = null; }
  if (!shows || !shows.length) {
    if (process.env.REQUIRE_REVIEW_CORPUS === '1') assert.fail(`REQUIRE_REVIEW_CORPUS=1 but ${DIR} is missing/empty`);
    return t.skip('data/review-texts not present');
  }
  const bad = [];
  for (const s of shows) {
    for (const f of readdirSync(path.join(DIR, s.name))) {
      if (!f.endsWith('.json')) continue;
      let j; try { j = JSON.parse(readFileSync(path.join(DIR, s.name, f), 'utf8')); } catch { continue; }
      if (isAutomatedClearStoredAsManual(j)) bad.push(`${s.name}/${f}`);
    }
  }
  assert.deepEqual(bad, [], `${bad.length} file(s) store an automated clear as wrongProductionManualClear (use wrongProductionAutoCleared)`);
});
