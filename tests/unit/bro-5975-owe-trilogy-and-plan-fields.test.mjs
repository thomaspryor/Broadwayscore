import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { findSameHouseTokenMatch, findDuplicate } = require_('../../scripts/promote-owe-venue-candidates.js');

const row = { id: 'the-inequalities-trilogy-off-west-end-2027', title: 'The Inequalities Trilogy', venue: 'Almeida Theatre', previewsStartDate: '2027-03-22', closingDate: '2027-05-22' };
const cand = { title: 'The Inequalities', venue: 'Almeida Theatre', discoverySource: 'venue-page:almeida-theatre', listingFirstDate: '2027-03-22', listingLastDate: '2027-05-22' };

test('BRO-5975: "The Inequalities" dedupes to the Trilogy row at the same house', () => {
  assert.ok(findSameHouseTokenMatch(cand, [row]));
  assert.ok(findDuplicate(cand, [row]));
});
test('one shared word with a non-format extra word is not a duplicate', () => {
  const other = { ...row, title: 'The Inequalities of Love' };
  assert.equal(findSameHouseTokenMatch(cand, [other]), null);
});

test('BRO-5975 review: one-word overlap needs a dated row; plan field values are constrained', () => {
  const undated = { id: 'hamlet-live', title: 'Hamlet Live', venue: 'Almeida Theatre' };
  const hamlet = { title: 'Hamlet', venue: 'Almeida Theatre', discoverySource: 'venue-page:almeida-theatre', listingFirstDate: '2027-03-22', listingLastDate: '2027-05-22' };
  assert.equal(findSameHouseTokenMatch(hamlet, [undated]), null);
  const { applyDataEdit } = require_('../../scripts/lib/data-edit-action');
  const data = { shows: [{ id: 'x', title: 'X', noPlaybillProductionPage: false }] };
  const r = applyDataEdit(data, { file: 'shows.json', showId: 'x', field: 'noPlaybillProductionPage', oldValue: false, newValue: 'yes' }, { root: '.' });
  assert.equal(r.ok, false);
});

test('BRO-5975: plans may set the Playbill-exemption and revival-checked fields, nothing else new', () => {
  const { dataEditAllowProblem } = require_('../../scripts/lib/data-edit-action');
  for (const field of ['noPlaybillProductionPage', 'statusBackfillSource', 'ibdbRevivalChecked']) assert.equal(dataEditAllowProblem({ file: 'shows.json', field }), null);
  assert.notEqual(dataEditAllowProblem({ file: 'shows.json', field: 'provisional' }), null);
});
