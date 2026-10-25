// BRO-5171 — West End Guardian reviews staged into the Off-West End promoter.
// Covers the four /second-opinion constraints from BRO-4689 (curated venue
// table matched on the slug after "-review-", dated rows, tombstone, dedupe
// including closed shows) and a main() dry run against a fixture report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  oweHouseFromGuardianUrl,
  oweHouseOf,
  guardianRunEndDate,
  guardianTombstones,
  stageOweGuardianCandidates,
  londonDate,
} = require('../../scripts/lib/owe-guardian-staging.js');
const { main, evaluateCandidates } = require('../../scripts/promote-owe-venue-candidates.js');
const { writeStagingCandidates, loadStaging } = require('../../scripts/lib/owe-venue-staging.js');

const DE_PROFUNDIS = 'https://www.theguardian.com/stage/2026/oct/05/de-profundis-review-oscar-wilde-coronet-theatre-london';
const MURAKAMI = 'https://www.theguardian.com/stage/2026/oct/09/end-of-the-world-and-hard-boiled-wonderland-review-haruki-murakami-barbican-theatre-london';
const G = (title, url, date, extra = {}) => ({ title, source: 'guardian-review', url, date, market: 'west-end', ...extra });
const DP = G('De Profundis', DE_PROFUNDIS, '2026-10-05T12:26:22.000Z');
const EOW = G('End of the World and Hard-Boiled Wonderland', MURAKAMI, '2026-10-09T13:53:35.000Z');

// --- 1. venue: curated table, slug after "-review-" only ---

test('venue comes from the curated table via the slug after "-review-" (both BRO-4689 shows)', () => {
  assert.equal(oweHouseFromGuardianUrl(DE_PROFUNDIS, 'De Profundis').venue, 'Coronet Theatre');
  assert.equal(oweHouseFromGuardianUrl(MURAKAMI, EOW.title).venue, 'Barbican Theatre');
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/hamlet-review-almeida-london', 'Hamlet').venue, 'Almeida Theatre');
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/x-review-kiln-theatre-london', 'X').venue, 'Kiln Theatre');
});

test('a venue word in the TITLE never picks the house; only the standfirst after "-review-" counts', () => {
  // Title "Almeida Nights" at the Bush: the title prefix is skipped.
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/almeida-nights-review-bush-theatre-london', 'Almeida Nights').venue, 'Bush Theatre');
  // A title holding "review" does not cut the slug early.
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/the-review-show-review-soho-theatre-london', 'The Review Show').venue, 'Soho Theatre');
});

test('no house, a West End-category house, or two houses -> null; a longer phrase and a room beat the shorter/parent one', () => {
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/hamlet-review-national-theatre-london', 'Hamlet'), null);
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/x-review-old-vic-london', 'X'), null);
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/x-review-almeida-and-donmar-london', 'X'), null);
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/x-review-soho-theatre-walthamstow-london', 'X').venue, 'Soho Theatre Walthamstow');
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/x-review-sam-wanamaker-playhouse-shakespeares-globe-london', 'X').venue, 'Sam Wanamaker Playhouse');
  assert.equal(oweHouseFromGuardianUrl('not a url', 'X'), null);
  // "parkour" must not hit "park-theatre"'s house: whole slug phrases only.
  assert.equal(oweHouseFromGuardianUrl('https://www.theguardian.com/stage/2026/oct/01/x-review-parkour-theatre-london', 'X'), null);
});

test('oweHouseOf maps catalogue spellings to one house by normalized equality (no substring)', () => {
  assert.equal(oweHouseOf('Barbican Centre'), oweHouseOf('Barbican Theatre'));
  assert.equal(oweHouseOf('The Maria Theatre').venue, 'Young Vic');
  assert.notEqual(oweHouseOf('Soho Theatre Walthamstow'), oweHouseOf('Soho Theatre'));
  assert.equal(oweHouseOf('Gielgud Theatre'), undefined);
});

// --- 2. dates ---

