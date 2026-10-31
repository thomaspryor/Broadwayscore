// BRO-5561: require the actual archive matcher and the audit's link policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkRoundupRunWindow, reviewLinksForShow, classifyLinks, urlDate } = require('./roundup-link-coverage');
const { checkArchiveCategory, checkArchivePageIdentity, readCachedArchiveIfValid } = require('./archive-cache-guard');

const show = { title: 'POTUS', category: 'off-broadway', openingDate: '2026-11-13' };
const page = (urls, kind = 'playbill-verdict', title = 'POTUS', metadata = '') =>
  `<html><head><title>${kind === 'playbill-verdict' ? `Reviews: ${title} | Playbill` : `Review Roundup: ${title} | BroadwayWorld`}</title>${metadata}</head><body>${urls.map((url) =>
    `<a href="${url}">${kind === 'playbill-verdict' ? 'Outlet (Critic)' : 'Outlet:'}</a>`).join('')}</body></html>`;
const old = 'https://nystagereview.com/2022/04/27/potus-review/';
const current = 'https://nystagereview.com/2026/11/13/potus-review/';
const opaque = 'https://www.theatermania.com/news/review-potus_123/';

for (const kind of ['bww-roundups', 'playbill-verdict']) {
  test(`${kind}: actual archive matcher rejects an old production before ingestion`, async () => {
    const html = page([old, 'https://variety.com/2022/legit/reviews/potus/', opaque], kind);
    const result = checkArchiveCategory(html, show, []);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'roundup-review-dates-outside-run');
    assert.equal(result.datedLinks, 2);
    assert.equal(result.outsideLinks, 2);
    let calls = 0;
    const identity = await checkArchivePageIdentity(html, show, [], {
      validatePage: async () => { calls++; return { valid: true }; },
    });
    assert.equal(identity.ok, false);
    assert.equal(calls, 0, 'reject before any paid LLM validation');
  });

  test(`${kind}: a current page survives one stale link; a tie stays inconclusive`, () => {
    assert.equal(checkArchiveCategory(page([current, 'https://example.com/2026/11/14/potus/', old], kind), show).ok, true);
    assert.equal(checkArchiveCategory(page([current, old], kind), show).ok, true);
    assert.equal(checkArchiveCategory(page([opaque], kind), show).ok, true);
  });
}

test('the opening -60d and +120d boundaries are inclusive', () => {
  const s = { ...show, openingDate: '2026-06-01' };
  for (const date of ['2026/04/02', '2026/09/29']) {
    assert.equal(checkRoundupRunWindow(page([`https://example.com/${date}/potus/`]), s, 'playbill-verdict').ok, true, date);
  }
  for (const date of ['2026/04/01', '2026/09/30']) {
    assert.equal(checkRoundupRunWindow(page([`https://example.com/${date}/potus/`]), s, 'playbill-verdict').ok, false, date);
  }
});

test('year/month-only URLs are intervals, so a guessed mid-year date cannot reject a current page', () => {
  assert.equal(checkRoundupRunWindow(page(['https://variety.com/2026/legit/reviews/potus/']), show, 'playbill-verdict').ok, true);
  assert.equal(checkRoundupRunWindow(page(['https://example.com/2026/09/potus/']), show, 'playbill-verdict').ok, true);
  assert.equal(checkRoundupRunWindow(page(['https://variety.com/2022/legit/reviews/potus/']), show, 'playbill-verdict').ok, false);
  assert.equal(urlDate('https://variety.com/2022/legit/reviews/potus/'), '2022-07-01', 'existing audit API stays compatible');
});

test('uses explicit page publication metadata when outlet paths are undated', () => {
  const html = page([opaque], 'playbill-verdict', 'POTUS', '<script type="application/ld+json">{"datePublished":"2022-04-27"}</script>');
  assert.equal(checkArchiveCategory(html, show).reason, 'roundup-page-date-outside-run');
  const fresh = html.replace('2022-04-27', '2026-11-13');
  assert.equal(checkArchiveCategory(fresh, show).ok, true);
});

