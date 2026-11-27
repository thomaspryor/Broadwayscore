// BRO-8407 class guard. shows-write-guard refuses a NEW row whose title is a
// fragment of a catalogued row at the same venue with overlapping dates
// (newRowFragmentFindings). A promoter that dedups only with
// duplicateOfCandidate never sees that pair, mints the row, and the save throws
// for the whole batch ("Sasha Velour's Travesty" beside "Travesty" aborted every
// OB promotion run). Any script that writes through the guard AND dedups with
// duplicateOfCandidate must also ask the fragment detector before it mints a row.
// newRowDuplicate(..., { ticketOnly: true }) does NOT count: it skips the
// fragment pass and checks ticketing identity only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Exempt by name, with the reason. A new entry here needs a reason a reviewer can check.
const EXEMPT = {
  'add-verified-tours.js': 'writes tour rows that are declared pairs of their parent (tourOf), checked for ticketing identity only',
  'create-tour-entries.js': 'writes tour rows that are declared pairs of their parent (tourOf), checked for ticketing identity only',
};

// Reads each newRowDuplicate call as a whole (to the end of its statement), so a call
// split across lines with ticketOnly on a later line is still seen as ticketOnly.
const callText = (src, from) => { const end = src.indexOf(';', from); return src.slice(from, end < 0 ? from + 400 : end); };
const runsFragmentCheck = (src) => /(newRowFragmentFindings|fragmentDuplicateOfCandidate)\s*\(/.test(src)
  || [...src.matchAll(/newRowDuplicate\s*\(/g)].some((m) => !/ticketOnly/.test(callText(src, m.index)));

test('guarded promoters that dedup with duplicateOfCandidate also run the fragment check (BRO-8407)', () => {
  const offenders = [];
  const inspected = [];
  for (const f of fs.readdirSync(SCRIPTS).filter((n) => n.endsWith('.js'))) {
    const src = strip(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'));
    // Any route into the guarded save counts: createShowsWriteGuard(), or the loadShows/saveShows
    // helpers (directly or through the guard module object).
    if (!/createShowsWriteGuard\s*\(|shows-write-guard/.test(src) || !/duplicateOfCandidate\s*\(/.test(src)) continue;
    inspected.push(f);
    if (!EXEMPT[f] && !runsFragmentCheck(src)) offenders.push(f);
  }
  for (const f of ['promote-ob-venue-candidates.js', 'promote-owe-venue-candidates.js']) {
    assert.ok(inspected.includes(f), `${f} must be inspected by this guard`);
  }
  assert.deepEqual(offenders, [], `these write through shows-write-guard but never run the title-fragment check, so one candidate can abort the whole run at save: ${offenders.join(', ')}`);
});

test('the guard rejects a ticketOnly-only newRowDuplicate call (the hole the ship-check found)', () => {
  assert.equal(runsFragmentCheck("const d = newRowDuplicate(s, e, [e.tourOf], { ticketOnly: true });"), false);
  assert.equal(runsFragmentCheck("const d = newRowDuplicate(s, e, []);"), true);
  assert.equal(runsFragmentCheck("const d = newRowDuplicate(\n  s, e, [e.tourOf],\n  { ticketOnly: true },\n);"), false, 'a call split across lines');
  assert.equal(runsFragmentCheck("const f = newRowFragmentFindings(pool, [...pool, entry]);"), true);
  assert.equal(runsFragmentCheck("const f = fragmentDuplicateOfCandidate(pool, entry);"), true);
});
