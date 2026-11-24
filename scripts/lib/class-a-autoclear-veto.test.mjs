// BRO-8229: allowCrossMarket / allowEarlyDate must never strip the wrongProduction flag
// from a strict class-A leak (the sibling run's review). Without the veto, a rescue flag
// made every rebuild un-flag the file and the zero-tolerance audit gate reddened main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { makeClassAVeto } = require('./cross-market-contamination.js');
const { shouldAutoClearWrongProduction } = require('./wrong-production-autoclear.js');
const { parseDate } = require('./date-utils.js');

const shows = [
  { id: 'a-christmas-carol-west-end-2026', title: 'A Christmas Carol', openingDate: '2026-11-24', category: 'west-end', market: 'west-end' },
  { id: 'a-christmas-carol-regional-2025', title: 'A Christmas Carol', openingDate: '2025-11-23', category: 'regional', market: 'regional' },
  { id: 'solo-2020', title: 'Solo Show', openingDate: '2020-03-01', category: 'broadway' },
  { id: 'a-christmas-carol-tour-2024', title: 'A Christmas Carol', openingDate: '2025-11-20', category: 'tour', market: 'tour' },
];
const by = Object.fromEntries(shows.map(s => [s.id, s]));
const veto = makeClassAVeto(shows, parseDate);
// The real failing file (run 43660704888): Old Vic 2025 review filed under the 2026 West End show.
const leak = { wrongProduction: true, allowCrossMarket: true, publishDate: '2025-11-26' };

test('class-A leak with an allowCrossMarket rescue is vetoed (the BRO-8229 case)', () => {
  assert.equal(veto(leak, by['a-christmas-carol-west-end-2026']), true);
  assert.equal(shouldAutoClearWrongProduction(leak), true, 'without ctx the old behaviour strips the flag (documents the bug)');
  assert.equal(shouldAutoClearWrongProduction(leak, { classA: true }), false);
  assert.equal(shouldAutoClearWrongProduction({ ...leak, allowCrossMarket: false, allowEarlyDate: true }, { classA: true }), false);
});

test('legit bypass still clears: not class A, no siblings, tour show, audit allowlist', () => {
  assert.equal(veto({ ...leak, publishDate: '2026-11-25' }, by['a-christmas-carol-west-end-2026']), false);
  assert.equal(veto(leak, by['solo-2020']), false);
  assert.equal(veto(leak, by['a-christmas-carol-tour-2024']), false);
  assert.equal(veto({ ...leak, _auditAllowCrossMarket: true }, by['a-christmas-carol-west-end-2026']), false);
  assert.equal(veto({ wrongProduction: true }, by['a-christmas-carol-west-end-2026']), false);
  assert.equal(shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }, { classA: false }), true);
  assert.equal(shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }), true);
});

test('wiring: rebuild and scoring-delta pass the class-A veto into the auto-clear', () => {
  for (const f of ['../rebuild-all-reviews.js', '../scoring-delta.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /shouldAutoClearWrongProduction\([a-z]+, \{ classA: /, `${f} must pass { classA } to shouldAutoClearWrongProduction`);
  }
});
