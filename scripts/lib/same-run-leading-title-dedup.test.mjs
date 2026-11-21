// BRO-7156: discovery and validate-data's catalog scan both run
// checkForDuplicate; it let "Honor, An Artist Lecture", "Lumin By Emma Gibson"
// and "Ohio / Greenwich House Theater" in next to "Honor", "Lumin" and "Ohio"
// (same house, same dates). And the title normaliser now drops a "_<year>"
// listing tail ("Berlin_2027"). Real modules are require()d (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForDuplicate } = require('./deduplication.js');
const { normalizeShowTitle } = require('./show-title-normalize.js');

const honor = { id: 'honor-off-broadway-2027', title: 'Honor', slug: 'honor-off-broadway', venue: 'Polonsky Shakespeare Center', category: 'off-broadway', market: 'broadway', status: 'upcoming', previewsStartDate: '2027-01-13', closingDate: '2027-01-31' };
const lumin = { id: 'lumin-regional-2027', title: 'Lumin', slug: 'lumin-regional-2027', venue: 'Moxie Theatre, San Diego, CA', category: 'regional', market: 'broadway', status: 'upcoming', openingDate: '2027-02-14', closingDate: '2027-03-14' };
const ohio = { id: 'ohio-off-broadway-2027', title: 'Ohio', slug: 'ohio-off-broadway', venue: 'Greenwich House Theater', category: 'off-broadway', market: 'broadway', status: 'upcoming', previewsStartDate: '2027-01-17', closingDate: '2027-03-27' };

test('checkForDuplicate flags a same-run candidate whose title is the kept title plus a tail', () => {
  const cases = [
    [{ title: 'Honor, An Artist Lecture', venue: 'Polonsky Shakespeare Center', category: 'off-broadway', previewsStartDate: '2027-01-13', closingDate: '2027-01-31' }, honor],
    [{ title: 'Lumin By Emma Gibson', venue: 'Moxie Theatre, San Diego, CA', category: 'regional', openingDate: '2027-02-14', closingDate: '2027-03-14' }, lumin],
    [{ title: 'Ohio / Greenwich House Theater', venue: 'Greenwich House Theater', category: 'off-broadway', openingDate: '2027-01-17' }, ohio],
  ];
  for (const [cand, kept] of cases) {
    const r = checkForDuplicate(cand, [kept]);
    assert.equal(r.isDuplicate, true, cand.title);
    assert.equal(r.existingShow.id, kept.id);
  }
});

test('checkForDuplicate leaves a same-house show with a different run or a different first word alone', () => {
  assert.equal(checkForDuplicate({ title: 'Honor, An Artist Lecture', venue: 'Polonsky Shakespeare Center', category: 'off-broadway', previewsStartDate: '2028-01-12', closingDate: '2028-01-30' }, [honor]).isDuplicate, false);
  assert.equal(checkForDuplicate({ title: 'King Lear', venue: 'Polonsky Shakespeare Center', category: 'off-broadway', previewsStartDate: '2027-01-13', closingDate: '2027-01-31' }, [honor]).isDuplicate, false);
});

test('normalizeShowTitle drops a "_<year>" listing tail only', () => {
  const r = normalizeShowTitle({ id: 'berlin2027-off-west-end-2026', title: 'Berlin_2027', venue: 'Kiln Theatre' });
  assert.equal(r.title, 'Berlin');
  assert.ok(r.steps.some(s => s.kind === 'listing-year-suffix'));
  for (const t of ['1984', 'Room 101', 'Berlin 2027', 'Berlin_27']) {
    assert.equal(normalizeShowTitle({ id: 'x', title: t, venue: 'Kiln Theatre' }).title, t, t);
  }
});
