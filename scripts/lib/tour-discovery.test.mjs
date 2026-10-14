import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { runningTourCandidates, dedupeCandidates, candidateKey } = require('./tour-discovery');
const { recordTourCandidates, openTourCandidates } = require('./tour-roundup-candidate');
const { decideTourCreation } = require('./tour-create-decision');
const { buildTourEntry } = require('./tour-entry');
const fixtures = require('../../tests/fixtures/tour-pages/closed-tours.json');
const NOW = new Date('2026-10-14T00:00:00Z');
const day = s => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// Render captured source rows; parsing and decisions always use production code.
const table = rows => '<table><tr><th>Location</th><th>Venue</th><th>Dates</th></tr>'
  + rows.map(([city, venue, start, end]) => `<tr><td>${city}</td><td>${venue}</td><td>${day(start)} - ${day(end)}</td></tr>`).join('') + '</table>';
const parentOf = f => ({ id: f.parentId, title: f.title, category: 'broadway', type: 'musical', openingDate: '2020-01-01' });

for (const f of fixtures) {
  test(`closed ${f.title}: discover captured schedule and require confirmed close`, () => {
    const parent = parentOf(f);
    const html = table(f.rows);
    const r = runningTourCandidates({ slug: f.slug, pageTitle: f.title, scheduleUrl: f.scheduleUrl, html, shows: [parent], now: NOW });
    assert.equal(r.candidates.length, 1);
    const [c] = r.candidates;
    assert.equal(c.segmentStart, f.rows[0][2]);
    assert.equal(c.segmentEnd, f.rows.at(-1)[3]);
    assert.equal(c.ended, true);
    assert.equal(c.upcoming, undefined);
    assert.equal(candidateKey(c), `${f.parentId}:${f.rows[0][2]}`);
    assert.equal(c.key, candidateKey(c));
    const d = decideTourCreation({ candidate: c, parent, shows: [parent], html, scheduleUrl: f.scheduleUrl, wikiText: f.wiki, now: NOW });
    assert.equal(d.decision.write.openingDate, f.expectedLaunch);
    assert.equal(d.decision.write.closingDate || null, f.expectedClose);
    if (f.expectedClose) {
      assert.equal(d.built.entry.closingDate, f.expectedClose);
      assert.equal(d.built.entry.status, 'closed');
      assert.ok(d.decision.wikiEvidence.launch.length);
      assert.ok(d.decision.wikiEvidence.closing.length);
    } else {
      assert.equal(d.built.entry, undefined, 'the live article lacks positive closing evidence');
      assert.match(d.built.skip, /ended segment has no confirmed closing date/);
    }
    // Silence never creates an ended tour as running, even with a launch.
    const withoutClose = f.wiki.replace(/^=+.*=+$/gm, '').replace(/The tour (played|closed)[^\n]*/g, '');
    const missing = decideTourCreation({ candidate: c, parent, shows: [parent], html, scheduleUrl: f.scheduleUrl, wikiText: withoutClose, now: NOW });
    assert.equal(missing.decision.write.closingDate, undefined);
    assert.equal(missing.built.entry, undefined);
    assert.match(missing.built.skip, /ended segment has no confirmed closing date/);
    // Controlled positive case: a later source update explicitly confirms
    // the last listed date. This is not a claim about the captured article.
    const confirmed = decideTourCreation({ candidate: c, parent, shows: [parent], html, scheduleUrl: f.scheduleUrl,
      wikiText: `${withoutClose}\nThe North American tour closed on ${day(c.segmentEnd)}.`, now: NOW });
    assert.equal(confirmed.built.entry.openingDate, f.expectedLaunch);
    assert.equal(confirmed.built.entry.closingDate, c.segmentEnd);
    assert.equal(confirmed.built.entry.status, 'closed');
  });
}

const smallRun = (year, end = `${year}-02-01`) => [
  ['Chicago, IL', 'House A', `${year}-01-01`, `${year}-01-07`],
  ['Boston, MA', 'House B', `${year}-01-09`, `${year}-01-14`],
  ['Denver, CO', 'House C', `${year}-01-16`, `${year}-01-21`],
  ['Seattle, WA', 'House D', `${year}-01-23`, end],
];
const parent = parentOf(fixtures[0]);
const discover = rows => runningTourCandidates({ slug: 'mj-the-musical', scheduleUrl: fixtures[0].scheduleUrl, html: table(rows), shows: [parent], now: NOW });

test('the cutoff is the closing, including pre-2022 launches; expired old segments are excluded', () => {
  const rows = [...smallRun(2020), ...smallRun(2021, '2022-01-01')];
  const r = discover(rows);
  assert.deepEqual(r.candidates.map(c => [c.segmentStart, c.segmentEnd]), [['2021-01-01', '2022-01-01']]);
});

