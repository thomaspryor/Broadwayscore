// BRO-4385 — automated wrongProduction clears must not be stored as human clears.
// Unit part runs everywhere; the corpus part skips without data/review-texts
// unless REQUIRE_REVIEW_CORPUS=1 (test.yml Data Validation job sets it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isAutomatedClearStoredAsManual, demoteAutomatedManualClear } = require('./automated-clear-not-manual.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.REVIEW_TEXTS_DIR || path.join(repoRoot, 'data', 'review-texts');

// Real Fix O record shape (king-charles-iii-2015, London review on a Broadway show).
const FIX_O = {
  showId: 'king-charles-iii-2015', outletId: 'a-younger-theatre',
  wrongProduction: false, wrongProductionManualClear: true,
  wrongProductionClearReason: 'Auto-cleared: single production, review within 14d of opening (Fix O)',
};
// Real human clears (corpus reasons).
const HUMAN = [
  { wrongProductionManualClear: true, wrongProductionClearReason: 'manual:2026-04-11 audit — genuine Broadway review' },
  { wrongProductionManualClear: true, wrongProductionClearReason: 'Genuine 2016 Broadway review' },
  { wrongProductionManualClear: true },
];

test('Fix O record is flagged', () => assert.equal(isAutomatedClearStoredAsManual(FIX_O), true));
test('human clears pass', () => HUMAN.forEach((h) => assert.equal(isAutomatedClearStoredAsManual(h), false)));
test('AutoCleared breadcrumb without ManualClear passes', () =>
  assert.equal(isAutomatedClearStoredAsManual({ wrongProductionAutoCleared: 'Auto-cleared: x' }), false));
test('junk input passes', () => [null, undefined, 'x', {}].forEach((v) => assert.equal(isAutomatedClearStoredAsManual(v), false)));

test('demote moves reason to AutoCleared breadcrumb and drops ManualClear', () => {
  const d = { ...FIX_O };
  assert.equal(demoteAutomatedManualClear(d, { at: '2026-09-29' }), true);
  assert.equal(d.wrongProductionManualClear, undefined);
  assert.equal(d.wrongProductionClearReason, undefined);
  assert.match(d.wrongProductionAutoCleared, /Fix O/);
  assert.equal(d.wrongProductionAutoClearedAt, '2026-09-29');
  assert.equal(isAutomatedClearStoredAsManual(d), false);
  assert.equal(demoteAutomatedManualClear(d), false);
});
test('demote leaves human clears untouched', () => {
  const d = { ...HUMAN[0] };
  assert.equal(demoteAutomatedManualClear(d), false);
  assert.deepEqual(d, HUMAN[0]);
});

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
