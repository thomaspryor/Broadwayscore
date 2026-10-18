// Did Not Recoup (owner 2026-10-18, BRO-5636): the loss label with no
// estimate of how much came back. One list of loss labels
// (LOSS_DESIGNATIONS / isLossDesignation in commercial-designations.js);
// a literal Fizzle/Flop list elsewhere is how the new label got missed in
// the first sweep (about 40 compares across 20 files), so it is refused here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const D = require('../../scripts/lib/commercial-designations');
const { proposeDesignation } = require('../../scripts/lib/designation-rule');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('loss labels', () => {
  it('are valid designations, and Did Not Recoup canonicalizes from LLM spellings', () => {
    for (const d of D.LOSS_DESIGNATIONS) assert.ok(D.VALID_DESIGNATIONS.includes(d), d);
    assert.equal(D.canonicalDesignation('did-not-recoup'), 'Did Not Recoup');
    assert.equal(D.canonicalDesignation('DID NOT RECOUP'), 'Did Not Recoup');
  });
  it('isLossDesignation names exactly Fizzle, Flop and Did Not Recoup', () => {
    for (const d of D.VALID_DESIGNATIONS) {
      assert.equal(D.isLossDesignation(d), ['Fizzle', 'Flop', 'Did Not Recoup'].includes(d), d);
    }
    assert.equal(D.isLossDesignation(undefined), false);
  });
  it('lossDesignationFor sizes by the returned %, Did Not Recoup without one', () => {
    assert.equal(D.lossDesignationFor(null), 'Did Not Recoup');
    assert.equal(D.lossDesignationFor(undefined), 'Did Not Recoup');
    assert.equal(D.lossDesignationFor(0), 'Flop');
    assert.equal(D.lossDesignationFor(D.FIZZLE_MIN_RETURNED_PCT - 0.1), 'Flop');
    assert.equal(D.lossDesignationFor(D.FIZZLE_MIN_RETURNED_PCT), 'Fizzle');
  });
  it('modelSizedLossLabel moves a label only when our model is what sizes it (BRO-5643)', () => {
    const model = (central, quality = 'medium') => ({ modelDataQuality: quality, modelReturnedExCreditPct: [central - 20, central, central + 20] });
    // jagged-little-pill-2019: a Fizzle left behind when the model's figure fell to 27%.
    assert.equal(D.modelSizedLossLabel({ designation: 'Fizzle', ...model(27) }), 'Flop');
    assert.equal(D.modelSizedLossLabel({ designation: 'Flop', ...model(45) }), 'Fizzle');
    assert.equal(D.modelSizedLossLabel({ designation: 'Did Not Recoup', ...model(12, 'high') }), 'Flop');
    assert.equal(D.modelSizedLossLabel({ designation: 'Fizzle', ...model(45, 'low') }), 'Did Not Recoup');
    assert.equal(D.modelSizedLossLabel({ designation: 'Flop', ...model(10) }), null, 'already fits');
    assert.equal(D.modelSizedLossLabel({ designation: 'Did Not Recoup' }), null, 'no estimate at all');
    // Not the model's to move: the record's own estimate, a human lock, a label that is not a loss.
    assert.equal(D.modelSizedLossLabel({ designation: 'Fizzle', estimatedRecoupmentPct: [10, 10], ...model(45) }), null);
    assert.equal(D.modelSizedLossLabel({ designation: 'Fizzle', analystRecoupPct: [0, 20], ...model(45) }), null);
    assert.equal(D.modelSizedLossLabel({ designation: 'Fizzle', humanReviewedDesignation: true, ...model(5) }), null);
    for (const designation of ['TBD', 'Windfall', 'Trickle', 'Nonprofit', undefined]) {
      assert.equal(D.modelSizedLossLabel({ designation, ...model(5) }), null, String(designation));
    }
  });
  it('a silence-basis Did Not Recoup waits out the 6-month window like a Fizzle', () => {
    const show = { closingDate: '2026-09-01' };
    const entry = { designation: 'Did Not Recoup', designationBasis: D.DESIGNATION_BASES.NO_RECOUPMENT_ANNOUNCED };
    assert.equal(D.isPrematureSilenceLabel(entry, show, Date.parse('2026-10-18')), true);
    assert.equal(D.isPrematureSilenceLabel(entry, show, Date.parse('2027-06-01')), false);
  });
});

