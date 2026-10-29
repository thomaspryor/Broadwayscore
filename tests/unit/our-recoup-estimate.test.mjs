import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
const React = require('react');
const previousReact = globalThis.React;
globalThis.React = React;
after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});
const { renderToStaticMarkup } = require('react-dom/server');
const { ourRecoupRangePct, ourRecoupEstimateErrors, isOurRecoupField } = require('../../scripts/lib/our-recoup-estimate');
const { ownReturnedEstimatePct, ownReturnedRangePct, estimatedDesignationForClosed, planModelLossResizes } = require('../../scripts/lib/commercial-designations');
const { displaysAnalyst } = require('../../scripts/lib/model-display-guard');
const { buildCommercialEntry } = require('../../scripts/lib/commercial-apply-gate');
const { analystRecoupPatch } = require('../../scripts/lib/waltz-recoup-estimates');
const { mergeCommercialJson } = require('../../scripts/lib/merge-commercial-data');
const { applyDataEdit } = require('../../scripts/lib/data-edit-action');
const { commercialRecordErrors } = require('../../scripts/lib/commercial-record-checks');
const { getDisplayableEstimateRange, getRecoupedCellSummary, getRecoupmentDisplayMode, toPublicShowCommercial, hasCommercialCard, likelyOutcomeBasis } = require('../../src/lib/commercial-display.ts');
const BizBuzzCard = require('../../src/components/BizBuzzCard.tsx').default;

const owner = { ourRecoupEstimatePct: [70, 95], ourRecoupEstimateAsOf: '2026-10-25' };
const closed = { status: 'closed' };
const row = { designation: 'Fizzle', designationBasis: 'model-estimate', capitalization: 10_000_000, recouped: null, ...owner, ...closed };

test('owner point/range leads label sizing ahead of analyst, legacy and model figures', () => {
  for (const [value, expected, designation] of [[100, 100, 'Trickle'], [[70, 95], 82.5, 'Fizzle'], [0, 0, 'Flop']]) {
    const c = { ...row, ourRecoupEstimatePct: value, analystRecoupPct: [5, 10], estimatedRecoupmentPct: [10, 20], modelRecoupmentPct: [0, 10, 20] };
    assert.equal(ownReturnedEstimatePct(c), expected);
    assert.deepEqual(ownReturnedRangePct(c), ourRecoupRangePct(c));
    assert.equal(estimatedDesignationForClosed(c), designation);
    assert.deepEqual(planModelLossResizes([['show', { ...c, designation }]]).moves, []);
  }
  assert.deepEqual(ourRecoupRangePct({ ourRecoupEstimatePct: 0 }), [0, 0]);
});

test('malformed owner values and dates are rejected by the real record validator', () => {
  for (const value of [NaN, Infinity, -1, '100', [], [1], [1, 2, 3], [95, 70], [0, Infinity]]) {
    assert.equal(ourRecoupRangePct({ ourRecoupEstimatePct: value }), null);
    assert.ok(commercialRecordErrors('show', { ...row, ourRecoupEstimatePct: value }).some(s => s.includes('ourRecoupEstimatePct')));
  }
  for (const date of [null, '2026-02-30', '2026-13-01', 'yesterday']) assert.ok(ourRecoupEstimateErrors({ ...owner, ourRecoupEstimateAsOf: date }).length);
  assert.deepEqual(ourRecoupEstimateErrors(owner), []);
  assert.ok(ourRecoupEstimateErrors({ ourRecoupEstimateAsOf: '2026-10-25' }).length);
});

test('owner ranges stay fixed despite analyst/model disagreement and survive public serialization', () => {
  const c = { ...row, analystRecoupPct: [10, 20], analystRecoupAsOf: '2026-10-28', analystRecoupUrl: 'https://www.reddit.com/r/Broadway/comments/example', modelRecoupmentPct: [10, 20, 30] };
  assert.deepEqual(getDisplayableEstimateRange(c), { range: [70, 95], withModel: false });
  assert.deepEqual(getDisplayableEstimateRange({ ...toPublicShowCommercial(c), ...closed }), getDisplayableEstimateRange(c));
  assert.deepEqual(getRecoupedCellSummary(c), { kind: 'analyst', range: [70, 95], withModel: false, ours: true, asOf: owner.ourRecoupEstimateAsOf, url: null });
  assert.equal(displaysAnalyst(c, closed), true);
  assert.equal(likelyOutcomeBasis({ ...c, designation: 'TBD' }), 'model'); // owner overrides outside analyst
  assert.equal(likelyOutcomeBasis({ ...c, designation: 'TBD', ourRecoupEstimatePct: null }), 'estimate');
  assert.equal(likelyOutcomeBasis({ ...row, designation: 'TBD' }), 'model'); // ours only
});

