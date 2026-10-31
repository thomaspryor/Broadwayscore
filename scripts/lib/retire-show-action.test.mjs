// BRO-4398: the retire-show plan action. Requires the real module and the
// real retireId against a scratch registry (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { applyRetireShow } = require('./retire-show-action.js');
const { retireId, unretireId, loadRetiredIds, matchesRetired } = require('./retired-show-ids.js');
const { mergeRetiredRecords } = require('./merge-retired-ids.js');

const none = () => 0;
const row = (id, title, extra = {}) => ({ id, title, venue: 'Kiln Theatre', category: 'off-west-end', status: 'announced', provisional: true, ...extra });

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-show-'));
  const paths = { listPath: path.join(dir, 'retired-show-ids.json'), archivePath: path.join(dir, 'deleted-shows.json') };
  return { paths, retire: (id, opts) => retireId(id, { ...opts, ...paths }) };
}

test('retires a provisional row: registry + archive written, row removed, title+venue blocked on request', () => {
  const { paths, retire } = scratch();
  const shows = [row('sense-and-sensibility-off-west-end-2026', 'Sense And Sensibility'), row('nine-night-off-west-end-2026', 'Nine Night')];
  const r = applyRetireShow(shows, { id: 'sense-and-sensibility-off-west-end-2026', expectTitle: 'Sense And Sensibility', reason: 'Kiln cinema screening, not a production', blockTitleVenue: true }, { retire, reviewCount: none });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(shows.map(s => s.id), ['nine-night-off-west-end-2026']);
  const entries = loadRetiredIds({ listPath: paths.listPath });
  assert.equal(entries.length, 1);
  assert.ok(matchesRetired({ id: 'other-id', title: 'Sense And Sensibility', venue: 'Kiln Theatre' }, entries), 'title+venue block fires under another id');
  assert.equal(JSON.parse(fs.readFileSync(paths.archivePath, 'utf8'))[0].title, 'Sense And Sensibility');
});

test('refuses: wrong title, non-provisional row, missing reason, unknown id, already retired — nothing removed', () => {
  const { retire } = scratch();
  const shows = [row('a-off-west-end-2026', 'A'), row('b-off-west-end-2026', 'B', { provisional: false })];
  const cases = [
    [{ id: 'a-off-west-end-2026', expectTitle: 'Not A', reason: 'x' }, /plan expected/],
    [{ id: 'b-off-west-end-2026', expectTitle: 'B', reason: 'x' }, /only provisional/],
    [{ id: 'a-off-west-end-2026', expectTitle: 'A', reason: ' ' }, /reason is required/],
    [{ id: 'zzz', expectTitle: 'A', reason: 'x' }, /no show with id/],
    [{ id: 'a-off-west-end-2026', reason: 'x' }, /expectTitle is required/],
  ];
  for (const [action, re] of cases) {
    const r = applyRetireShow(shows, action, { retire, reviewCount: none });
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  }
  assert.equal(shows.length, 2);
  assert.equal(applyRetireShow(shows, { id: 'a-off-west-end-2026', expectTitle: 'A', reason: 'x' }, { retire, reviewCount: none }).ok, true);
  shows.push(row('a-off-west-end-2026', 'A'));
  const again = applyRetireShow(shows, { id: 'a-off-west-end-2026', expectTitle: 'A', reason: 'x' }, { retire, reviewCount: none });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already retired/);
  assert.equal(shows.length, 2, 'the row stays when the registry refuses');
});

test('unretireId reverts a retirement in both files (the save-failure rollback)', () => {
  const { paths, retire } = scratch();
  retire('x-off-west-end-2026', { reason: 'r', archivedRow: row('x-off-west-end-2026', 'X') });
  retire('y-off-west-end-2026', { reason: 'r', archivedRow: row('y-off-west-end-2026', 'Y') });
  assert.equal(unretireId('x-off-west-end-2026', paths), true);
  assert.deepEqual(loadRetiredIds({ listPath: paths.listPath }).map(e => e.id), ['y-off-west-end-2026']);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.archivePath, 'utf8')).map(e => e.id), ['y-off-west-end-2026']);
  assert.equal(unretireId('x-off-west-end-2026', paths), false);
});

