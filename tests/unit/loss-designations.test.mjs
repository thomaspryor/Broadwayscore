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
  it('resizedLossLabel moves an unlocked loss label to the size its estimate supports (BRO-5643)', () => {
    const model = (central, quality = 'medium') => ({ modelDataQuality: quality, modelReturnedExCreditPct: [central - 20, central, central + 20] });
    // jagged-little-pill-2019: a Fizzle left behind when the model's figure fell to 27%.
    assert.equal(D.resizedLossLabel({ designation: 'Fizzle', ...model(27) }), 'Flop');
    assert.equal(D.resizedLossLabel({ designation: 'Flop', ...model(45) }), 'Fizzle');
    assert.equal(D.resizedLossLabel({ designation: 'Did Not Recoup', ...model(12, 'high') }), 'Flop');
    assert.equal(D.resizedLossLabel({ designation: 'Fizzle', ...model(45, 'low') }), 'Did Not Recoup');
    assert.equal(D.resizedLossLabel({ designation: 'Flop', ...model(10) }), null, 'already fits');
    assert.equal(D.resizedLossLabel({ designation: 'Did Not Recoup' }), null, 'no estimate at all');
    // The record's own estimate sizes it ahead of the model: an analyst post or a quote can cross the line too.
    assert.equal(D.resizedLossLabel({ designation: 'Fizzle', estimatedRecoupmentPct: [10, 10], ...model(45) }), 'Flop');
    assert.equal(D.resizedLossLabel({ designation: 'Fizzle', analystRecoupPct: [0, 20], ...model(45) }), 'Flop');
    assert.equal(D.resizedLossLabel({ designation: 'Flop', analystRecoupPct: [40, 40], ...model(5) }), 'Fizzle');
    assert.equal(D.resizedLossLabel({ designation: 'Flop', analystRecoupPct: [0, 20], ...model(45) }), null);
    // A person's lock and labels that are not losses stay.
    assert.equal(D.resizedLossLabel({ designation: 'Fizzle', humanReviewedDesignation: true, ...model(5) }), null);
    for (const designation of ['TBD', 'Windfall', 'Trickle', 'Nonprofit', undefined]) {
      assert.equal(D.resizedLossLabel({ designation, ...model(5) }), null, String(designation));
      assert.equal(D.modelSizesLossLabel({ designation, ...model(5) }), false, String(designation));
    }
    // Without the returned-so-far figure the label reads V2, then the live figure.
    assert.equal(D.resizedLossLabel({ designation: 'Fizzle', modelDataQuality: 'medium', modelRecoupmentPctV2: [0, 20, 40] }), 'Flop');
    assert.equal(D.resizedLossLabel({ designation: 'Flop', modelDataQuality: 'medium', modelRecoupmentPct: [20, 40, 60] }), 'Fizzle');
    // A branch that cleared the model fields leaves no estimate: Did Not Recoup.
    assert.equal(D.resizedLossLabel({ designation: 'Flop' }), 'Did Not Recoup');
  });
  it('modelSizesLossLabel names the labels a model change can move (previews)', () => {
    const m = { modelDataQuality: 'medium', modelReturnedExCreditPct: [0, 10, 20] };
    assert.equal(D.modelSizesLossLabel({ designation: 'Fizzle', ...m }), true);
    assert.equal(D.modelSizesLossLabel({ designation: 'Did Not Recoup' }), true);
    assert.equal(D.modelSizesLossLabel({ designation: 'Fizzle', analystRecoupPct: [0, 20], ...m }), false);
    assert.equal(D.modelSizesLossLabel({ designation: 'Fizzle', estimatedRecoupmentPct: [10, 10], ...m }), false);
    assert.equal(D.modelSizesLossLabel({ designation: 'Fizzle', humanReviewedDesignation: true, ...m }), false);
  });
  it('planModelLossResizes holds every move when a run would move more than the limit', () => {
    const drifted = (i) => [`show-${i}`, { designation: 'Fizzle', modelDataQuality: 'medium', modelReturnedExCreditPct: [0, 10, 20] }];
    const fits = ['fits', { designation: 'Flop', modelDataQuality: 'medium', modelReturnedExCreditPct: [0, 10, 20] }];
    const few = D.planModelLossResizes([drifted(1), fits, ['gone', null]]);
    assert.deepEqual(few, { moves: [{ key: 'show-1', from: 'Fizzle', to: 'Flop' }], held: false });
    const atLimit = Array.from({ length: D.MODEL_LOSS_RESIZE_LIMIT }, (_, i) => drifted(i));
    assert.equal(D.planModelLossResizes(atLimit).held, false);
    const many = D.planModelLossResizes([...atLimit, drifted(99)]);
    assert.equal(many.held, true);
    assert.equal(many.moves.length, D.MODEL_LOSS_RESIZE_LIMIT + 1);
  });
  it('a model-estimate label is sized by the model at any data quality, and is never resized across 100%', () => {
    const low = { designation: 'Flop', designationBasis: D.DESIGNATION_BASES.MODEL_ESTIMATE, modelDataQuality: 'low', modelReturnedExCreditPct: [10, 20, 30] };
    assert.equal(D.resizedLossLabel(low), null);
    assert.equal(D.resizedLossLabel({ ...low, modelReturnedExCreditPct: [30, 45, 60] }), 'Fizzle');
    assert.equal(D.resizedLossLabel({ ...low, modelReturnedExCreditPct: [90, 110, 130] }), null);
    // Without the basis a low-quality model sizes nothing: Did Not Recoup.
    assert.equal(D.resizedLossLabel({ ...low, designationBasis: undefined }), 'Did Not Recoup');
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

describe('estimatedDesignationForClosed (BRO-6158: no wait, TBD is for running shows)', () => {
  const model = (pct, extra = {}) => ({ modelDataQuality: 'low', modelReturnedExCreditPct: [pct - 5, pct, pct + 5], ...extra });
  it('sizes by the same lines the rule uses: Flop < 30, Fizzle < 100, Trickle < 150, Windfall above', () => {
    for (const [pct, label] of [[-20, 'Flop'], [29.9, 'Flop'], [30, 'Fizzle'], [99.9, 'Fizzle'], [100, 'Trickle'], [149.9, 'Trickle'], [150, 'Windfall'], [300, 'Windfall']]) {
      assert.equal(D.estimatedDesignationForClosed(model(pct)), label, `${pct}%`);
    }
  });
  it('prefers the record\'s own estimate and returns null with no figure', () => {
    assert.equal(D.estimatedDesignationForClosed(model(90, { analystRecoupPct: [10, 20] })), 'Flop');
    assert.equal(D.estimatedDesignationForClosed({}), null);
  });
  it('the wait is gone from the exports', () => {
    for (const gone of ['LOSS_LABEL_MIN_DAYS', 'isPrematureSilenceLabel', 'isWithinLossLabelWait']) assert.equal(D[gone], undefined, gone);
  });
});
