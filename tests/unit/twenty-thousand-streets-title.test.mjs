// BRO-5110 — a slug-truncated title ("Twenty Thousand Streets") must be
// completed from the venue's dated listing even when the row already carries
// run dates and has left 'announced'. The reader saw the full title on every
// nightly run from 2026-09-30 and logged skip-duplicate each time, because
// datedBackfillFor returned null for any row with a run window (CLAUDE.md §15:
// the real exported functions and the real captured Southwark fixture).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { main, datedBackfillFor, titleCompletionFor } = require('../../scripts/promote-owe-venue-candidates.js');
const { OWE_VENUE_CONFIGS, parseVenueListingHtml } = require('../../scripts/lib/venue-listing-discover.js');
const { oweCandidatesFromDatedListing } = require('../../scripts/discover-new-shows.js');
const { candidateHash, writeStagingCandidates, loadStaging } = require('../../scripts/lib/owe-venue-staging.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'owe-discovery');
const TODAY = '2026-09-30';
const NOW = new Date(`${TODAY}T12:00:00Z`);

function southwarkRows() {
  const cfg = OWE_VENUE_CONFIGS.find(v => v.name === 'Southwark Playhouse');
  const listing = parseVenueListingHtml(cfg, readFileSync(join(FIXTURES, 'southwark-playhouse.json'), 'utf8'), { todayIso: TODAY });
  return oweCandidatesFromDatedListing(cfg, listing).map(c => ({ ...c, source: c.discoverySource, candidateHash: candidateHash(c) }));
}

const fullCandidate = () => southwarkRows().find(c => c.title === 'Twenty Thousand Streets Under the Sky');
const datedRow = (extra = {}) => ({
  id: 'twenty-thousand-streets-off-west-end-2026', title: 'Twenty Thousand Streets', slug: 'twenty-thousand-streets-off-west-end',
  venue: 'Southwark Playhouse', status: 'open', type: 'play', category: 'off-west-end', market: 'west-end',
  previewsStartDate: '2026-09-10', openingDate: '2026-09-16', closingDate: '2026-10-17', ...extra,
});

test('titleCompletionFor completes a slug-truncated title and nothing else', () => {
  const c = fullCandidate();
  assert.ok(c, 'fixture lists the full title');
  assert.deepEqual(titleCompletionFor(c, { title: 'Twenty Thousand Streets' }), { title: 'Twenty Thousand Streets Under the Sky' });
  // Same words, a subtitle/venue tag, a one-word row and a longer row: no change.
  assert.equal(titleCompletionFor(c, { title: 'Twenty Thousand Streets Under the Sky' }), null);
  assert.equal(titleCompletionFor({ ...c, title: 'Murder in the Cathedral: OT in the Church' }, { title: 'Murder Cathedral' }), null);
  assert.equal(titleCompletionFor({ ...c, title: 'Mortal Wounds at St Mary Magdalene Church' }, { title: 'Mortal Wounds' }), null, 'venue tag');
  assert.equal(titleCompletionFor({ ...c, title: 'Nero Reborn' }, { title: 'Nero' }), null);
  assert.equal(titleCompletionFor({ ...c, title: 'Twenty Thousand' }, { title: 'Twenty Thousand Streets' }), null);
});

test('datedBackfillFor offers the title for a dated, non-announced row without touching its dates', () => {
  const c = fullCandidate();
  assert.deepEqual(datedBackfillFor(c, datedRow()), { title: 'Twenty Thousand Streets Under the Sky' });
  assert.deepEqual(datedBackfillFor(c, datedRow({ status: 'closed' })), { title: 'Twenty Thousand Streets Under the Sky' });
  // A dated row whose title is already full has nothing to offer.
  assert.equal(datedBackfillFor(c, datedRow({ title: 'Twenty Thousand Streets Under the Sky' })), null);
});

test('a dated row whose run ended before the listing starts is an earlier production and keeps its title', () => {
  const c = fullCandidate();
  assert.ok(c.listingFirstDate && c.listingLastDate, 'fixture candidate is dated');
  const earlier = datedRow({ status: 'closed', previewsStartDate: '2026-06-01', openingDate: '2026-06-05', closingDate: '2026-06-20' });
  assert.equal(datedBackfillFor(c, earlier), null);
  // Overlapping run: completes.
  assert.deepEqual(datedBackfillFor(c, datedRow({ previewsStartDate: c.listingFirstDate, closingDate: c.listingLastDate })), { title: 'Twenty Thousand Streets Under the Sky' });
});

test('main: a dated open row gets the full title with dates and status untouched, and the next run is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tts-title-'));
  const paths = { showsPath: join(dir, 'shows.json'), stagingPath: join(dir, 'staging.json'), lastPromotionFile: join(dir, 'last.json') };
  const io = (entries) => ({ ...paths, retiredEntries: [], log: () => {}, logEntry: e => entries.push(e), now: () => NOW, fetchPage: async () => { throw new Error('no network in tests'); } });
  const run = async (row) => {
    writeFileSync(paths.showsPath, JSON.stringify({ _meta: { totalShows: 1 }, shows: [row] }, null, 2) + '\n');
    writeStagingCandidates(southwarkRows().filter(c => c.title === 'Twenty Thousand Streets Under the Sky'), paths.stagingPath);
    const entries = [];
    await main([], io(entries));
    return { row: JSON.parse(readFileSync(paths.showsPath, 'utf8')).shows[0], entries };
  };

  const a = await run(datedRow());
  assert.deepEqual([a.row.title, a.row.slug, a.row.status, a.row.previewsStartDate, a.row.openingDate, a.row.closingDate],
    ['Twenty Thousand Streets Under the Sky', 'twenty-thousand-streets-off-west-end', 'open', '2026-09-10', '2026-09-16', '2026-10-17']);
  assert.equal(a.entries.filter(e => e.kind === 'backfill-dates' && e.oldTitle === 'Twenty Thousand Streets').length, 1);
  assert.deepEqual(loadStaging(paths.stagingPath), [], 'the duplicate leaves staging');

  // Nothing to do on the next run: the title is full, so it is a plain skip-duplicate.
  const b = await run(a.row);
  assert.equal(b.entries.filter(e => e.kind === 'backfill-dates').length, 0);
});
