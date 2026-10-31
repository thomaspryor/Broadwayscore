/**
 * no-reliable-art.test.mjs (BRO-5022)
 *
 * A blanked poster must stay blank: after a wrong image was rejected and the
 * images nulled, the --missing sweep / imageless self-heal re-ran the same
 * title search and filled the row with the next wrong hit within hours. These
 * tests require the real marker helpers and the fetcher's real selection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  noArtFingerprint, buildNoReliableArtMarker, hasActiveNoArtMarker, isStrictGoogleShow,
  shouldMarkNoReliableArt, noArtOutcome, partitionNoReliableArt, validateNoReliableArtValue,
  NON_CLOSED_MARKER_TTL_DAYS, hasLapsingMarker,
} = require('./no-reliable-art.js');
const { selectShowsToFetch } = require('./image-fetch-selection.js');

const endgame = () => ({
  id: 'endgame-west-end-2020', title: 'Endgame', venue: 'Old Vic Theatre',
  openingDate: '2020-02-05', status: 'closed', images: { thumbnail: null, poster: null },
});
const marked = (show) => ({ ...show, noReliableArt: buildNoReliableArtMarker(show, { reason: 'test', now: '2026-10-11T00:00:00Z' }) });
const noFiles = () => false;

test('marker is active for the row it was built for', () => {
  const s = marked(endgame());
  assert.equal(s.noReliableArt.at, '2026-10-11');
  assert.equal(s.noReliableArt.key, 'endgame|old vic theatre|2020-02-05');
  assert.equal(hasActiveNoArtMarker(s), true);
  assert.equal(hasActiveNoArtMarker(endgame()), false);
});

test('a corrected title, venue or opening date retires the marker', () => {
  for (const patch of [{ title: 'Endgame (Beckett)' }, { venue: 'Barbican' }, { openingDate: '2020-01-30' }]) {
    assert.equal(hasActiveNoArtMarker({ ...marked(endgame()), ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(hasActiveNoArtMarker({ ...endgame(), noReliableArt: { at: '2026-10-11', reason: 'x' } }), false, 'keyless marker');
  assert.equal(noArtFingerprint({ title: ' Noises  Off ', venue: 'Garrick', openingDate: '2019-01-29T00:00' }), 'noises off|garrick|2019-01-29');
});

// The Lives of Others (West End 2026): wrong poster nulled and marked on
// 2026-10-20, real Adelphi art on TodayTix (id 46914) soon after, show opened
// 2026-10-29 and still had no image because the marker never lapsed.
const livesOfOthers = () => ({
  id: 'the-lives-of-others-west-end-2026', title: 'The Lives of Others', venue: 'Adelphi Theatre',
  openingDate: '2026-10-29', status: 'open', todaytixId: 46914, images: { thumbnail: null, poster: null, hero: null },
});
const DAY = 86400000;

test('a marker on a running row with a TodayTix id lapses after the TTL', () => {
  const s = marked(livesOfOthers()); // marker.at = 2026-10-11 via the helper
  const at = Date.parse(s.noReliableArt.at);
  assert.equal(hasLapsingMarker(s), true);
  assert.equal(hasActiveNoArtMarker(s, at + 1 * DAY), true, 'fresh marker holds, the BRO-5022 refill guard');
  assert.equal(hasActiveNoArtMarker(s, at + NON_CLOSED_MARKER_TTL_DAYS * DAY), true, 'holds through the TTL day');
  assert.equal(hasActiveNoArtMarker(s, at + (NON_CLOSED_MARKER_TTL_DAYS + 1) * DAY), false, 'lapsed');
  for (const status of ['announced', 'upcoming', 'previews', 'open']) {
    assert.equal(hasActiveNoArtMarker({ ...s, status }, at + 30 * DAY), false, status);
  }
});

test('a marker on a row with no TodayTix id never lapses (the 32 hand-marked rows with no reliable source)', () => {
  const { todaytixId, ...noId } = livesOfOthers();
  for (const status of ['announced', 'upcoming', 'previews', 'open']) {
    const s = marked({ ...noId, status });
    assert.equal(hasLapsingMarker(s), false, status);
    assert.equal(hasActiveNoArtMarker(s, Date.parse(s.noReliableArt.at) + 365 * DAY), true, status);
  }
});

test('a marker on a closed row never lapses, even with a TodayTix id', () => {
  const s = marked({ ...endgame(), todaytixId: 1 });
  assert.equal(hasLapsingMarker(s), false);
  assert.equal(hasActiveNoArtMarker(s, Date.parse(s.noReliableArt.at) + 3650 * DAY), true);
  const plain = marked(endgame());
  assert.equal(hasActiveNoArtMarker(plain, Date.parse(plain.noReliableArt.at) + 3650 * DAY), true);
});

test('a lapsing marker with an unreadable date counts as expired', () => {
  const s = livesOfOthers();
  const m = buildNoReliableArtMarker(s, { reason: 'x', now: '2026-10-20T00:00:00Z' });
  assert.equal(hasActiveNoArtMarker({ ...s, noReliableArt: { ...m, at: 'sometime' } }, Date.parse('2026-10-21')), false);
  assert.equal(hasActiveNoArtMarker({ ...s, noReliableArt: m }, Date.parse('2026-10-21')), true);
});

test('regression: a 2026-10-20 marker no longer hides the show from sweeps on 2026-10-29', () => {
  const s = { ...livesOfOthers(), noReliableArt: buildNoReliableArtMarker(livesOfOthers(), { reason: 'the art found was another production (BRO-5739)', now: '2026-10-20T12:57:49Z' }) };
  assert.equal(s.noReliableArt.key, 'the lives of others|adelphi theatre|2026-10-29');
  const sweep = (now) => selectShowsToFetch([s], { onlyMissing: true, imageOnDisk: noFiles, now });
  assert.equal(sweep(Date.parse('2026-10-22')).shows.length, 0, 'still suppressed two days in');
  assert.equal(sweep(Date.parse('2026-10-29')).shows.length, 1, 'searched again once the production has opened');
  assert.deepEqual(partitionNoReliableArt([s], Date.parse('2026-10-29')).kept.map(x => x.id), [s.id]);
  // The same marker on a row with no catalogue id (title search only) still holds.
  const { todaytixId, ...noId } = s;
  assert.equal(selectShowsToFetch([noId], { onlyMissing: true, imageOnDisk: noFiles, now: Date.parse('2026-10-29') }).shows.length, 0);
});

test('--missing sweep (closed rows included) skips a marked row', () => {
  const blank = marked(endgame());
  const other = { ...endgame(), id: 'other-closed', title: 'Other' };
  const { shows, skippedNoArt } = selectShowsToFetch([blank, other], { onlyMissing: true, includeClosed: true, imageOnDisk: noFiles });
  assert.deepEqual(shows.map(s => s.id), ['other-closed']);
  assert.deepEqual(skippedNoArt.map(s => s.id), ['endgame-west-end-2020']);
});

test('targeted --show= batches (the self-heal dispatch) skip a marked row too', () => {
  const { shows } = selectShowsToFetch([marked(endgame())], { onlyMissing: false, imageOnDisk: noFiles });
  assert.equal(shows.length, 0);
});

test('--retry-no-art and a stale marker bring the row back', () => {
  assert.equal(selectShowsToFetch([marked(endgame())], { onlyMissing: true, includeClosed: true, retryNoArt: true, imageOnDisk: noFiles }).shows.length, 1);
  const stale = { ...marked(endgame()), venue: 'The Old Vic' };
  assert.equal(selectShowsToFetch([stale], { onlyMissing: true, includeClosed: true, imageOnDisk: noFiles }).shows.length, 1);
});

test('--missing still drops closed rows without --include-closed, and rows with art', () => {
  const withArt = { ...endgame(), id: 'has-art', status: 'open' };
  const { shows } = selectShowsToFetch([endgame(), withArt], { onlyMissing: true, imageOnDisk: (p) => p === 'x' });
  assert.deepEqual(shows.map(s => s.id), ['has-art']); // open row, files missing
  const both = selectShowsToFetch([{ ...withArt, images: { poster: 'x', thumbnail: 'x' } }], { onlyMissing: true, imageOnDisk: (p) => p === 'x' });
  assert.equal(both.shows.length, 0);
});

test('partition keeps order and handles empty input', () => {
  assert.deepEqual(partitionNoReliableArt(undefined), { kept: [], skipped: [] });
});

test('strict tier only for closed rows', () => {
  assert.equal(isStrictGoogleShow(endgame()), true);
  assert.equal(isStrictGoogleShow({ status: 'open' }), false);
  assert.equal(isStrictGoogleShow(null), false);
});

test('mark only on a real rejection, never on an outage or an accept', () => {
  assert.equal(shouldMarkNoReliableArt({ strict: true, strictRejected: 3 }), true);
  assert.equal(shouldMarkNoReliableArt({ strict: false, strictRejected: 3 }), false);
  assert.equal(shouldMarkNoReliableArt({ strict: true, strictRejected: 0 }), false, 'no candidates found is not evidence');
  assert.equal(shouldMarkNoReliableArt({ strict: true, strictRejected: 3, strictErrored: 1 }), false);
  assert.equal(shouldMarkNoReliableArt({ strict: true, strictRejected: 3, searchErrored: true }), false);
  assert.equal(shouldMarkNoReliableArt({ strict: true, strictRejected: 3, accepted: true }), false);
});

// The self-heal caller runs main() at load, so pin the wiring on its source
// (same pattern as tests/unit/audit-imageless-scored-shows-push.test.mjs).
test('imageless self-heal excludes marked rows before flagging/dispatching', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'audit-imageless-scored-shows.js'), 'utf8');
  assert.match(src, /noReliableArt:\s*hasActiveNoArtMarker\(s\)/);
  assert.match(src, /findImagelessScoredShows\(normalized\.filter\(\(s\) => !s\.noReliableArt\)/);
});

test('hand-written marker validation (execute-approved-fix data-edit)', () => {
  const show = endgame();
  assert.equal(validateNoReliableArtValue(null, show), null);
  assert.equal(validateNoReliableArtValue(buildNoReliableArtMarker(show, { reason: 'film poster' }), show), null);
  assert.match(validateNoReliableArtValue({ at: '2026-10-11', reason: 'x', key: 'wrong' }, show), /key must be/);
  assert.match(validateNoReliableArtValue({ at: 'today', reason: 'x', key: noArtFingerprint(show) }, show), /YYYY-MM-DD/);
  assert.match(validateNoReliableArtValue([], show), /object or null/);
});

test('noArtOutcome: mark only an artless closed row the strict tier rejected; clear when art is found', () => {
  const rejected = { rejected: 2, errored: 0, accepted: 0, searchErrored: false };
  assert.equal(noArtOutcome(endgame(), null, rejected), 'mark');
  // A row keeping art from before (one slot being filled) is never marked.
  assert.equal(noArtOutcome({ ...endgame(), images: { poster: '/images/shows/endgame/poster.jpg', thumbnail: null } }, null, rejected), null);
  // An accepted poster (counted by verifyGooglePoster) blocks the marker.
  assert.equal(noArtOutcome(endgame(), null, { ...rejected, accepted: 1 }), null);
  assert.equal(noArtOutcome(endgame(), null, { ...rejected, errored: 1 }), null);
  assert.equal(noArtOutcome(endgame(), null, undefined), null);
  assert.equal(noArtOutcome({ ...endgame(), status: 'open' }, null, rejected), null);
  // Art found: clears an old marker, otherwise nothing to do.
  assert.equal(noArtOutcome(marked(endgame()), { thumbnail: '/images/shows/endgame/thumbnail.jpg' }, rejected), 'clear');
  assert.equal(noArtOutcome(endgame(), { poster: '/images/shows/endgame/poster.jpg' }, rejected), null);
});

// noteNoReliableArtOutcome writes markers when no show got art (a --show=X
// self-heal where every hit was rejected); the saves must not gate on success alone.
test('fetcher saves shows.json when only markers changed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fetch-show-images-auto.js'), 'utf8');
  assert.match(src, /results\.success\.length > 0 \|\| verifyCtx\?\.noArtChanged > 0\)\) \{\n\s+console\.log\(`\\n   💾 CHECKPOINT/);
  assert.match(src, /\(results\.success\.length > 0 \|\| verifyCtx\?\.noArtChanged > 0\) && !dryRunMode\) \{\n\s+saveShowsData\(\);/);
  assert.doesNotMatch(src, /if \(results\.success\.length > 0 && !dryRunMode\) \{\n\s+saveShowsData\(\);/);
});