test('missing or invalid opening dates do not reject; previews provide a fallback', () => {
  for (const s of [{ title: 'POTUS' }, { ...show, openingDate: 'invalid' }]) {
    assert.equal(checkArchiveCategory(page([old]), s).ok, true);
  }
  assert.equal(checkArchiveCategory(page([old]), { title: 'POTUS', previewsStartDate: '2026-11-01' }).ok, false);
});

test('punctuation rescues still have to pass the run-window guard', () => {
  const s = { ...show, title: 'Q.E.D.' };
  assert.equal(checkArchiveCategory(page([old], 'playbill-verdict', 'QED'), s).ok, false);
  assert.equal(checkArchiveCategory(page([current], 'playbill-verdict', 'QED'), s).ok, true);
});

test('evergreen listings are unaffected by dates in their outbound links', () => {
  const html = page([old]).replace('Reviews: POTUS | Playbill', 'POTUS Broadway Reviews | BroadwayWorld');
  assert.equal(checkArchiveCategory(html, show).ok, true);
});

test('a poisoned cache cannot be served even when freshly written', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5561-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'potus.html');
  fs.writeFileSync(file, page([old]));
  const result = readCachedArchiveIfValid(file, 14, show);
  assert.equal(result.valid, false);
  assert.equal(result.check.reason, 'roundup-review-dates-outside-run');
  assert.equal(fs.existsSync(file), false);
});

test('audit policy for 2026 runs removes every link from a rejected archive, including undated links', () => {
  const pages = [page([old, opaque]), page([current, old]), page([opaque])];
  const links = pages.flatMap((html) => reviewLinksForShow(html, 'playbill-verdict', show));
  assert.equal(links.length, 2, 'retain the current link and the inconclusive undated page');
  const rows = classifyLinks(links, [], []);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => urlDate(row.url) && urlDate(row.url).slice(0, 4) !== '2026').length, 0);
});

test('The Pass: nearby NYC and London openings still require the headline venue to match', () => {
  const html = page(['https://nystagereview.com/2026/08/03/the-pass/'], 'bww-roundups', 'THE PASS Opens at La MaMa');
  const london = { title: 'The Pass', category: 'off-west-end', openingDate: '2026-09-17', venue: 'Pearly Queen Theatre' };
  assert.equal(checkArchiveCategory(html, london).reason, 'roundup-venue-market-mismatch');
  const nyc = { ...london, category: 'off-broadway', openingDate: '2026-08-04', venue: 'Ellen Stewart Theatre at La MaMa' };
  assert.equal(checkArchiveCategory(html, nyc).ok, true);
});

test('tour roundups can accumulate reviews beyond the initial opening window', () => {
  assert.equal(checkArchiveCategory(page([current]), { ...show, category: 'tour', openingDate: '2024-01-01' }).ok, true);
});


test('company abbreviations and venue aliases do not create false production mismatches', () => {
  const cases = [
    ['All-Male AS YOU LIKE IT Opens at the RSC, Starring Jonathan Groff', 'As You Like It', 'Royal Shakespeare Theatre, Stratford-upon-Avon', 'regional'],
    ['CHINESE REPUBLICANS Opens at Roundabout Theatre Company', 'Chinese Republicans', 'The Laura Pels Theatre at the Harold and Miriam Steinberg Center for Theatre', 'off-broadway'],
    ['THE ASSEMBLED PARTIES Opens at MTC - All the Reviews!', 'The Assembled Parties', 'Samuel J. Friedman Theatre', 'broadway'],
    ['POTUS Opens at Soho Theatre', 'POTUS', 'Soho Theatre', 'off-west-end'],
  ];
  for (const [headline, title, venue, category] of cases) {
    const s = { title, venue, category, openingDate: '2026-11-13' };
    assert.equal(checkArchiveCategory(page([current], 'bww-roundups', headline), s).ok, true, headline);
  }
});
