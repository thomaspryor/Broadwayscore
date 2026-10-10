// BRO-4989 C: designation thresholds have one definition. require()s the real modules (§15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

const D = require('../../scripts/lib/commercial-designations');
const rule = require('../../scripts/lib/designation-rule');
const { DESIGNATION_CRITERIA } = require('../../scripts/lib/commercial-scope');
const { shadowClassifier } = require('../../scripts/update-commercial-data');

describe('designation thresholds (one definition)', () => {
  it('designation-rule.js uses the shared constants', () => {
    assert.strictEqual(rule.TRICKLE_MAX_MULTIPLE, D.TRICKLE_MAX_MULTIPLE);
    assert.strictEqual(rule.MIRACLE_MIN_YEARS, D.MIRACLE_MIN_YEARS);
    assert.strictEqual(rule.FIZZLE_MIN_RETURNED_PCT, D.FIZZLE_MIN_RETURNED_PCT);
  });

  it('LLM criteria text carries the shared numbers', () => {
    assert.ok(DESIGNATION_CRITERIA.includes(`roughly ${D.MIRACLE_MIN_YEARS}+ years`));
    assert.ok(DESIGNATION_CRITERIA.includes(`roughly ${D.FIZZLE_MIN_RETURNED_PCT}% or more`));
    assert.ok(DESIGNATION_CRITERIA.includes(`less than ${D.FIZZLE_MIN_RETURNED_PCT}% of`));
  });

  it('no file re-hard-codes the thresholds', () => {
    const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
    for (const p of ['scripts/lib/designation-rule.js', 'scripts/merge-model-recoupment.js', 'scripts/shadow-svog-fix.js']) {
      const src = read(p);
      assert.ok(!/=\s*1\.5;|pct > 150|pct > 300/.test(src), `${p} has a literal threshold`);
    }
    // Copy that states the Fizzle/Flop line must interpolate FIZZLE_MIN_RETURNED_PCT.
    for (const p of ['src/config/commercial.ts', 'src/config/browse-pages.ts', 'src/app/methodology/page.tsx', 'scripts/audit-commercial-data.js']) {
      assert.ok(!/(Fizzle|Flop)[^.]*\b30%|\b30%[^.]*(Fizzle|Flop)/.test(read(p)), `${p} states the Fizzle/Flop line as a literal 30%`);
    }
  });

  it('the outside-rule list cannot be mutated by a consumer', () => {
    assert.ok(Object.isFrozen(D.DESIGNATIONS_OUTSIDE_RULE));
    assert.throws(() => { 'use strict'; D.DESIGNATIONS_OUTSIDE_RULE.push('Windfall'); });
  });
});

describe('modelContradictsDesignation', () => {
  // The rule merge-model-recoupment.js used before BRO-4989 C, kept here as the fixture it must match.
  const before = (pct, d) => (pct > 150 && (d === 'Fizzle' || d === 'Flop'))
    || (pct < 0 && (d === 'Windfall' || d === 'Miracle' || d === 'Easy Winner'))
    || (pct > 300 && d === 'Trickle');
  it('matches the previous inline rule on every designation and boundary', () => {
    for (const d of D.VALID_DESIGNATIONS) {
      for (const pct of [-50, -0.1, 0, 0.1, 100, 150, 150.1, 300, 300.1, 1000]) {
        assert.strictEqual(D.modelContradictsDesignation(pct, d), before(pct, d), `${d} @ ${pct}`);
      }
    }
  });
});

describe('shadowClassifier uses the approved rule', () => {
  const NOW = Date.parse('2026-10-01');
  const shows = [
    { id: 'a', slug: 'a', openingDate: '2022-01-01', closingDate: '2024-01-01' },
    { id: 'b', slug: 'b', openingDate: '2022-01-01', closingDate: '2024-01-01' },
    { id: 'c', slug: 'c', openingDate: '2025-01-01', closingDate: null },
  ];
  it('reports only what proposeDesignation would change', () => {
    const commercial = { shows: {
      a: { designation: 'Windfall', recouped: true, investorMultiple: 1.06 }, // reported under 1.5x
      b: { designation: 'Windfall', recouped: true }, // no reported multiple: no move
      c: { designation: 'TBD', recouped: false }, // running
    } };
    const out = shadowClassifier(commercial, null, shows, NOW);
    assert.deepStrictEqual(out.map((x) => [x.slug, x.current, x.predicted]), [['a', 'Windfall', 'Trickle']]);
  });
});
