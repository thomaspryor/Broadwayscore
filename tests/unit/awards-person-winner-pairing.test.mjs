/**
 * Regression test for the pair-based person-winner attribution shipped
 * 2026-05-24. Pins three production-data invariants in data/awards.json.
 *
 * Background: Wikipedia DD/OCC/DL/Lortel category pages list nominees as
 * [winner_person, winner_show, loser_show, loser_show, ...] for performance
 * and design categories. The old enricher resolved person→show only via
 * Tony nominations, so off-Broadway shows (Kenrex, Mexodus, etc.) and shows
 * where a person is Tony-nominated for a DIFFERENT production than they
 * DD-won at (John Lithgow: Tony-nom for Giant, DD-win for Well I'll Let
 * You Go) were silently dropped or miscredited.
 *
 * Fix: pair-based primary, Tony fallback only when winner is absent from
 * nominees, per-winner cleanup of stale Tony-mismapped attributions.
 * scripts/enrich-awards-with-precursors.js applyDDOCCDL ~ line 449.
 *
 * Run: node --test tests/unit/awards-person-winner-pairing.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const AWARDS_FILE = path.join(__dirname, '..', '..', 'data', 'awards.json');
const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
const shows = awards.shows || awards;

describe('Pair-based person-winner attribution — production data pins', () => {
  it('Kenrex receives both 2026 Drama Desk person-name wins (off-Broadway, not Tony-eligible)', () => {
    const dd = shows['kenrex-off-broadway-2026']?.dramadesk;
    assert.ok(dd, 'kenrex-off-broadway-2026.dramadesk missing');
    const wins = dd.wins || [];
    assert.ok(
      wins.includes('Outstanding Music in a Play'),
      `expected DD Music in a Play; got ${JSON.stringify(wins)}`
    );
    assert.ok(
      wins.includes('Outstanding Solo Performance'),
      `expected DD Solo Performance; got ${JSON.stringify(wins)}`
    );
    // Pair-based produces winnerNames for these (the prior Tony-only path
    // silently dropped them entirely).
    assert.deepStrictEqual(dd.winnerNames?.['Outstanding Music in a Play'], ['John Patrick Elliot']);
    assert.deepStrictEqual(dd.winnerNames?.['Outstanding Solo Performance'], ['Jack Holden']);
  });

  it('Lithgow DD 2026 Lead Performance routes to the show he won at, not the show he was Tony-nominated for', () => {
    // John Lithgow won DD 2026 Outstanding Lead Performance in a Play for
    // Well, I'll Let You Go (off-Broadway). He is Tony-nominated for Giant
    // in the same 2025-26 season. Pre-fix, Tony lookup miscredited the DD
    // win to giant-2026. Pair-based must route to the actual DD-winning show.
    const wellWins = shows['well-ill-let-you-go-off-broadway-2026']?.dramadesk?.wins || [];
    assert.ok(
      wellWins.includes('Outstanding Lead Performance in a Play'),
      `expected well-ill-let-you-go to have DD Lead Performance; got ${JSON.stringify(wellWins)}`
    );
    const giantWins = shows['giant-2026']?.dramadesk?.wins || [];
    assert.ok(
      !giantWins.includes('Outstanding Lead Performance in a Play'),
      `giant-2026 must NOT have DD Lead Performance (Lithgow's Tony show != his DD-winning show); got ${JSON.stringify(giantWins)}`
    );
  });

  it('Tie-winners going to different shows split correctly (Henry@Ragtime, Levy@Chess)', () => {
    // DD 2026 Outstanding Lead Performance in a Musical was a tie:
    //   Joshua Henry (Ragtime)
    //   Caissie Levy (Chess)
    // Each winner must land on their own show. Per-winner cleanup must
    // strip the OTHER show from each — Levy is Tony-nominated for Ragtime
    // (she's in Ragtime per Tony noms) and Henry is in Ragtime; the prior
    // logic let Levy's name leak into ragtime-2025.winnerNames.
    const ragNames = shows['ragtime-2025']?.dramadesk?.winnerNames?.['Outstanding Lead Performance in a Musical'];
    assert.deepStrictEqual(ragNames, ['Joshua Henry'],
      `ragtime-2025 Lead Performance must be Henry only; got ${JSON.stringify(ragNames)}`);
    const chessNames = shows['chess-2025']?.dramadesk?.winnerNames?.['Outstanding Lead Performance in a Musical'];
    assert.deepStrictEqual(chessNames, ['Caissie Levy'],
      `chess-2025 Lead Performance must be Levy only; got ${JSON.stringify(chessNames)}`);
  });

  it('OB→Broadway transfer wins survive cleanup (Hamilton 2015 OB wins on hamilton-2015)', () => {
    // hamilton-2015 has dramadesk.season = "2015-16" (its primary Tony
    // season). DD 2015 OB run attributed multiple wins to hamilton-2015.
    // The cleanup pass must NOT strip these when DD 2016 row processes
    // a different show — it must only strip Tony-mismapped attributions
    // per-winner, never broad season sweeps.
    const wins = shows['hamilton-2015']?.dramadesk?.wins || [];
    const expected = [
      'Outstanding Book of a Musical',
      'Outstanding Featured Actress in a Musical',
      'Outstanding Lyrics',
      'Outstanding Music',
      'Outstanding Musical',
    ];
    for (const cat of expected) {
      assert.ok(wins.includes(cat),
        `hamilton-2015 must keep DD ${cat} (OB→Broadway transfer); got ${JSON.stringify(wins)}`);
    }
  });

  it('Hand-curated DL Distinguished Performance Award + winnerNames not wiped by enricher', () => {
    // DL DPA precursor data has winner=null (Wikipedia doesn't post a winner
    // entry for current years). Ragtime/Joshua Henry was hand-curated in
    // awards.json. Cleanup must not strip categories whose source rows have
    // a null winner — guarded by `personWinnerShowMap.size > 0`.
    const dl = shows['ragtime-2025']?.dramaLeague;
    assert.ok((dl?.wins || []).includes('Distinguished Performance Award'),
      `ragtime-2025.dramaLeague.wins must include Distinguished Performance Award`);
    assert.deepStrictEqual(dl?.winnerNames?.['Distinguished Performance Award'], ['Joshua Henry'],
      `ragtime-2025.dramaLeague.winnerNames must preserve Joshua Henry`);
  });
});
