const assert = require('assert');
const { findOpeningShows } = require('./lib/find-opening-shows');
const now = new Date('2026-10-10T18:00:00');
const shows = [
  { id: 'future-previews', status: 'previews', openingDate: '2026-10-29' },
  { id: 'past-previews', status: 'previews', openingDate: '2026-10-09' },
  { id: 'opened-recent', status: 'open', openingDate: '2026-10-09' },
  { id: 'opened-old', status: 'open', openingDate: '2026-09-01' },
  { id: 'upcoming', status: 'upcoming', openingDate: '2026-10-29' },
  { id: 'closed', status: 'closed', openingDate: '2026-10-09' },
  { id: 'no-date', status: 'previews' },
];
const ids = findOpeningShows(shows, 2, null, now).map(s => s.id).sort();
assert.deepStrictEqual(ids, ['opened-recent', 'past-previews']);
assert.deepStrictEqual(findOpeningShows(shows, 2, 'past-previews', now).map(s => s.id), ['past-previews']);
console.log('find-opening-shows: ok');
