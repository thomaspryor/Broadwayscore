// BRO-5041: undo a held-row release by restoring the pre-release records.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { revertReleasedRecords } = require('../../scripts/lib/commercial-release-revert.js');

describe('revertReleasedRecords', () => {
  it('restores merged records, removes created ones, leaves the rest alone', () => {
    const previous = { shows: { beaches: { designation: 'TBD', recouped: false }, other: { designation: 'Flop' } } };
    const current = { shows: {
      beaches: { designation: 'Flop', recouped: false, weeklyRunningCost: 850000 },
      'company-2021': { designation: 'Fizzle' },
      other: { designation: 'Flop' },
      untouched: { designation: 'Windfall' },
    } };
    const out = revertReleasedRecords(current, previous, ['beaches', 'company-2021', 'other', 'never-released']);
    assert.deepEqual(out, { restored: ['beaches'], removed: ['company-2021'], unchanged: ['other', 'never-released'] });
    assert.deepEqual(current.shows.beaches, { designation: 'TBD', recouped: false });
    assert.equal('company-2021' in current.shows, false);
    assert.deepEqual(current.shows.untouched, { designation: 'Windfall' }, 'slugs not named are never touched');
    current.shows.beaches.designation = 'X';
    assert.equal(previous.shows.beaches.designation, 'TBD', 'restored record is a copy');
  });
  it('tolerates a previous file without the shows map', () => {
    const current = { shows: { a: { designation: 'Flop' } } };
    assert.deepEqual(revertReleasedRecords(current, {}, ['a']).removed, ['a']);
  });
});