test('opening date = the review publish date in London time; closing date from the review\'s "until" line', () => {
  assert.equal(londonDate('2026-10-05T23:30:00.000Z'), '2026-10-06', 'BST evening after 23:00 UTC is the next London day');
  assert.equal(guardianRunEndDate('… despair. At the Coronet theatre, London , until 7 October Explore more', DP.date), '2026-10-07');
  assert.equal(guardianRunEndDate('… other. At Barbican theatre, London until 11 October Explore', EOW.date), '2026-10-11');
  assert.equal(guardianRunEndDate('At the Almeida, London, until 10 January.', '2026-12-12T10:00:00Z'), '2027-01-10', 'a December review of a January closing rolls the year');
  assert.equal(guardianRunEndDate('At the Almeida, London, until 7 October.', '2026-10-09T10:00:00Z'), null, 'a review published after the run ended would close the row before it opens: no date');
  assert.equal(guardianRunEndDate('At the Almeida until 3 May 2027', '2026-10-09T10:00:00Z'), '2027-05-03');
  assert.equal(guardianRunEndDate('A play that runs until it stops.', DP.date), null);
  assert.equal(guardianRunEndDate('At the Almeida until 31 February', DP.date), null);
});

test('staged rows are dated, sourced and evidence-backed', () => {
  const { rows } = stageOweGuardianCandidates([DP], { shows: [] });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.venue, 'Coronet Theatre');
  assert.equal(r.category, 'off-west-end');
  assert.equal(r.openingDate, '2026-10-05');
  assert.equal(r.openingDateSource, 'guardian-review');
  assert.deepEqual(r.evidence, [{ kind: 'review-url', url: DE_PROFUNDIS, outletId: 'guardian' }]);
  assert.equal(r.sourceUrl, DE_PROFUNDIS);
});

test('only west-end guardian-review candidates are considered', () => {
  const { rows } = stageOweGuardianCandidates([
    { ...DP, market: 'uk-regional' }, { ...DP, source: 'wet-roundup' }, { ...DP, title: '' },
  ], { shows: [] });
  assert.equal(rows.length, 0);
});

// --- 3. tombstone ---

test('a review URL the promoter pruned is tombstoned; holds and other sources are not', () => {
  const lines = [
    JSON.stringify({ kind: 'skip-duplicate', source: 'guardian-review', sourceUrl: DE_PROFUNDIS, pruned: true }),
    JSON.stringify({ kind: 'skip-unconfirmed', source: 'guardian-review', sourceUrl: MURAKAMI }), // a hold: no pruned flag
    JSON.stringify({ kind: 'skip-duplicate', source: 'venue-page:kiln-theatre', sourceUrl: 'https://x', pruned: true }),
    'not json guardian-review',
    '',
  ];
  const t = guardianTombstones(lines);
  assert.deepEqual([...t], [DE_PROFUNDIS]);
  const { rows, skipped } = stageOweGuardianCandidates([DP, EOW], { shows: [], tombstones: t });
  assert.deepEqual(rows.map((r) => r.title), [EOW.title]);
  assert.match(skipped[0].reason, /tombstoned/);
});

test('evaluateCandidates writes the tombstone fields on a Guardian prune line', async () => {
  const entries = [];
  const { rows } = stageOweGuardianCandidates([DP], { shows: [] });
  const existing = [{ id: 'de-profundis-off-west-end-2026', title: 'De Profundis', venue: 'Coronet Theatre', category: 'off-west-end', status: 'closed', openingDate: '2026-10-02', closingDate: '2026-10-07' }];
  const res = await evaluateCandidates(rows, { existingCandidates: existing, existingIds: new Set(), venueVocabulary: undefined, retiredEntries: [], logEntry: (e) => entries.push(e) });
  assert.equal(res.pruned.length, 1);
  assert.equal(entries[0].pruned, true);
  assert.equal(entries[0].sourceUrl, DE_PROFUNDIS);
  assert.deepEqual([...guardianTombstones(entries)], [DE_PROFUNDIS]);
});

// --- 4. dedupe against shows.json, closed rows included ---

test('a catalogued production (closed included, any Barbican spelling) is not staged; another year\'s run is', () => {
  const shows = [
    { id: 'de-profundis-off-west-end-2026', title: 'De Profundis', venue: 'Coronet Theatre', category: 'off-west-end', status: 'closed', openingDate: '2026-10-02', closingDate: '2026-10-07' },
    { id: 'eow-off-west-end-2026', title: 'End of the World and Hard-Boiled Wonderland', venue: 'Barbican Centre', category: 'off-west-end', status: 'closed', openingDate: '2026-10-08', closingDate: '2026-10-11' },
  ];
  const { rows, skipped } = stageOweGuardianCandidates([DP, EOW], { shows });
  assert.equal(rows.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason), ['already in shows.json as de-profundis-off-west-end-2026', 'already in shows.json as eow-off-west-end-2026']);
  // A 2019 run at the same house does not hide the 2026 one.
  const old = [{ ...shows[0], id: 'de-profundis-off-west-end-2019', openingDate: '2019-03-01', closingDate: '2019-03-30' }];
  assert.equal(stageOweGuardianCandidates([DP], { shows: old }).rows.length, 1);
  // Nor does the same title at another house, or a non-London category.
  assert.equal(stageOweGuardianCandidates([DP], { shows: [{ ...shows[0], venue: 'Almeida Theatre' }] }).rows.length, 1);
  assert.equal(stageOweGuardianCandidates([DP], { shows: [{ ...shows[0], category: 'regional' }] }).rows.length, 1);
});