test('only owner figures allow estimated Trickle/Windfall beside a final label; facts still win', () => {
  assert.equal(hasCommercialCard({ designation: 'TBD', recouped: null, capitalization: null, ourRecoupEstimatePct: 0 }), true);
  const c = { ...row, designation: 'Trickle', ourRecoupEstimatePct: 100 };
  assert.deepEqual(getDisplayableEstimateRange({ ...c, designation: 'Windfall', ourRecoupEstimatePct: 150 }), { range: [150, 150], withModel: false });
  assert.deepEqual(getDisplayableEstimateRange(c), { range: [100, 100], withModel: false });
  assert.equal(displaysAnalyst(c, closed), true);
  assert.equal(getDisplayableEstimateRange({ ...c, ourRecoupEstimatePct: null, analystRecoupPct: [100, 100] }), null);
  assert.equal(getDisplayableEstimateRange({ ...c, designation: 'Flop' }), null);
  assert.equal(getRecoupmentDisplayMode({ ...c, recouped: true }), 'announced');
  assert.equal(getRecoupedCellSummary({ ...c, reportedReturn: { lo: 80, hi: 80, outlet: 'Variety', asOf: '2026-10-26' } }).kind, 'reported');
  for (const designation of ['Nonprofit', 'Tour Stop']) assert.equal(getRecoupmentDisplayMode({ ...c, designation }), 'none');
});

test('research replacement, overlays and analyst refresh cannot erase or change owner fields', () => {
  for (const opts of [{}, { mergeExisting: true }, { isClaimAutoApply: true }]) {
    const updated = buildCommercialEntry({ designation: 'Flop', designationBasis: 'reported-loss', recouped: false, ourRecoupEstimatePct: 5, ourRecoupEstimateAsOf: '2026-10-28' }, row, opts);
    assert.equal(updated.designation, 'Fizzle');
    assert.equal(updated.designationBasis, 'model-estimate');
    assert.equal(updated.recouped, null);
    assert.deepEqual(updated.ourRecoupEstimatePct, [70, 95]);
    assert.equal(updated.ourRecoupEstimateAsOf, '2026-10-25');
  }
  const fresh = buildCommercialEntry({ designation: 'TBD', ...owner }, null);
  assert.equal(fresh.ourRecoupEstimatePct, undefined);
  const patched = { ...row, ...analystRecoupPatch(row, { pct: [5, 10], asOf: '2026-10-28', url: null }) };
  assert.equal(ownReturnedEstimatePct(patched), 82.5);
  assert.equal(isOurRecoupField('ourRecoupEstimatePct'), true);
  assert.equal(isOurRecoupField('ourRecoupEstimateAsOf'), true);
  assert.equal(isOurRecoupField('analystRecoupPct'), false);
  const reported = buildCommercialEntry({ designation: 'Trickle', recouped: true, recoupedDate: '2026-10' }, row, { isClaimAutoApply: true });
  assert.equal(getRecoupmentDisplayMode(reported), 'announced');
});

test('concurrent merge keeps the owner figure and its date from the same edit', () => {
  const base = { shows: { x: { ...row, lastUpdated: '2026-10-25' } } };
  const ours = { shows: { x: { ...base.shows.x, ourRecoupEstimatePct: 100, lastUpdated: '2026-10-27' } } };
  const remote = { shows: { x: { ...base.shows.x, ourRecoupEstimateAsOf: '2026-10-26', lastUpdated: '2026-10-26' } } };
  const merged = mergeCommercialJson(ours, remote, base).merged.shows.x;
  assert.equal(merged.ourRecoupEstimatePct, 100);
  assert.equal(merged.ourRecoupEstimateAsOf, '2026-10-25');
});

test('BRO-6215 plan applies through the real executor and cards credit Our estimate; Ragtime unchanged', () => {
  const data = { shows: {
    'joe-turners-come-and-gone': { designation: 'Fizzle', designationBasis: 'model-estimate', recouped: false, modelRecoupmentPct: [38.5, 59.7, 79.5] },
    oedipus: { designation: 'Fizzle', designationBasis: 'no-recoupment-announced', recouped: false, ourEstimateRangePct: [50, 65], modelRecoupmentPct: [39.9, 61.4, 81.5] },
    ragtime: { designation: 'Fizzle', recouped: null, analystRecoupPct: [83, 83] },
  } };
  const ragtimeBefore = structuredClone(data.shows.ragtime);
  const plan = JSON.parse(readFileSync(new URL('../../data/pending-fixes/bro-6215.json', import.meta.url))).plan;
  assert.equal(plan.actions.length, 10);
  for (const action of plan.actions) assert.equal(applyDataEdit(data, action).ok, true, action.description);
  assert.deepEqual(data.shows.ragtime, ragtimeBefore);
  for (const slug of ['joe-turners-come-and-gone', 'oedipus']) {
    const c = data.shows[slug];
    assert.equal(c.recouped, null);
    assert.equal(c.designationBasis, 'model-estimate');
    assert.deepEqual(commercialRecordErrors(slug, c), []);
    const html = renderToStaticMarkup(React.createElement(BizBuzzCard, { commercial: c, showTitle: slug, showStatus: 'closed' }));
    assert.match(html, /Our estimate/);
    assert.doesNotMatch(html, /Boring_Waltz|Analyst est\./);
    if (slug === 'oedipus') {
      assert.equal(c.designation, 'Fizzle');
      assert.match(html, /~70–95%/);
    } else {
      assert.equal(c.designation, 'Trickle');
      assert.match(html, /Est\. recouped, not yet announced/);
    }
  }
});