describe('the site and the pipeline list the same designations', () => {
  const ts = fs.readFileSync(path.join(ROOT, 'src/config/commercial.ts'), 'utf8');
  it('CommercialDesignation union === VALID_DESIGNATIONS', () => {
    const union = ts.match(/export type CommercialDesignation =([^;]+);/)[1];
    const names = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual([...names].sort(), [...D.VALID_DESIGNATIONS].sort());
  });
  it('every designation has a DESIGNATIONS entry with a unique sort order', () => {
    const block = ts.slice(ts.indexOf('export const DESIGNATIONS'), ts.indexOf('export const UNDISCLOSED_DESIGNATION'));
    const names = [...block.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual([...names].sort(), [...D.VALID_DESIGNATIONS].sort());
    const orders = [...block.matchAll(/sortOrder: (\d+)/g)].map((m) => Number(m[1]));
    assert.equal(new Set(orders).size, orders.length);
  });
});

describe('designation rule (shadow proposals)', () => {
  const NOW = Date.parse('2026-10-18');
  const closed = { openingDate: '2023-01-01', closingDate: '2024-01-01' };
  const p = (record) => proposeDesignation({ record, show: closed, model: null, now: NOW });
  it('proposes Did Not Recoup for a closed, reported-unrecouped TBD with no returned %', () => {
    const r = p({ designation: 'TBD', recouped: false });
    assert.equal(r.designation, 'Did Not Recoup');
    assert.equal(r.changed, true);
  });
  it('keeps a Did Not Recoup with no returned %, sizes one that gains a figure', () => {
    assert.equal(p({ designation: 'Did Not Recoup', recouped: false }).changed, false);
    assert.equal(p({ designation: 'Did Not Recoup', recouped: false, estimatedRecoupmentPct: [0, 10] }).designation, 'Flop');
    assert.equal(p({ designation: 'Did Not Recoup', recouped: false, analystRecoupPct: [30, 50] }).designation, 'Fizzle');
  });
  it('still never moves a Fizzle or Flop', () => {
    assert.equal(p({ designation: 'Flop', recouped: false }).changed, false);
    assert.equal(p({ designation: 'Fizzle', recouped: false, estimatedRecoupmentPct: [0, 10] }).changed, false);
  });
  it('makes no proposal while recoupment is unknown', () => {
    assert.equal(p({ designation: 'TBD', recouped: null }).changed, false);
  });
});

describe('no literal loss-label lists outside commercial-designations.js', () => {
  const LABEL = `['"](?:Fizzle|Flop|Did Not Recoup)['"]`;
  const PATTERNS = [
    // ['Fizzle', 'Flop'] and new Set(['Flop', 'Fizzle']) style lists
    new RegExp(`\\[\\s*(?:${LABEL}\\s*,\\s*)+${LABEL}\\s*\\]`),
    // x === 'Fizzle' || x === 'Flop' (either order, any loss label pair)
    new RegExp(`===\\s*${LABEL}[^\\n]*\\|\\|[^\\n]*===\\s*${LABEL}`),
    // x !== 'Fizzle' && x !== 'Flop'
    new RegExp(`!==\\s*${LABEL}[^\\n]*&&[^\\n]*!==\\s*${LABEL}`),
  ];
  const ALLOW = new Set(['scripts/lib/commercial-designations.js']);
  // A compare that means the sized labels only says so on the line.
  const OK_MARKER = /loss-list-ok: \S/;
  const SKIP_DIR = /(^|\/)(node_modules|\.next|out|data|tests?|__tests__)(\/|$)/;
  function* walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(rel)) yield* walk(rel); continue; }
      if (/\.(c?m?js|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) yield rel;
    }
  }
  it('every loss compare goes through isLossDesignation', () => {
    const hits = [];
    for (const dir of ['scripts', 'src']) {
      for (const rel of walk(dir)) {
        if (ALLOW.has(rel)) continue;
        fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line) || OK_MARKER.test(line)) return;
          if (PATTERNS.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    assert.deepEqual(hits, [], 'use isLossDesignation / LOSS_DESIGNATIONS from scripts/lib/commercial-designations.js');
  });
});