test('mergeRetiredRecords: union by id, ours first, nothing dropped on a push race', () => {
  const { merged, stats } = mergeRetiredRecords([{ id: 'a' }, { id: 'b', reason: 'ours' }], [{ id: 'b', reason: 'remote' }, { id: 'c' }]);
  assert.deepEqual(merged.map(e => e.id), ['a', 'b', 'c']);
  assert.equal(merged[1].reason, 'ours');
  assert.equal(stats.added, 1);
});

test('duplicateOf: a non-provisional duplicate with no reviews at the same house retires id-only; anything else refuses', () => {
  const { retire, paths } = scratch();
  const kept = { id: 'death-note-the-musical-west-end-2026', title: 'Death Note: The Musical', venue: 'Barbican Centre', market: 'west-end', previewsStartDate: '2026-07-30', openingDate: '2026-08-11', closingDate: '2027-05-15' };
  const dup = { id: 'death-note-the-musical-west-end-2027', title: 'Death Note The Musical', venue: 'Barbican Theatre', market: 'west-end', previewsStartDate: '2027-03-23', closingDate: '2027-05-15' };
  const base = { id: dup.id, expectTitle: dup.title, reason: 'duplicate of the 2026 row', duplicateOf: kept.id };
  const cases = [
    [{ ...base, blockTitleVenue: true }, none, /id-only/],
    [{ ...base, duplicateOf: 'nope' }, none, /not in shows.json/],
    [{ ...base, duplicateOf: dup.id }, none, /another show id/],
    [base, () => 3, /3 review/],
    [base, undefined, /review count unavailable/],
  ];
  for (const [action, reviewCount, re] of cases) {
    const shows = [{ ...kept }, { ...dup }];
    const r = applyRetireShow(shows, action, { retire, reviewCount });
    assert.equal(r.ok, false, String(re));
    assert.match(r.reason, re);
    assert.equal(shows.length, 2);
  }
  const otherHouse = [{ ...kept, venue: 'Almeida Theatre' }, { ...dup }];
  assert.match(applyRetireShow(otherHouse, base, { retire, reviewCount: none }).reason, /same house/);
  const prefixHouse = [{ ...kept, venue: 'Lyric Theatre' }, { ...dup, venue: 'Lyric Hammersmith' }];
  assert.match(applyRetireShow(prefixHouse, base, { retire, reviewCount: none }).reason, /same house/, 'Lyric Theatre is not Lyric Hammersmith');
  const revival = [{ ...kept, closingDate: '2026-12-01' }, { ...dup }];
  assert.match(applyRetireShow(revival, base, { retire, reviewCount: none }).reason, /revival or return run/);
  const otherMarket = [{ ...kept, market: 'broadway' }, { ...dup }];
  assert.match(applyRetireShow(otherMarket, base, { retire, reviewCount: none }).reason, /market/);
  const shows = [{ ...kept }, { ...dup }];
  const ok = applyRetireShow(shows, base, { retire, reviewCount: none });
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(shows.map(s => s.id), [kept.id]);
  const entry = loadRetiredIds({ listPath: paths.listPath }).find(e => e.id === dup.id);
  assert.deepEqual([entry.title, entry.venue], [null, null]);
  // A strict title subset at the same house passes ("860" in "Billy Crystal 860",
  // BRO-5014); an unrelated title at the same house still refuses.
  const bc = { id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', venue: 'Imperial Theatre', market: 'broadway', previewsStartDate: '2026-10-01', openingDate: '2026-10-21', closingDate: '2027-01-03' };
  const t860 = { id: '860-2026', title: '860', venue: 'Imperial Theatre', market: 'broadway', previewsStartDate: '2026-10-21' };
  const retire860 = { id: t860.id, expectTitle: '860', reason: 'duplicate', duplicateOf: bc.id };
  const unrelated = [{ ...bc, title: 'Moulin Rouge!' }, { ...t860 }];
  assert.match(applyRetireShow(unrelated, retire860, { retire, reviewCount: none }).reason, /does not match/);
  const subsetShows = [{ ...bc }, { ...t860 }];
  const sub = applyRetireShow(subsetShows, retire860, { retire, reviewCount: none });
  assert.equal(sub.ok, true, sub.reason);
  assert.deepEqual(subsetShows.map(s => s.id), [bc.id]);
  // Without duplicateOf, a non-provisional row still refuses.
  assert.match(applyRetireShow([{ ...dup }], { id: dup.id, expectTitle: dup.title, reason: 'x' }, { retire, reviewCount: none }).reason, /only provisional/);
});

test('nonProduction: a non-provisional announced row with no reviews retires with an evidence URL; anything else refuses (BRO-4449/BRO-4505)', () => {
  const { retire, paths } = scratch();
  const film = row('the-stranger-2-off-west-end-2026', 'The Stranger 2', { provisional: undefined });
  const base = { id: film.id, expectTitle: film.title, reason: 'Kiln cinema screening, not a stage production', nonProduction: true, evidenceUrl: 'https://kilntheatre.com/whats-on/the-stranger-2/', blockTitleVenue: true };
  const cases = [
    [{ ...base, evidenceUrl: undefined }, {}, none, /evidenceUrl/],
    [{ ...base, evidenceUrl: 'http://kilntheatre.com/x' }, {}, none, /evidenceUrl/],
    [{ ...base, nonProduction: 'yes' }, {}, none, /must be true/],
    [{ ...base, duplicateOf: 'other-show' }, {}, none, /exclusive/],
    [base, { status: 'open' }, none, /announced\/upcoming/],
    [base, { status: 'closed' }, none, /announced\/upcoming/],
    [base, { openingDate: '2026-10-01' }, none, /real run/],
    [base, { openingDate: '2099-01-01' }, none, /real run/],
    [{ ...base, outOfTier: true }, { openingDate: '2026-10-01' }, none, /real run/],
    [{ ...base, outOfTier: 'yes' }, {}, none, /outOfTier must be true/],
    [base, {}, () => 2, /2 review/],
    [base, {}, undefined, /review count unavailable/],
  ];
  for (const [action, extra, reviewCount, re] of cases) {
    const shows = [{ ...film, ...extra }];
    const r = applyRetireShow(shows, action, { retire, reviewCount });
    assert.equal(r.ok, false, String(re));
    assert.match(r.reason, re);
    assert.equal(shows.length, 1);
  }
  // Without nonProduction a non-provisional row still refuses.
  const plain = applyRetireShow([{ ...film }], { id: film.id, expectTitle: film.title, reason: 'x' }, { retire, reviewCount: none });
  assert.match(plain.reason, /only provisional/);
  const shows = [{ ...film }, row('keep-me-2026', 'Keep Me')];
  const ok = applyRetireShow(shows, base, { retire, reviewCount: none });
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(shows.map(s => s.id), ['keep-me-2026']);
  const entry = loadRetiredIds({ listPath: paths.listPath }).find(e => e.id === film.id);
  assert.match(entry.reason, /evidence: https:\/\/kilntheatre\.com/);
  assert.ok(matchesRetired({ id: 'the-stranger-2-off-west-end-2027', title: 'The Stranger 2', venue: 'Kiln Theatre' }, loadRetiredIds({ listPath: paths.listPath })), 'title+venue block keeps it from returning');
});

// BRO-5557: the Il Cimento duplicate was retired 2026-10-13 and re-minted under the same id;
// retire-show refuses a second retirement, so reMinted removes just the row.
test('reMinted removes a re-added row whose id the registry already holds, and nothing else', () => {
  const { paths, retire } = scratch();
  const base = row('x-off-west-end-2026', 'X');
  const held = (id) => loadRetiredIds({ listPath: paths.listPath }).some((e) => e.id === id);
  assert.equal(applyRetireShow([structuredClone(base)], { id: base.id, expectTitle: 'X', reason: 'first retirement' }, { retire, reviewCount: none }).ok, true);
  const shows = [structuredClone(base), row('keep-off-west-end-2026', 'Keep')];
  const plain = applyRetireShow(shows, { id: base.id, expectTitle: 'X', reason: 'again' }, { retire, reviewCount: none });
  assert.equal(plain.ok, false);
  assert.match(plain.reason, /already retired/);
  const r = applyRetireShow(shows, { id: base.id, expectTitle: 'X', reason: 'row came back', reMinted: true }, { retire, isRetired: held, reviewCount: none });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(shows.map((s) => s.id), ['keep-off-west-end-2026']);
  assert.equal(loadRetiredIds({ listPath: paths.listPath }).length, 1, 'the registry is not written twice');
});

test('reMinted refuses an id the registry does not hold, a non-provisional row, or a non-true flag', () => {
  const { paths } = scratch();
  const held = (id) => loadRetiredIds({ listPath: paths.listPath }).some((e) => e.id === id);
  const shows = [row('y-off-west-end-2026', 'Y'), row('z-off-west-end-2026', 'Z', { provisional: false })];
  assert.match(applyRetireShow(shows, { id: 'y-off-west-end-2026', expectTitle: 'Y', reason: 'r', reMinted: true }, { isRetired: held, reviewCount: none }).reason, /does not hold/);
  assert.match(applyRetireShow(shows, { id: 'z-off-west-end-2026', expectTitle: 'Z', reason: 'r', reMinted: true }, { isRetired: () => true, reviewCount: none }).reason, /only provisional/);
  assert.match(applyRetireShow(shows, { id: 'y-off-west-end-2026', expectTitle: 'Y', reason: 'r', reMinted: 'yes' }, { isRetired: () => true, reviewCount: none }).reason, /reMinted must be true/);
  assert.equal(shows.length, 2);
});

test('reMinted with blockTitleVenue is refused: a re-minted row needs no new title+venue block', () => {
  const shows = [row('q-off-west-end-2026', 'Q')];
  const r = applyRetireShow(shows, { id: 'q-off-west-end-2026', expectTitle: 'Q', reason: 'r', reMinted: true, blockTitleVenue: true }, { isRetired: () => true, reviewCount: none });
  assert.equal(r.ok, false);
  assert.match(r.reason, /blockTitleVenue/);
  assert.equal(shows.length, 1);
});

test('duplicateOf: an undated stub sharing the kept row\'s ticket listing retires and its old slug/id become aliases (BRO-5797)', () => {
  const { retire } = scratch();
  const tt = 'https://www.todaytix.com/nyc/shows/44453-amaze-magic';
  const kept = { id: 'amaze-magic-off-broadway-2025', slug: 'amaze-magic-off-broadway', title: 'AMAZE Magic', venue: 'New World Stages', market: 'broadway', openingDate: '2025-08-13', previewsStartDate: '2025-07-20', closingDate: '2027-01-31', todaytixId: 44453, ticketLinks: [{ platform: 'TodayTix', url: tt }] };
  const stub = { id: 'amaze-off-broadway-2026', slug: 'amaze-off-broadway', title: 'AMAZE', venue: 'New World Stages', market: 'broadway', openingDate: null, previewsStartDate: null, closingDate: '2027-01-31', ticketLinks: [{ platform: 'TodayTix', url: tt }] };
  const action = { id: stub.id, expectTitle: 'AMAZE', reason: 'duplicate stub', duplicateOf: kept.id };
  // No shared listing: an undated single-word title is still refused.
  const noTicket = [{ ...kept }, { ...stub, ticketLinks: [] }];
  assert.equal(applyRetireShow(noTicket, action, { retire, reviewCount: none }).ok, false);
  // A recycled listing id under an unrelated title is not a duplicate.
  const recycled = [{ ...kept }, { ...stub, title: 'Something Else' }];
  assert.match(applyRetireShow(recycled, { ...action, expectTitle: 'Something Else' }, { retire, reviewCount: none }).reason, /does not match/);
  // An undated stub with no closing date, a closed kept run, or an announced stub is not proven the same run.
  for (const [k, st] of [[{}, { closingDate: null }], [{ status: 'closed' }, {}], [{}, { status: 'announced' }]]) {
    const sh = [{ ...kept, ...k }, { ...stub, ...st }];
    assert.equal(applyRetireShow(sh, action, { retire, reviewCount: none }).ok, false);
    assert.equal(sh.length, 2);
    assert.equal(sh[0].aliases, undefined);
  }
  // Stub outlasting the kept run is a different run.
  const longer = [{ ...kept }, { ...stub, closingDate: '2027-06-01' }];
  assert.match(applyRetireShow(longer, action, { retire, reviewCount: none }).reason, /revival or return run/);
  const shows = [{ ...kept }, { ...stub }];
  const r = applyRetireShow(shows, action, { retire, reviewCount: none });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(shows.map(s => s.id), [kept.id]);
  assert.deepEqual(shows[0].aliases, ['amaze-off-broadway-2026', 'amaze-off-broadway']);
  const withAlias = [{ ...kept, aliases: ['old-slug'] }, { ...stub }];
  assert.equal(applyRetireShow(withAlias, action, { retire: scratch().retire, reviewCount: none }).ok, true);
  assert.deepEqual(withAlias[0].aliases, ['old-slug', 'amaze-off-broadway-2026', 'amaze-off-broadway']);
});

test('duplicateOf + evidenceUrl: a differently-titled undated stray of the same open run retires; anything weaker refuses (BRO-5706)', () => {
  const kept = { id: 'angels-bone-west-end-2026', slug: 'angels-bone-west-end', title: "Angel's Bone", venue: 'London Coliseum', market: 'west-end', status: 'open', openingDate: '2026-10-17', previewsStartDate: '2026-10-16', closingDate: '2026-10-31' };
  const stray = { id: 'angel-bones-english-national-opera-west-end-2026', title: 'Angel Bones - English National Opera', venue: 'London Coliseum', market: 'west-end', status: 'announced', openingDate: null, previewsStartDate: null, closingDate: '2026-10-31', type: 'special' };
  const ev = 'https://www.eno.org/whats-on/angels-bone/';
  const action = { id: stray.id, expectTitle: stray.title, reason: 'stray ENO listing of the same run', duplicateOf: kept.id, evidenceUrl: ev };
  const refused = (sh, a = action, rc = none) => { const r = applyRetireShow(sh, a, { retire: scratch().retire, reviewCount: rc }); assert.equal(r.ok, false); assert.equal(sh.length, 2); return r.reason; };
  assert.match(refused([{ ...kept }, { ...stray }], { ...action, evidenceUrl: undefined }), /does not match/);
  assert.match(refused([{ ...kept }, { ...stray }], { ...action, evidenceUrl: 'http://x.org/a' }), /does not match/);
  assert.match(refused([{ ...kept }, { ...stray, closingDate: '2026-11-07' }]), /does not match/);
  assert.match(refused([{ ...kept }, { ...stray, openingDate: '2026-10-17' }]), /does not match/);
  assert.match(refused([{ ...kept }, { ...stray, status: 'open' }]), /does not match/);
  assert.match(refused([{ ...kept, status: 'announced' }, { ...stray }]), /does not match/);
  assert.match(refused([{ ...kept }, { ...stray, venue: 'Sadler\'s Wells' }]), /not the same house/);
  assert.match(refused([{ ...kept }, { ...stray }], action, () => 2), /review/);
  // Rep house: another opera closing the same day shares no title word, so it refuses.
  assert.match(refused([{ ...kept }, { ...stray, title: 'The Magic Flute' }], { ...action, expectTitle: 'The Magic Flute' }), /does not match/);
  // A shared house/company word alone is not a shared title word.
  assert.match(refused([{ ...kept, title: 'Threepenny Opera' }, { ...stray, title: 'Gala - English National Opera' }], { ...action, expectTitle: 'Gala - English National Opera' }), /does not match/);
  const shows = [{ ...kept }, { ...stray }];
  const r = applyRetireShow(shows, action, { retire: scratch().retire, reviewCount: none });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(shows.map(s => s.id), [kept.id]);
  assert.deepEqual(shows[0].aliases, [stray.id]);
});

// BRO-5897: a provisional row with collected reviews is refused like a duplicate (ANON's NYT + Vulture
// were stranded in the retired folder because this path skipped the check).
test('provisional retire refuses a row that still has reviews, or when the count is unavailable', () => {
  const { paths, retire } = scratch();
  const shows = [row('anon-off-broadway-2026', 'Anon')];
  const action = { id: 'anon-off-broadway-2026', expectTitle: 'Anon', reason: 'duplicate' };
  const stranded = applyRetireShow(shows, action, { retire, reviewCount: () => 2 });
  assert.equal(stranded.ok, false);
  assert.match(stranded.reason, /has 2 review\(s\): move or delete/);
  assert.match(applyRetireShow(shows, action, { retire }).reason, /review count unavailable/);
  assert.equal(shows.length, 1);
  assert.equal(loadRetiredIds({ listPath: paths.listPath }).length, 0, 'registry untouched on refusal');
  assert.equal(applyRetireShow(shows, action, { retire, reviewCount: none }).ok, true);
});

test('reMinted on a provisional row that still has reviews is refused (removing the row would strand them again)', () => {
  const { paths, retire } = scratch();
  const shows = [row('r-off-west-end-2026', 'R')];
  retire('r-off-west-end-2026', { reason: 'first', archivedRow: shows[0] });
  const r = applyRetireShow(shows, { id: 'r-off-west-end-2026', expectTitle: 'R', reason: 'again', reMinted: true }, { retire, isRetired: () => true, reviewCount: () => 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /has 1 review/);
  assert.equal(shows.length, 1);
  assert.equal(loadRetiredIds({ listPath: paths.listPath }).length, 1);
});

test('BRO-6481: an "@ building" venue tail and a single-letter room tail are the same house', () => {
  const row = (id, title, venue) => ({ id, title, venue, status: 'closed', previewsStartDate: '2026-01-08', openingDate: '2026-01-12', closingDate: '2026-02-22' });
  const opts = { retire: () => ({ ok: true }), now: '2026-10-28', reviewCount: () => 0, isRetired: () => false };
  const gb = [row('gb-full', 'Going Bacharach: The Songs of an Icon', 'The Marjorie S. Deane Little Theater'),
    row('gb', 'GOING BACHARACH', 'Marjorie S. Deane Little Theater @ The West Side Y')];
  assert.equal(applyRetireShow(gb, { type: 'retire-show', id: 'gb', expectTitle: 'GOING BACHARACH', duplicateOf: 'gb-full', reason: 'test dup' }, opts).ok, true);
  const clara = [row('clara-full', 'Clara: Sex, Love and Classical Music', '59E59 Theaters Theater B'),
    row('clara', 'Clara: Sex, Love and Classical', '59E59 Theaters')];
  assert.equal(applyRetireShow(clara, { type: 'retire-show', id: 'clara', expectTitle: 'Clara: Sex, Love and Classical', duplicateOf: 'clara-full', reason: 'test dup' }, opts).ok, true);
  // A different house that merely starts the same is still refused.
  const park = [row('p1', 'Hamlet: The Play', 'Park Avenue Armory'), row('p2', 'Hamlet', 'Park')];
  assert.equal(applyRetireShow(park, { type: 'retire-show', id: 'p2', expectTitle: 'Hamlet', duplicateOf: 'p1', reason: 'test dup' }, opts).ok, false);
});

test('outOfTier: an upcoming row with a future scheduled opening date retires (BRO-6531)', () => {
  const { retire } = scratch();
  const r0 = row('peter-panto-off-broadway-2026', 'Peter Panto', { provisional: undefined, status: 'upcoming', openingDate: '2026-11-21' });
  const shows = [r0];
  const action = { id: r0.id, expectTitle: r0.title, reason: 'Off-Off-Broadway, no such tier', nonProduction: true, outOfTier: true, evidenceUrl: 'https://www.tdf.org/shows/23550/peter-panto/' };
  const r = applyRetireShow(shows, action, { retire, reviewCount: none, now: new Date('2026-10-31T00:00:00Z') });
  assert.equal(r.ok, true, r.reason);
  assert.equal(shows.length, 0);
});