test('already-staged and in-batch duplicate rows are not re-staged', () => {
  const first = stageOweGuardianCandidates([DP], { shows: [] }).rows;
  assert.equal(stageOweGuardianCandidates([DP], { shows: [], staged: first }).rows.length, 0);
  assert.equal(stageOweGuardianCandidates([DP, DP], { shows: [] }).rows.length, 1);
});

// --- main(): dry run against a fixture report ---

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owe-guardian-'));
  const p = {
    showsPath: path.join(dir, 'shows.json'),
    stagingPath: path.join(dir, 'owe-venue-candidates.json'),
    lastPromotionFile: path.join(dir, 'owe-last-promotion-ids.json'),
    reverseDiscoveryPath: path.join(dir, 'reverse-discovery-candidates.json'),
    promotionLogPath: path.join(dir, 'owe-promotion-log.jsonl'),
  };
  fs.writeFileSync(p.showsPath, JSON.stringify({ _meta: { totalShows: 1 }, shows: [
    { id: 'stuffed-off-west-end-2026', title: 'Stuffed', slug: 'stuffed-off-west-end', venue: 'Kiln Theatre', category: 'off-west-end', market: 'west-end', status: 'open', openingDate: '2026-09-01' },
  ] }, null, 2) + '\n');
  fs.writeFileSync(p.reverseDiscoveryPath, JSON.stringify({ generatedAt: '2026-10-12T00:00:00Z', candidates: [
    DP,
    G('A Nyc Thing', 'https://www.theguardian.com/stage/2026/oct/03/a-nyc-thing-review-broadway', '2026-10-03T10:00:00Z', { market: 'nyc' }),
    { title: 'Roundup Show', source: 'nyt-theater', url: 'https://x', date: '2026-10-03', market: 'nyc' },
  ] }));
  writeStagingCandidates([], p.stagingPath);
  return p;
}
const io = (p, extra = {}) => ({
  ...p,
  retiredEntries: [],
  log: () => {},
  logEntry: () => {},
  now: () => new Date('2026-10-12T12:00:00Z'),
  fetchPage: async (url) => {
    if (url === DE_PROFUNDIS) return { content: '<html><body><article><h1>De Profundis review</h1><p>Jens Harzer is gripping.</p><p>At the Coronet theatre, London , until 7 October</p></article></body></html>' };
    throw new Error('HTTP 403');
  },
  ...extra,
});

test('main --dry-run on a fixture with one west-end guardian-review candidate stages exactly one dated row with a venue, and writes nothing', async () => {
  const p = scratch();
  const before = { shows: fs.readFileSync(p.showsPath, 'utf8'), staging: fs.readFileSync(p.stagingPath, 'utf8') };
  const logs = [];
  const res = await main(['--dry-run'], io(p, { log: (m) => logs.push(m) }));
  const staged = logs.filter((m) => /^Would stage \d+ West End Guardian/.test(m));
  assert.deepEqual(staged, ['Would stage 1 West End Guardian candidate(s): De Profundis @ Coronet Theatre (2026-10-05)']);
  assert.equal(res.promoted.length, 1);
  const e = res.promoted[0].entry;
  assert.equal(e.venue, 'Coronet Theatre');
  assert.equal(e.openingDate, '2026-10-05');
  assert.equal(e.openingDateSource, 'guardian-review');
  assert.equal(e.closingDate, '2026-10-07');
  assert.equal(e.status, 'closed');
  assert.equal(e.category, 'off-west-end');
  assert.deepEqual(e.evidenceUrls, [DE_PROFUNDIS]);
  assert.equal(fs.readFileSync(p.showsPath, 'utf8'), before.shows);
  assert.equal(fs.readFileSync(p.stagingPath, 'utf8'), before.staging);
});

