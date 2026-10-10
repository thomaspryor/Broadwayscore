/**
 * Regression test for the per-performer DL "Distinguished Performance Award"
 * chip-render logic. DL gives ONE Distinguished Performance per year and it
 * goes to one specific performer in one show. The chip should only render
 * next to that performer's Tony nomination — not next to every acting
 * nominee from the winning show.
 *
 * The data contract:
 *   - show.dramaLeague.wins includes 'Distinguished Performance Award'
 *   - show.dramaLeague.winnerNames['Distinguished Performance Award']
 *     contains the winning performer's name (array supports ties)
 *
 * The chip render contract (src/lib/data-tony-predictions.ts getPrecursorWins):
 *   - Returns 'DL' only when nomineeName matches a name in winnerNames
 *   - For show-level DL awards (e.g. 'Outstanding Revival of a Musical'),
 *     nomineeName is not consulted (those are inherently show-level).
 *
 * Run: node --test tests/unit/dl-distinguished-performance-chip.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const AWARDS_FILE = path.join(__dirname, '..', '..', 'data', 'awards.json');

const awards = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));

describe('DL Distinguished Performance Award — data contract', () => {
  it('ragtime-2025.dramaLeague.wins includes Distinguished Performance Award', () => {
    const dl = awards.shows['ragtime-2025']?.dramaLeague;
    assert.ok(dl, 'ragtime-2025.dramaLeague missing');
    assert.ok(
      (dl.wins || []).includes('Distinguished Performance Award'),
      `expected Distinguished Performance Award in wins; got ${JSON.stringify(dl.wins)}`
    );
  });

  it('ragtime-2025.dramaLeague.winnerNames attributes the win to Joshua Henry', () => {
    const dl = awards.shows['ragtime-2025']?.dramaLeague;
    const names = dl.winnerNames?.['Distinguished Performance Award'];
    assert.ok(Array.isArray(names), 'winnerNames["Distinguished Performance Award"] must be an array');
    assert.deepStrictEqual(names, ['Joshua Henry'],
      `expected ['Joshua Henry']; got ${JSON.stringify(names)}`);
  });

  // Schema-level pin: any show that has the win MUST have a winnerNames entry,
  // otherwise the chip won't render anywhere (silent data error).
  it('every show with Distinguished Performance Award win has a winnerNames entry', () => {
    const missing = [];
    for (const [showId, show] of Object.entries(awards.shows)) {
      const wins = show.dramaLeague?.wins || [];
      if (!wins.includes('Distinguished Performance Award')) continue;
      const names = show.dramaLeague?.winnerNames?.['Distinguished Performance Award'];
      if (!Array.isArray(names) || names.length === 0) {
        missing.push(showId);
      }
    }
    assert.deepStrictEqual(missing, [],
      `Shows with DL Distinguished Performance Award but no winnerNames: ${missing.join(', ')}`);
  });
});
