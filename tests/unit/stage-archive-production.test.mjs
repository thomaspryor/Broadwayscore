import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkArchiveCategory } = require('../../scripts/lib/archive-cache-guard');
const { extractPageDateFromHtml, resolveProductionByPageDate } = require('../../scripts/lib/aggregator-page-production');

// The Stage's legacy browser archives expose the main article date as visible
// text, with no JSON-LD, OpenGraph date or <time datetime>. No review text needed.
const page = (title, date, extra = '') => `<html><head><title>${title}</title>
<meta property="og:site_name" content="The Stage"></head><body>${extra}
<div class="aos-FeatureArticle"><h1>${title}</h1>
<div class="aos-ArticleMetaData"><span class="aos-ArticleDate">${date}</span></div>
</div></body></html>`;

const cases = [
  { title: 'Hadestown', pageTitle: "Anais Mitchell's Hadestown at the National Theatre, London - review round-up", date: 'Nov 15, 2018', openingDate: '2024-02-22' },
  { title: 'Inter Alia', pageTitle: 'Inter Alia starring Rosamund Pike - review round-up', date: 'Jul 28, 2025', openingDate: '2026-04-07' },
  { title: 'Romeo and Juliet', pageTitle: 'Romeo and Juliet directed by Rebecca Frecknall - review round-up', date: 'Jun 20, 2023', openingDate: '2026-03-31' },
  { title: 'Blood of my Blood', pageTitle: 'Juniper Blood at the Donmar Warehouse - review round-up', date: 'Aug 28, 2025', openingDate: '2026-10-07' },
];

for (const row of cases) {
  test(`BRO-7544: reject the wrong Stage archive for ${row.title}`, () => {
    const check = checkArchiveCategory(page(row.pageTitle, row.date), { ...row, category: 'west-end' }, []);
    assert.equal(check.ok, false, JSON.stringify(check));
    assert.equal(check.reason, 'roundup-page-date-outside-run');
  });
}

test('read the main Stage article date, ignoring related cards and their metadata', () => {
  const related = '<div class="aos-Article-RelatedContent"><div class="aos-ArticleMetaData"><span class="aos-ArticleDate">Jun 20, 2023</span></div></div>'
    + '<script type="application/ld+json">{"datePublished":"2023-06-20"}</script>';
  const html = page('Inter Alia - review round-up', 'Apr 8, 2026').replace('<h1>', `${related}<h1>`);
  assert.equal(extractPageDateFromHtml(html), '2026-04-08');
  assert.equal(extractPageDateFromHtml(page('Inter Alia - review round-up', 'Feb 30, 2026')), null);
});

test('reject a later revival archived under a closed production', () => {
  const show = { title: 'Inter Alia', category: 'west-end', openingDate: '2025-07-10', closingDate: '2025-09-13' };
  const check = checkArchiveCategory(page('Inter Alia - review round-up', 'Apr 8, 2026'), show, []);
  assert.equal(check.ok, false);
  assert.equal(check.pageDate, '2026-04-08');
});

test('keep a current production and a declared prior run', () => {
  const html = page('Inter Alia - review round-up', 'Jul 28, 2025');
  const show = { title: 'Inter Alia', category: 'west-end', openingDate: '2025-07-10', closingDate: '2025-09-13' };
  assert.equal(checkArchiveCategory(html, show, []).ok, true);
  const transfer = { ...show, openingDate: '2026-04-07', closingDate: '2026-06-20',
    priorRuns: [{ openingDate: '2025-07-10', closingDate: '2025-09-13' }] };
  assert.equal(checkArchiveCategory(html, transfer, []).ok, true);
});

test('route a legacy Stage archive by its visible date before the archive guard runs', () => {
  const current = { id: 'inter-alia-2026', title: 'Inter Alia', category: 'west-end', openingDate: '2026-04-07' };
  const earlier = { ...current, id: 'inter-alia-2025', openingDate: '2025-07-10', closingDate: '2025-09-13' };
  const route = resolveProductionByPageDate({ html: page('Inter Alia - review round-up', 'Jul 28, 2025'), show: current,
    rematch(date) { assert.equal(date, '2025-07-28'); return earlier; } });
  assert.equal(route.rerouted, true);
  assert.equal(route.show.id, earlier.id);
});

test('an undated Stage page and evergreen listings retain the existing policy', () => {
  const show = { title: 'Hadestown', category: 'west-end', openingDate: '2024-02-22' };
  assert.equal(checkArchiveCategory(page('Hadestown - review round-up', ''), show, []).ok, true);
  const listing = '<html><head><title>Hadestown Reviews</title></head><body>'
    + '<time datetime="2018-11-15">2018</time></body></html>';
  assert.equal(checkArchiveCategory(listing, show, []).ok, true);
});