test('every ended segment survives discovery and dedupe beside a current segment', () => {
  const r = discover([...smallRun(2022), ...smallRun(2024), ...smallRun(2026, '2026-12-01')]);
  assert.equal(r.candidates.length, 3);
  const d = dedupeCandidates([...r.candidates, ...r.candidates]);
  assert.equal(d.candidates.length, 3);
  assert.deepEqual(d.ambiguous, []);
  assert.equal(d.candidates.filter(c => c.ended).length, 2);
});

test('adding ended coverage preserves the first current/upcoming choice on one page', () => {
  const r = discover([...smallRun(2024), ...smallRun(2026, '2026-12-01'), ...smallRun(2027)]);
  assert.deepEqual(r.candidates.map(c => c.segmentStart), ['2026-01-01', '2024-01-01']);
});

test('the closing evidence report keeps initials inside a source sentence', () => {
  const [c] = discover(smallRun(2024)).candidates;
  const closing = 'The national tour ended on February 1, 2024 at the John F. Kennedy Center.';
  const d = decideTourCreation({ candidate: c, parent, shows: [parent], html: table(smallRun(2024)), scheduleUrl: fixtures[0].scheduleUrl,
    wikiText: `The national tour began in Chicago on January 1, 2024.\n${closing}`, now: NOW });
  assert.deepEqual(d.decision.wikiEvidence.closing, [closing]);
});

test('legacy rows migrate without losing notification or creation state, and separate segments persist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-tour-ledger-'));
  try {
    const file = path.join(dir, 'c.json');
    const candidates = discover([...smallRun(2022), ...smallRun(2024)]).candidates;
    const first = candidates.find(c => c.segmentStart === '2022-01-01');
    fs.writeFileSync(file, JSON.stringify([{ ...first, key: parent.id, firstSeen: '2026-09-01', notifiedAt: '2026-09-02', createdTourId: 'mj-tour-2022' }]));
    assert.equal(recordTourCandidates(file, candidates, '2026-10-14'), 2);
    assert.equal(recordTourCandidates(file, candidates, '2026-10-15'), 2);
    const rows = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(rows.map(c => c.key), [`${parent.id}:2022-01-01`, `${parent.id}:2024-01-01`]);
    assert.equal(rows[0].firstSeen, '2026-09-01');
    assert.equal(rows[0].notifiedAt, '2026-09-02');
    assert.equal(rows[0].createdTourId, 'mj-tour-2022');
    assert.equal(rows[1].createdTourId, undefined);
    assert.deepEqual(openTourCandidates(rows, [parent]).map(c => c.segmentStart), ['2024-01-01']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a later running tour does not settle a past segment; an overlapping closed tour does', () => {
  const [c] = discover(smallRun(2024)).candidates;
  const later = { id: 'mj-tour-2026', title: parent.title, category: 'tour', tourOf: parent.id, openingDate: '2026-01-01', status: 'open' };
  assert.deepEqual(openTourCandidates([c], [parent, later]), [c]);
  const existing = { ...later, id: 'mj-tour-2024', openingDate: '2024-01-05', closingDate: '2024-02-01', status: 'closed' };
  assert.deepEqual(openTourCandidates([c], [parent, later, existing]), []);
  const built = buildTourEntry({ parent, shows: [parent, later], scheduleUrl: fixtures[0].scheduleUrl, now: NOW,
    decision: { write: { openingDate: '2024-01-01', closingDate: '2024-02-01' }, notes: [], launchSource: 'wikipedia' } });
  assert.equal(built.entry.status, 'closed');
  const overlapping = buildTourEntry({ parent, shows: [parent, existing], scheduleUrl: fixtures[0].scheduleUrl, now: NOW,
    decision: { write: { openingDate: '2024-01-01', closingDate: '2024-02-01' }, notes: [], launchSource: 'wikipedia' } });
  assert.match(overlapping.skip, /still open or overlaps/);
});

test('roundup evidence pairs with its own segment, never another historical tour', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-tour-roundup-'));
  try {
    const file = path.join(dir, 'c.json');
    const candidates = discover([...smallRun(2022), ...smallRun(2024)]).candidates;
    recordTourCandidates(file, candidates);
    recordTourCandidates(file, [{ broadwayShowId: parent.id, title: parent.title,
      slug: 'Review-Roundup-MJ-Launches-National-Tour-20240110', url: 'https://example.test/roundup' }]);
    const rows = JSON.parse(fs.readFileSync(file));
    assert.equal(rows.length, 2);
    assert.equal(rows.find(c => c.segmentStart === '2022-01-01').roundupUrl, undefined);
    assert.equal(rows.find(c => c.segmentStart === '2024-01-01').roundupUrl, 'https://example.test/roundup');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
