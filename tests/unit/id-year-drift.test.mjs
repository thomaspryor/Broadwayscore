/**
 * Id-year drift (2026 data audit, BRO-4204 S5-T4).
 *
 * Two real functions under test (CLAUDE.md §15 — require()d, never copied):
 *   - mintCandidateId (scripts/discover-new-shows.js) stamps
 *     `idYearProvisional: true` on the minted row ONLY when the id year is the
 *     current-year fallback, i.e. no opening/previews/unconfirmed date named
 *     the production;
 *   - checkIdYearDrift (scripts/lib/id-year-drift.js) is validate-data.js's
 *     WARN rule: a non-closed id whose trailing year matches neither its
 *     openingDate year nor its previewsStartDate year.
 *
 * Fixtures are the audit's real rows (evita-2026 opening 2027-03-25,
 * wanted-2022 opening 2026-11-08, ripples-off-west-end-2026 previews-only
 * 2027-01-21) plus the edge cases the rule must skip.
 *
 * Run: node --test tests/unit/id-year-drift.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const { mintCandidateId } = require(path.join(ROOT, 'scripts/discover-new-shows.js'));
const {
  idYearOf,
  idYearDrift,
  findIdYearDrift,
  formatIdYearDriftWarning,
  checkIdYearDrift,
} = require(path.join(ROOT, 'scripts/lib/id-year-drift.js'));

const NOW = new Date('2026-06-01T00:00:00Z');

function sinks() {
  const calls = { warn: [], ok: [] };
  return { calls, warn: (m) => calls.warn.push(m), ok: (m) => calls.ok.push(m) };
}

describe('mintCandidateId — idYearProvisional stamp', () => {
  test('no date at all → current-year id AND idYearProvisional: true (the audit\'s 22)', () => {
    const minted = mintCandidateId({ title: 'Evita', category: 'broadway' }, NOW);
    assert.equal(minted.showId, 'evita-2026');
    assert.equal(minted.idYearProvisional, true);
  });

  test('an opening date names the year → not provisional', () => {
    const minted = mintCandidateId({ title: 'Evita', category: 'broadway', openingDate: '2027-03-25' }, NOW);
    assert.equal(minted.showId, 'evita-2027');
    assert.equal(minted.idYearProvisional, false);
  });

  test('previews-only and unconfirmed-start-only both count as dated', () => {
    assert.equal(mintCandidateId({ title: 'Ripples', category: 'off-west-end', previewsStartDate: '2027-01-21' }, NOW).idYearProvisional, false);
    assert.equal(mintCandidateId({ title: 'Ripples', category: 'off-west-end', unconfirmedStartDate: '2027-01-21' }, NOW).idYearProvisional, false);
  });

  test('a garbage date is the same as no date → provisional', () => {
    const minted = mintCandidateId({ title: 'A Show', category: 'west-end', openingDate: 'TBA' }, NOW);
    assert.equal(minted.showId, 'a-show-west-end-2026');
    assert.equal(minted.idYearProvisional, true);
  });

  test('discover-new-shows.js is wired: the accepted row carries the stamp only when provisional', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');
    const loopStart = src.indexOf('for (const show of discoveredShows) {');
    const loopBody = src.slice(loopStart, src.indexOf('resolveReconciliationProposals();', loopStart));
    assert.match(loopBody, /idYearProvisional, marketSlug, showId \} = minted;/, 'the loop must read the stamp from the ONE minting call');
    assert.match(loopBody, /newShows\.push\(\{[\s\S]*?\.\.\.\(idYearProvisional \? \{ idYearProvisional: true \} : \{\}\),/, 'the row must carry idYearProvisional: true only on the fallback');
  });
});

describe('idYearOf — the trailing year of an id', () => {
  test('reads the year after a market suffix or bare, never from a title that ends in digits', () => {
    assert.equal(idYearOf('evita-2026'), '2026');
    assert.equal(idYearOf('holy-fool-off-west-end-2026'), '2026');
    assert.equal(idYearOf('1536-west-end-2026'), '2026');
    assert.equal(idYearOf('1776-2022'), '2022');
    assert.equal(idYearOf('hamilton'), null);
    assert.equal(idYearOf('the-play-that-goes-wrong-west-end'), null);
    assert.equal(idYearOf(''), null);
    assert.equal(idYearOf(null), null);
  });
});

describe('idYearDrift / findIdYearDrift — the rule', () => {
  const ROWS = [
    // The audit's cases: minted with the current-year fallback, dated later.
    { id: 'evita-2026', title: 'Evita', status: 'upcoming', openingDate: '2027-03-25', previewsStartDate: '2027-02-27', idYearProvisional: true },
    { id: 'wanted-2022', title: 'Wanted', status: 'upcoming', openingDate: '2026-11-08', previewsStartDate: '2026-10-15' },
    { id: 'ripples-off-west-end-2026', title: 'Ripples', status: 'upcoming', openingDate: null, previewsStartDate: '2027-01-21' },
    // Consistent rows.
    { id: 'bug-2026', title: 'Bug', status: 'open', openingDate: '2026-01-08', previewsStartDate: '2025-12-16' },
    { id: 'dolly-an-original-musical-2026', title: 'Dolly', status: 'upcoming', openingDate: '2027-01-19', previewsStartDate: '2026-12-07' },
    // Skipped rows.
    { id: 'hamilton', title: 'Hamilton', status: 'open', openingDate: '2015-08-06' },
    { id: 'romeo-and-juliet-2024', title: 'Romeo + Juliet', status: 'closed', openingDate: '2025-10-24' },
    { id: 'announced-off-west-end-2026', title: 'Announced', status: 'upcoming', openingDate: null, previewsStartDate: null, unconfirmedStartDate: '2027-05-01' },
    { id: 'evita-2026', title: 'Evita (e2e)', status: 'upcoming', openingDate: '2027-03-25', _devOnly: true },
  ];

  test('flags exactly the rows whose id year matches neither date year', () => {
    const hits = findIdYearDrift(ROWS);
    assert.deepEqual(hits.map((h) => h.id), ['evita-2026', 'wanted-2022', 'ripples-off-west-end-2026']);
    assert.deepEqual(hits[0], { id: 'evita-2026', idYear: '2026', openingYear: '2027', previewsYear: '2027', status: 'upcoming', idYearProvisional: true });
    assert.equal(hits[1].idYearProvisional, false);
    assert.deepEqual(hits[2], { id: 'ripples-off-west-end-2026', idYear: '2026', openingYear: null, previewsYear: '2027', status: 'upcoming', idYearProvisional: false });
  });

  test('a previews year that matches is enough (dolly-2026: previews 2026, opening 2027)', () => {
    assert.equal(idYearDrift(ROWS[4]), null);
  });

  test('closed shows, ids without a year, dateless rows and _devOnly clones are skipped', () => {
    assert.equal(idYearDrift(ROWS[5]), null, 'no year suffix');
    assert.equal(idYearDrift(ROWS[6]), null, 'closed');
    assert.equal(idYearDrift(ROWS[7]), null, 'no opening/previews year to compare (unconfirmedStartDate alone is not evidence)');
    assert.equal(idYearDrift(ROWS[8]), null, '_devOnly');
    assert.equal(idYearDrift(null), null);
    assert.deepEqual(findIdYearDrift(undefined), []);
  });
});

describe('checkIdYearDrift — the WARN contract', () => {
  test('one WARN per drifted id, exact format, never an error, no ok line', () => {
    const s = sinks();
    const hits = checkIdYearDrift([
      { id: 'evita-2026', status: 'upcoming', openingDate: '2027-03-25', previewsStartDate: '2027-02-27', idYearProvisional: true },
      { id: 'ripples-off-west-end-2026', status: 'upcoming', previewsStartDate: '2027-01-21' },
      { id: 'bug-2026', status: 'open', openingDate: '2026-01-08' },
    ], s);
    assert.equal(hits.length, 2);
    assert.deepEqual(s.calls.warn, [
      'Id year drift: evita-2026 (upcoming) is a 2026 id but its dates say opening 2027, previews 2027; minted with the current-year fallback — rename via S8-T1 (rename-show-id.js) once dates are confirmed',
      'Id year drift: ripples-off-west-end-2026 (upcoming) is a 2026 id but its dates say opening none, previews 2027 — rename via S8-T1 (rename-show-id.js) once dates are confirmed',
    ]);
    assert.deepEqual(s.calls.ok, []);
  });

  test('no drift → a single ok line', () => {
    const s = sinks();
    assert.equal(checkIdYearDrift([{ id: 'bug-2026', status: 'open', openingDate: '2026-01-08' }], s).length, 0);
    assert.deepEqual(s.calls.warn, []);
    assert.equal(s.calls.ok.length, 1);
  });

  test('works without sinks and formats a status-less row', () => {
    assert.equal(checkIdYearDrift([{ id: 'x-2020', openingDate: '2021-01-01' }]).length, 1);
    assert.match(formatIdYearDriftWarning({ id: 'x-2020', idYear: '2020', openingYear: '2021', previewsYear: null, status: null, idYearProvisional: false }), /^Id year drift: x-2020 \(no status\) is a 2020 id/);
  });
});

describe('validate-data.js wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/validate-data.js'), 'utf8');

  test('requires the extracted check, reports through warn/ok, and runs it right after validateDates', () => {
    assert.match(src, /require\('\.\/lib\/id-year-drift'\)/);
    assert.match(src, /function validateIdYearDrift\(shows\)/);
    assert.match(src, /checkIdYearDrift\(shows, \{ warn, ok \}\)/, 'must report through warn (not error) and ok');
    assert.match(src, /validateDates\(shows\);\n\s*validateIdYearDrift\(shows\);/, 'runner must call the check next to the date checks');
  });
});
