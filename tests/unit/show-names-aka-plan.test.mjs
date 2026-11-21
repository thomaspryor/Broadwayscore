// BRO-7778: shows.json akaTitles is a plan-editable field with a value check (press titles every matcher reads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyDataEdit } = require('../../scripts/lib/data-edit-action.js');

const shows = () => [
  { id: 'iawl', title: 'It’s A Wonderful Life: A Live Radio Play' },
  { id: 'diana-2021', title: 'Diana' },
  { id: 'diana-2026', title: 'Diana: The Untold and Untrue Story' },
];
const edit = (showId, newValue) => ({ type: 'data-edit', file: 'shows.json', showId, field: 'akaTitles', oldValue: null, newValue });

test('a plan can set akaTitles', () => {
  const data = shows();
  const r = applyDataEdit(data, edit('iawl', ["It's a Wonderful Life"]));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(data[0].akaTitles, ["It's a Wonderful Life"]);
});
test('an aka that is another show\'s title is refused (it would file one show\'s reviews under the other)', () => {
  const r = applyDataEdit(shows(), edit('diana-2026', ['Diana']));
  assert.equal(r.ok, false);
  assert.match(r.reason, /title of another show/);
});
test('null clears; a case variant of the own title is allowed (existing data has those)', () => {
  assert.equal(applyDataEdit(shows(), edit('iawl', ['IT’S A WONDERFUL LIFE: A LIVE RADIO PLAY'])).ok, true);
  const data = shows(); data[0].akaTitles = ['x y'];
  assert.equal(applyDataEdit(data, { ...edit('iawl', null), oldValue: ['x y'] }).ok, true);
});
test('an aka another show already carries as an aka is refused', () => {
  const data = shows(); data[1].akaTitles = ['Princess Diana'];
  assert.equal(applyDataEdit(data, edit('diana-2026', ['Princess Diana'])).ok, false);
});
test('a stored aka that collides (predates the check) does not block appending a new one', () => {
  const data = shows(); data[2].akaTitles = ['Diana'];
  const r = applyDataEdit(data, { ...edit('diana-2026', ['Diana', 'Diana the Untold']), oldValue: ['Diana'] });
  assert.equal(r.ok, true, r.reason);
});
test('the same work in another production may share a title', () => {
  const data = [{ id: 'chicago-1996', title: 'Chicago', workKey: 'chicago' }, { id: 'chicago-tour', title: 'Chicago - Tour', workKey: 'chicago' }];
  assert.equal(applyDataEdit(data, edit('chicago-tour', ['Chicago'])).ok, true);
});
test('non-array, empty and duplicate values are refused', () => {
  for (const v of ['It’s a Wonderful Life', [], ['A b', 'A b'], ["It's x", 'Its X'], [''], ['!!'], [7]]) {
    assert.equal(applyDataEdit(shows(), edit('iawl', v)).ok, false, JSON.stringify(v));
  }
});
