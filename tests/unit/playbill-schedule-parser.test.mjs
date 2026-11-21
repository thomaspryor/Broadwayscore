/**
 * Locks the Playbill schedule parser against the three defects found on
 * 2026-08-13, when the owner asked why five announced Broadway shows were
 * missing from the site.
 *
 * Root cause of the miss was upstream (Broadway discovery read TodayTix only,
 * which lists on-sale shows), but fixing that exposed three parser bugs that
 * would have re-created the same silent gap:
 *
 *   1. Title anchors: the regex required bare text inside <a>, so entries
 *      written <a><strong>TITLE</strong></a> parsed to NOTHING while other
 *      entries on the same page parsed fine — a partial success that no
 *      "empty result" alarm can catch.
 *   2. Venue: Broadway labels it "Theatre: X" on a <br> line; the Off-Broadway
 *      bullet-only extractor returned null for every Broadway row.
 *   3. Dates: "February 2027" (month, no day) parsed as day 20 of February in
 *      the CURRENT year — a confidently wrong date, in the past, for a show
 *      with no announced date.
 *
 * Calls the real parser (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePlaybillOBSchedule, extractVenue } = require('../../scripts/lib/playbill-ob-schedule.js');

const BROADWAY_HTML = `<html><head><title>Schedule of Upcoming and Announced Broadway Shows | Playbill</title></head><body>
<p><strong></strong><strong><a href="http://playbill.com/article/wanted"><strong>WANTED</strong></a></strong><br>Theatre: James Earl Jones Theatre<br>First Preview: October 15, 2026<br>Opening: November 8, 2026<br>Starring: Someone</p>
<p><a href="http://playbill.com/article/galileo"><strong>GALILEO</strong></a><br>
Theatre: Shubert Theatre<br>First Preview: November 10, 2026<br>Opening: December 6, 2026<br></p>
<p><strong><a href="http://playbill.com/article/much-ado">MUCH ADO ABOUT NOTHING</a></strong><br>Theatre: Winter Garden Theatre<br>First Preview: October 31, 2026<br>Opening: November 19, 2026<br></p>
<p><a href="http://playbill.com/article/three-days"><strong>THREE DAYS OF RAIN</strong></a><br>First Preview: February 2027<br>Writer: Richard Greenberg</p>
<p><a href="/about">Some nav link</a></p>
</body></html>`;

function byTitle(entries, name) {
  return entries.find(e => e.title.toUpperCase().includes(name));
}

test('parses BOTH anchor shapes — nested <strong> inside <a>, and <a> inside <strong>', () => {
  const entries = parsePlaybillOBSchedule(BROADWAY_HTML, { market: 'Announced Broadway' });
  // WANTED is <strong><a><strong>…, GALILEO is <a><strong>…, MUCH ADO is <strong><a>…
  for (const name of ['WANTED', 'GALILEO', 'MUCH ADO ABOUT NOTHING']) {
    assert.ok(byTitle(entries, name), `${name} must parse — it was dropped by the bare-text-only regex`);
  }
});

test('extracts the Broadway "Theatre:" venue, not just Off-Broadway bullets', () => {
  const entries = parsePlaybillOBSchedule(BROADWAY_HTML, { market: 'Announced Broadway' });
  assert.equal(byTitle(entries, 'WANTED').venue, 'James Earl Jones Theatre');
  assert.equal(byTitle(entries, 'GALILEO').venue, 'Shubert Theatre');
});

test('the Off-Broadway bullet venue format still works', () => {
  const plain = 'THE REAL IVANOV\n• Lynn F. Angelson Theater\n• First Preview: August 17, 2026\n';
  assert.equal(extractVenue(plain), 'Lynn F. Angelson Theater');
});

test('a month-with-no-day never becomes a fabricated day-of-month', () => {
  const entries = parsePlaybillOBSchedule(BROADWAY_HTML, { market: 'Announced Broadway' });
  const tdr = byTitle(entries, 'THREE DAYS OF RAIN');
  // Either dropped for having no usable date, or present with null dates —
  // what must NEVER happen is a concrete date invented from the year digits.
  if (tdr) {
    assert.equal(tdr.firstPreview, null, 'February 2027 must not parse to a specific day');
    assert.equal(tdr.opening, null);
  }
  const all = JSON.stringify(entries);
  assert.ok(!all.includes('2026-02-20'), 'must not turn "February 2027" into 2026-02-20');
});

test('exact dates are preserved verbatim', () => {
  const entries = parsePlaybillOBSchedule(BROADWAY_HTML, { market: 'Announced Broadway' });
  const w = byTitle(entries, 'WANTED');
  assert.equal(w.firstPreview, '2026-10-15');
  assert.equal(w.opening, '2026-11-08');
});

test('refuses to parse when the page title does not match the market', () => {
  // Guards against silently parsing a redirected/renamed article.
  const entries = parsePlaybillOBSchedule(BROADWAY_HTML, { market: 'Off-Broadway' });
  assert.deepEqual(entries, []);
});

test('nav/body links without date lines are not mistaken for shows', () => {
  const entries = parsePlaybillOBSchedule(BROADWAY_HTML, { market: 'Announced Broadway' });
  assert.ok(!byTitle(entries, 'SOME NAV LINK'), 'links with no First Preview/Opening must be ignored');
});
