/**
 * Regression test for pair-based person-winner attribution
 * (scripts/enrich-awards-with-precursors.js applyDDOCCDL, shipped 2026-05-24).
 *
 * BACKGROUND
 * Wikipedia DD/OCC/DL/Lortel category pages list nominees as
 *   [winner_person, winner_show, loser_show, loser_show, ...]
 * for performance and design categories. The old enricher resolved
 * person→show only via Tony nominations, so:
 *   - off-Broadway wins (Kenrex, Mexodus, ...) silently dropped
 *   - shows where a person is Tony-nominated for a DIFFERENT production
 *     than they DD-won at were miscredited (Lost Boys audit, 2026-05-25:
 *     16/27 DD 2026 categories wrong).
 *
 * FIX
 *   1. Pair-based primary: read [winner_person, winner_show, ...] directly.
 *   2. Tony fallback only when winner is absent from nominees.
 *   3. Per-winner cleanup of stale Tony-mismapped attributions
 *      (never broad season sweeps — that broke hamilton-2015 OB→Broadway).
 *
 * MAINTENANCE
 * The first three tests are **derived from precursor data**, not hardcoded:
 * each one reads data/precursors/drama-desk.json, finds the relevant year
 * row, and asserts that awards.json reflects exactly what the precursor
 * encodes. When Wikipedia updates and Track A re-enriches, these tests
 * pick up the new truth automatically — no manual pin updates needed.
 * (The earlier hand-pinned version broke 2026-05-26 when Track A audited
 * away 15 miscredited categories — fixing data, "regressing" the pins.)
 *
 * The last two tests are hand-pinned (specific historical invariants).
 *
 * The final test is a precursor↔awards invariant: every DD/OCC/DL/Lortel
 * winnerPersonName in precursors must land in some show's winnerNames.
 * Catches the original Lost Boys class of bug: enricher dropping a win
 * entirely because of a Tony-routing miss.
 *
 * Run: node --test tests/unit/awards-person-winner-pairing.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalizeAwardCategory } = require('../../scripts/lib/award-category-canonical.js');
const { parseWinnersNomineesCell } = require('../../scripts/lib/year-page-precursor.js');

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const AWARDS_FILE = path.join(__dirname, '..', '..', 'data', 'awards.json');
const PRECURSOR_DIR = path.join(__dirname, '..', '..', 'data', 'precursors');

const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
const shows = awards.shows || awards;

function loadPrecursor(file) {
  return JSON.parse(fs.readFileSync(path.join(PRECURSOR_DIR, file), 'utf8'));
}

function precursorRow(precursor, category, year) {
  const rows = (precursor.data || precursor)[category] || [];
  return rows.find((r) => r.year === year) || null;
}

function findShowsWithWin(fieldKey, category, person) {
  // Canonicalize both sides: precursor category strings (e.g. bare
  // "Distinguished Performance") may differ from the canonical winnerNames key
  // ("Distinguished Performance Award"). See scripts/lib/award-category-canonical.js.
  const canonCat = canonicalizeAwardCategory(fieldKey, category);
  const hits = [];
  for (const [showId, show] of Object.entries(shows)) {
    const ceremony = show[fieldKey];
    if (!ceremony || !ceremony.winnerNames) continue;
    for (const [key, names] of Object.entries(ceremony.winnerNames)) {
      if (canonicalizeAwardCategory(fieldKey, key) === canonCat
          && Array.isArray(names) && names.includes(person)) {
        hits.push(showId);
        break;
      }
    }
  }
  return hits;
}

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[!?.,:;'"`’‘]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Map a precursor (winnerTitle, ceremonyYear) → the awards.json show id
// it points at, or null if the show isn't tracked. Show ids follow the
// pattern `<title-slug>(-suffix)?-<openingYear>`. Ceremony year maps to
// openingYear or openingYear+1 (most spring ceremonies cover the
// 2024-25 / 2025-26 season pattern). We require:
//   - showId starts with `<slug>-`
//   - showId ends with `-<year>` or `-<year - 1>`
//   - show actually has a {fieldKey} entry
// Multiple candidates → pick the one whose suffix is shortest (prefer
// `giant-2026` over `giant-the-musical-2026` etc.). No candidates → null.
function expectedShowIdForPrecursor(winnerTitle, year, fieldKey) {
  if (!winnerTitle || !year) return null;
  const slug = normalizeTitle(winnerTitle);
  if (!slug) return null;
  const candidates = [];
  for (const [showId, show] of Object.entries(shows)) {
    if (!show[fieldKey]) continue;
    if (!showId.startsWith(`${slug}-`)) continue;
    if (!(showId.endsWith(`-${year}`) || showId.endsWith(`-${year - 1}`))) continue;
    candidates.push(showId);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

describe('Pair-based person-winner attribution — derived from precursor data', () => {
  const dd = loadPrecursor('drama-desk.json');

  it('Kenrex: both DD 2026 person-name wins routed off-Broadway (no Tony fallback)', () => {
    // Precursor encodes both wins with winnerPersonName populated. Old
    // Tony-only path saw no Tony nom for Kenrex (off-Broadway) and dropped.
    for (const cat of ['Outstanding Music in a Play', 'Outstanding Solo Performance']) {
      const row = precursorRow(dd, cat, 2026);
      assert.ok(row, `precursor row for DD 2026 ${cat} missing`);
      assert.ok(
        row.winnerPersonName,
        `precursor row for DD 2026 ${cat} has no winnerPersonName — re-scrape?`
      );
      const person = row.winnerPersonName;
      const ddShow = shows['kenrex-off-broadway-2026']?.dramadesk;
      assert.ok(ddShow, 'kenrex-off-broadway-2026.dramadesk missing');
      assert.ok(
        (ddShow.wins || []).includes(cat),
        `kenrex-off-broadway-2026 must include DD ${cat}; got ${JSON.stringify(ddShow.wins)}`
      );
      assert.deepStrictEqual(
        ddShow.winnerNames?.[cat],
        [person],
        `kenrex-off-broadway-2026 DD ${cat} winnerNames must equal [${person}]`
      );
    }
  });

  it('DD 2026 Lead Performance in a Play: winner credited to precursor-declared show', () => {
    // Whatever show the precursor names as `winner` for this row is where
    // the principal win lands. Track A (2026-05-25 audit) corrected this
    // from well-ill-let-you-go to giant. If Wikipedia updates again, this
    // test follows automatically. Allow extra shows (ties or syndicated
    // wins) — we only enforce that the declared winner is among them.
    const row = precursorRow(dd, 'Outstanding Lead Performance in a Play', 2026);
    assert.ok(row, 'precursor DD 2026 Lead Performance in a Play missing');
    assert.ok(row.winnerPersonName, 'precursor DD 2026 Lead Play has no winnerPersonName');
    const person = row.winnerPersonName;
    const expected = expectedShowIdForPrecursor(row.winner, row.year, 'dramadesk');
    assert.ok(expected, `precursor winner show "${row.winner}" not tracked in awards.json — fixture stale?`);
    const hits = findShowsWithWin('dramadesk', 'Outstanding Lead Performance in a Play', person);
    assert.ok(
      hits.includes(expected),
      `expected ${expected} to have ${person} for DD 2026 Lead Play; got ${JSON.stringify(hits)}`
    );
  });

  it('DD 2026 Lead Performance in a Musical: winner credited to precursor-declared show', () => {
    // Same invariant as above for the musical category.
    const row = precursorRow(dd, 'Outstanding Lead Performance in a Musical', 2026);
    assert.ok(row, 'precursor DD 2026 Lead Performance in a Musical missing');
    assert.ok(row.winnerPersonName, 'precursor DD 2026 Lead Musical has no winnerPersonName');
    const person = row.winnerPersonName;
    const expected = expectedShowIdForPrecursor(row.winner, row.year, 'dramadesk');
    assert.ok(expected, `precursor winner show "${row.winner}" not tracked in awards.json — fixture stale?`);
    const hits = findShowsWithWin('dramadesk', 'Outstanding Lead Performance in a Musical', person);
    assert.ok(
      hits.includes(expected),
      `expected ${expected} to have ${person} for DD 2026 Lead Musical; got ${JSON.stringify(hits)}`
    );
  });

  // Tie co-winners must BOTH be credited. DD 2026 Lead Performance in a Musical
  // was a TIE: Joshua Henry AND Caissie Levy, both for Ragtime. A prior pass
  // wrongly collapsed it to a single Henry win (read the flat per-category list
  // as a non-tie); user feedback (2026-06-02) flagged the missing Levy. The
  // year-page scraper now parses ' and '-joined co-winners (winnerEntries) so
  // both names survive. This is the regression guard for that bug.
  it('DD 2026 Lead Performance in a Musical is a TIE: both Caissie Levy AND Joshua Henry credited to Ragtime', () => {
    const dd2 = shows['ragtime-2025']?.dramadesk;
    assert.ok(dd2, 'ragtime-2025.dramadesk missing');
    const names = dd2.winnerNames?.['Outstanding Lead Performance in a Musical'] || [];
    assert.ok(
      names.includes('Joshua Henry') && names.includes('Caissie Levy'),
      `ragtime-2025 DD Lead Musical must credit BOTH tie co-winners; got ${JSON.stringify(names)}`
    );
  });

  // Co-winners in DIFFERENT productions must each land on their own show.
  it('DD 2026 Lead Performance in a Play tie: Lithgow→Giant, Manville→Oedipus (split shows)', () => {
    const lithgow = findShowsWithWin('dramadesk', 'Outstanding Lead Performance in a Play', 'John Lithgow');
    const manville = findShowsWithWin('dramadesk', 'Outstanding Lead Performance in a Play', 'Lesley Manville');
    assert.ok(lithgow.includes('giant-2026'), `Lithgow should win at giant-2026; got ${JSON.stringify(lithgow)}`);
    assert.ok(manville.includes('oedipus-2025'), `Manville should win at oedipus-2025; got ${JSON.stringify(manville)}`);
  });
});

describe('Year-page parser: tie co-winners vs collaborative single wins', () => {
  // Real 70th Drama Desk Awards (2026) wikitext. A TIE separates two
  // independently-bold winners with " and " between quote-runs; a single
  // collaborative win lists its people as "[[A]] and [[B]]" (the "and"
  // flanked by brackets/text, NOT quotes) and may embed "and" in a title
  // ("Joe Turner's Come and Gone"). Only the former must split.
  function row(cell) { return parseWinnersNomineesCell(`* ${cell}`); }

  it('same-show tie → 2 winnerEntries, both → same production', () => {
    const r = row(`'''[[Joshua Henry]]''' and '''[[Caissie Levy]]''', ''[[Ragtime (musical)|Ragtime]]''`);
    assert.equal(r.winnerEntries?.length, 2);
    assert.deepEqual(r.winnerEntries.map((e) => `${e.person}@${e.show}`),
      ['Joshua Henry@Ragtime', 'Caissie Levy@Ragtime']);
  });

  it('split-show tie → each winner keeps own production (title with "and" intact)', () => {
    const r = row(`'''[[Alden Ehrenreich]], ''[[Becky Shaw]]''''' and '''[[Ruben Santiago-Hudson]], ''[[Joe Turner's Come and Gone]]'''''`);
    assert.equal(r.winnerEntries?.length, 2);
    assert.deepEqual(r.winnerEntries.map((e) => e.show), ['Becky Shaw', "Joe Turner's Come and Gone"]);
  });

  // Teams yield <2 entries, so scrapeYear's `length > 1` gate never emits a
  // winnerEntries tie for them (they keep their single collaborative win).
  it('collaborative single win ("A and B, Show") does NOT split into a tie', () => {
    const r = row(`'''Jen Schriever and [[Michael Arden]], ''[[The Lost Boys (musical)|The Lost Boys]]'''''`);
    assert.ok((r.winnerEntries?.length ?? 0) < 2, `team win must not split into a tie; got ${JSON.stringify(r.winnerEntries)}`);
  });

  it('"[[A]] and B, Show" (one linked, one plain) does NOT split', () => {
    const r = row(`'''[[Brian Quijada]] and Nygel D. Robinson, ''[[Mexodus]]'''''`);
    assert.ok((r.winnerEntries?.length ?? 0) < 2, `team win must not split into a tie; got ${JSON.stringify(r.winnerEntries)}`);
  });
});

describe('Pair-based attribution — hand-pinned historical invariants', () => {
  it('OB→Broadway transfer wins survive cleanup (hamilton-2015 keeps DD 2015 OB wins)', () => {
    // hamilton-2015.dramadesk.season = "2015-16" (its Broadway Tony season).
    // The DD 2015 OB run attributed multiple wins to hamilton-2015. Cleanup
    // must strip per-winner Tony-mismaps only, never broad season sweeps.
    const wins = shows['hamilton-2015']?.dramadesk?.wins || [];
    const expected = [
      'Outstanding Book of a Musical',
      'Outstanding Featured Actress in a Musical',
      'Outstanding Lyrics',
      'Outstanding Music',
      'Outstanding Musical',
    ];
    for (const cat of expected) {
      assert.ok(
        wins.includes(cat),
        `hamilton-2015 must keep DD ${cat} (OB→Broadway transfer); got ${JSON.stringify(wins)}`
      );
    }
  });

  it('Hand-curated DL Distinguished Performance Award + winnerNames not wiped by enricher', () => {
    // DL DPA precursor rows have winner=null in current years (Wikipedia
    // omits winner cells). Ragtime/Joshua Henry was hand-curated in
    // awards.json. The cleanup must skip categories where the source row
    // has no winner — guarded by `personWinnerShowMap.size > 0`.
    const dl = shows['ragtime-2025']?.dramaLeague;
    assert.ok(
      (dl?.wins || []).includes('Distinguished Performance Award'),
      'ragtime-2025.dramaLeague.wins must include Distinguished Performance Award'
    );
    assert.deepStrictEqual(
      dl?.winnerNames?.['Distinguished Performance Award'],
      ['Joshua Henry'],
      'ragtime-2025.dramaLeague.winnerNames must preserve Joshua Henry'
    );
  });
});

describe('Precursor → awards.json: no silent winner drops (Lost Boys invariant)', () => {
  // For every precursor row whose declared winner show IS tracked in
  // awards.json, the row's winnerPersonName must appear on that show's
  // winnerNames for the category. This is the SYSTEMATIC guard the
  // Lost Boys audit (2026-05-25) showed we were missing: 16/27 DD 2026
  // categories were silently miscredited or dropped by the pre-2026-05-24
  // Tony-only routing.
  //
  // Show-tracking is detected via expectedShowIdForPrecursor (strict
  // slug+year match against existing awards.json keys). Untracked shows
  // (e.g. The Baker's Wife, the gap Track A flagged) are skipped — they
  // are an accepted gap, not a regression.
  const sources = [
    ['drama-desk.json', 'dramadesk'],
    ['outer-critics.json', 'outerCriticsCircle'],
    ['drama-league.json', 'dramaLeague'],
  ];

  for (const [file, fieldKey] of sources) {
    let precursor;
    try {
      precursor = loadPrecursor(file);
    } catch {
      continue; // precursor file optional
    }
    const categories = precursor.data || precursor;
    for (const [category, rows] of Object.entries(categories)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row.winnerPersonName || !row.year || !row.winner) continue;
        // Only enforce on 2024+ — older entries may pre-date the precursor
        // scraper's pair-encoding. Keeps the invariant fast and stable.
        if (row.year < 2024) continue;
        const expected = expectedShowIdForPrecursor(row.winner, row.year, fieldKey);
        if (!expected) continue; // show isn't tracked → accepted gap

        it(`${fieldKey} ${row.year} ${category} — ${row.winnerPersonName} (winner=${row.winner} → ${expected})`, () => {
          const hits = findShowsWithWin(fieldKey, category, row.winnerPersonName);
          assert.ok(
            hits.includes(expected),
            `${row.winnerPersonName} won ${fieldKey} ${row.year} ${category} per precursor ` +
              `(winner show: ${row.winner} → ${expected}), but ${expected} does not have this ` +
              `winnerName. Hits elsewhere: ${JSON.stringify(hits)}. ` +
              `Likely cause: pair-based enricher mis-routed or dropped this row. ` +
              `Re-run scripts/enrich-awards-with-precursors.js.`
          );
        });
      }
    }
  }
});