test('main (real run): the row is staged, promoted with its closing date, and leaves staging', async () => {
  const p = scratch();
  const res = await main([], io(p));
  assert.deepEqual(res.promoted.map((x) => x.entry.id), ['de-profundis-off-west-end-2026']);
  const row = JSON.parse(fs.readFileSync(p.showsPath, 'utf8')).shows.find((s) => s.id === 'de-profundis-off-west-end-2026');
  assert.equal(row.status, 'closed');
  assert.equal(row.closingDate, '2026-10-07');
  assert.equal(loadStaging(p.stagingPath).length, 0);
  // Next run: the show is catalogued, so nothing is staged again.
  const logs = [];
  await main(['--dry-run'], io(p, { log: (m) => logs.push(m) }));
  assert.ok(logs.some((m) => /not staged "De Profundis": already in shows\.json/.test(m)));
});

test('a fetched review with no "until" line is held while fresh, dropped (tombstoned) once old', async () => {
  const noEnd = async (url) => {
    if (url === DE_PROFUNDIS) return { content: '<p>De Profundis is gripping.</p>' };
    throw new Error('HTTP 403');
  };
  const p = scratch();
  const res = await main(['--dry-run'], io(p, { fetchPage: noEnd }));
  assert.equal(res.promoted.length, 0);
  assert.match(res.held.find((h) => h.candidate.title === 'De Profundis').reason, /states no closing date/);
  const entries = [];
  const p2 = scratch();
  const late = await main([], io(p2, { fetchPage: noEnd, now: () => new Date('2026-12-01T12:00:00Z'), logEntry: (e) => entries.push(e) }));
  assert.equal(late.pruned.filter((x) => x.candidate.title === 'De Profundis').length, 1);
  assert.deepEqual([...guardianTombstones(entries)], [DE_PROFUNDIS]);
});

test('a scratch-staging run never reads the real reverse-discovery report unless given one', async () => {
  const p = scratch();
  const { reverseDiscoveryPath, ...rest } = p; // eslint-disable-line no-unused-vars
  const logs = [];
  await main(['--dry-run'], io(rest, { reverseDiscoveryPath: undefined, log: (m) => logs.push(m) }));
  assert.ok(!logs.some((m) => /Guardian/.test(m)));
});

// --- ship-check fixes ---

test('the promoter dedupes a Guardian row by production: a closed same-title show elsewhere or an older run does not prune (or tombstone) it', async () => {
  const { rows } = stageOweGuardianCandidates([DP], { shows: [] });
  const existing = [
    { id: 'de-profundis-west-end-2019', title: 'De Profundis', venue: 'Coronet Theatre', category: 'off-west-end', status: 'closed', openingDate: '2019-03-01', closingDate: '2019-04-01' },
    { id: 'de-profundis-west-end-2026', title: 'De Profundis', venue: 'Soho Place', category: 'west-end', status: 'closed', openingDate: '2026-09-01', closingDate: '2026-10-20' },
  ];
  const entries = [];
  const res = await evaluateCandidates(rows, { existingCandidates: existing, existingIds: new Set(), venueVocabulary: undefined, retiredEntries: [], logEntry: (e) => entries.push(e) });
  assert.equal(res.pruned.length, 0);
  assert.equal(guardianTombstones(entries).size, 0);
});

test('the closing date is the LAST "at ... until" line, and never earlier than the review date', () => {
  const pub = '2026-10-05T12:00:00Z';
  assert.equal(guardianRunEndDate('It played at the Traverse until 25 August. At the Coronet, London, until 7 October', pub), '2026-10-07');
  assert.equal(guardianRunEndDate('At the Coronet, London, until 25 August', pub), null);
  assert.equal(guardianRunEndDate('At the Coronet, London, until 5 October', pub), '2026-10-05');
});

test('press-night inference never moves a guardian-review opening date forward', () => {
  const { inferPressNightFromReviews } = require('../../scripts/lib/infer-press-night-from-reviews.js');
  const show = { id: 'x-off-west-end-2026', title: 'X', openingDate: '2026-10-05', openingDateSource: 'guardian-review' };
  const reviews = ['2026-10-20', '2026-10-21', '2026-10-21'].map((d) => ({ showId: show.id, publishDate: d }));
  assert.deepEqual(inferPressNightFromReviews({ candidateShows: [show], reviews }), []);
  // control: an ordinary unconfirmed source is moved by the same wave
  assert.equal(inferPressNightFromReviews({ candidateShows: [{ ...show, openingDateSource: 'todaytix' }], reviews }).length, 1);
});
