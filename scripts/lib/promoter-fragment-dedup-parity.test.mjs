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
// Drops block comments, whole-line comments and trailing comments (a trailing // only when no quote
// follows it on the line, so a URL inside a string is kept), so a name in a comment cannot satisfy a check.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/[^'"`\n]*$/gm, '');

// Exempt by name, with the reason. A new entry here needs a reason a reviewer can check.
const EXEMPT = {
  'add-verified-tours.js': 'writes tour rows that are declared pairs of their parent (tourOf), checked for ticketing identity only',
  'create-tour-entries.js': 'writes tour rows that are declared pairs of their parent (tourOf), checked for ticketing identity only',
  'apply-orphan-production.js': 'mints operator-authored specs (BRO-7929) that carry their own distinctFrom; an id-only check by design, and the guard error names the pair',
  'test-discovery-flow.js': 'test harness: pushes one fixture row, then restores the backup of shows.json',
  'enrich-west-end-dates.js': 'its shows.push builds a {title, tmSlug} lookup list, not catalogue rows',
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
    // A script is in scope when it can save through the guard AND either dedups with duplicateOfCandidate
    // or adds rows to the list it saves (shows.push / toAdd.push). A script with no dedup at all is the
    // worst case, so the trigger cannot depend on duplicateOfCandidate.
    const savesThroughGuard = /createShowsWriteGuard\s*\(|shows-write-guard/.test(src);
    const mintsRows = /duplicateOfCandidate\s*\(|\bshows\.push\(|\btoAdd\.push\(/.test(src);
    if (!savesThroughGuard || !mintsRows) continue;
    inspected.push(f);
    if (!EXEMPT[f] && !runsFragmentCheck(src)) offenders.push(f);
  }
  for (const f of ['promote-ob-venue-candidates.js', 'promote-owe-venue-candidates.js', 'discover-opera-shows.js']) {
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
  // A name that only appears in a comment must not satisfy the check.
  assert.equal(runsFragmentCheck(strip("x(); // fragmentDuplicateOfCandidate(pool, e)")), false, 'trailing comment');
  assert.equal(runsFragmentCheck(strip("/* newRowFragmentFindings( */ x();")), false, 'block comment');
  assert.equal(runsFragmentCheck(strip("const u = 'https://x.test/a'; const f = fragmentDuplicateOfCandidate(pool, e);")), true, 'a URL in a string is not a comment');
});
