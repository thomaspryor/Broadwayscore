// BRO-7545: theatre.reviews edits a premiere's round-up to add the transfer's
// reviews (1536 Almeida -> Ambassadors, Into the Woods Bridge -> Noël Coward).
// The post date matched the whole page to the premiere id, so the transfer's
// reviews landed on the premiere and the transfer got none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { productionHeading, resolveSection, resolveSections, otherSectionOwners } = require('./tr-production-sections');
const { extractReviews, extractReviewsWithSections } = require('../scrape-theatre-reviews');

const premiere = { id: 'play-off-west-end-2025', title: 'Play', category: 'off-west-end', venue: 'Almeida Theatre', openingDate: '2025-05-13', closingDate: '2025-06-07' };
const transfer = { id: 'play-west-end-2026', title: 'Play', category: 'west-end', venue: 'Ambassadors Theatre', openingDate: '2026-05-12', closingDate: '2026-08-01' };
const broadway = { id: 'play-2027', title: 'Play', category: 'broadway', venue: 'Booth Theatre', openingDate: '2027-04-01' };
const shows = [premiere, transfer, broadway];

const row = (outlet, critic, quote) => `<p><a href="https://${outlet.toLowerCase().replace(/\W/g, '')}.example/review">${outlet}</a>’s ${critic} wrote: ‘${quote}’</p>`;
const page = (h1, h2) => `<html><body><div class="entry-content">
  <h5>Almeida Theatre / Ambassadors Theatre</h5>
  <p>Intro paragraph about the transfer.</p>
  <h4>${h1}</h4>
  <p>5 stars ⭑⭑⭑⭑⭑</p>
  ${row('The Standard', 'Nick Curtis', 'every bit as arresting and electrifying as it was last year')}
  ${row('Time Out', 'Isobel Lewis', 'a once-in-a-blue-moon theatrical experience for everyone')}
  <p>Play can be seen at the Ambassadors Theatre until 1 August 2026.</p>
  <h4>${h2}</h4>
  <p>4 stars ⭑⭑⭑⭑</p>
  ${row('The Guardian', 'Miriam Gillinson', 'an effortlessly funny, bold and ballsy play indeed')}
  <p>Play was at the Almeida until 7 June 2025 and <a href="https://theatre.example">Buy tickets from the theatre here.</a> until 1 August 2026.</p>
</div></body></html>`;

test('productionHeading reads only "Reviews for/from/of ..." headings', () => {
  assert.equal(productionHeading('Reviews for the West End transfer'), 'West End transfer');
  assert.equal(productionHeading('Reviews of the premiere at The Almeida'), 'premiere at The Almeida');
  assert.equal(productionHeading('Reviews from the transfer to the Noël Coward Theatre'), 'transfer to the Noël Coward Theatre');
  assert.equal(productionHeading('Post navigation'), null);
});

test('sections resolve by named venue, then by "West End", never to a non-London sibling', () => {
  const sibs = [premiere, transfer];
  assert.equal(resolveSection('premiere at The Almeida', sibs), premiere.id);
  assert.equal(resolveSection('West End transfer', sibs), transfer.id);
  assert.equal(resolveSection('transfer to the Ambassadors Theatre', sibs), transfer.id);
  assert.deepEqual(resolveSections(['West End transfer', 'premiere at The Almeida'], premiere, shows), [transfer.id, premiere.id]);
  assert.equal(resolveSections(['only one heading'], premiere, shows), null);
});

test('without a venue or West End cue, priorRuns decide; with no link nothing is guessed', () => {
  const later = { ...transfer, category: 'off-west-end', priorRuns: [{ id: premiere.id, venue: premiere.venue }] };
  assert.equal(resolveSection('transfer', [premiere, later]), later.id);
  assert.equal(resolveSection('original production', [premiere, later]), premiere.id);
  const unlinked = { ...transfer, category: 'off-west-end' };
  assert.equal(resolveSection('transfer', [premiere, unlinked]), null);
});

test('a two-production page gives each production only its own section', () => {
  const html = page('Reviews for the West End transfer', 'Reviews of the premiere at The Almeida');
  const t = extractReviews(html, transfer.id, { shows });
  assert.deepEqual(t.map((r) => [r.outlet, r.stars]), [['The Standard', 5], ['Time Out', 5]]);
  const p = extractReviewsWithSections(html, premiere.id, { shows });
  assert.deepEqual(p.rows.map((r) => [r.outlet, r.stars]), [['The Guardian', 4]]);
  assert.equal(p.dropped, 2);
  assert.deepEqual(otherSectionOwners(p.owners, premiere.id), [transfer.id]);
  // The unsplit page is still available to callers that ask for it.
  assert.equal(extractReviews(html, premiere.id, { shows, allSections: true }).length, 3);
});

test('an unresolvable section is dropped, not given to the show the page was matched to', () => {
  const html = page('Reviews for the Edinburgh run', 'Reviews of the premiere at The Almeida');
  assert.deepEqual(extractReviews(html, premiere.id, { shows }).map((r) => r.outlet), ['The Guardian']);
  assert.deepEqual(extractReviews(html, transfer.id, { shows }), []);
});

test('a single-production page and an untracked sibling keep every row', () => {
  const single = page('Reviews for the West End transfer', 'Reviews of the premiere at The Almeida')
    .replace(/<h4>Reviews of the premiere at The Almeida<\/h4>/, '');
  assert.equal(extractReviews(single, premiere.id, { shows }).length, 3);
  const html = page('Reviews for the West End transfer', 'Reviews of the premiere at The Almeida');
  assert.equal(extractReviews(html, premiere.id, { shows: [premiere] }).length, 3);
});

test('run-dates boilerplate with a ticket link is not a review row', () => {
  const html = page('Reviews for the West End transfer', 'Reviews of the premiere at The Almeida');
  const all = extractReviews(html, premiere.id, { shows, allSections: true });
  assert.ok(!all.some((r) => /tickets/i.test(r.outlet)), JSON.stringify(all.map((r) => r.outlet)));
});

// Ship-check follow-ups on BRO-7545.
const withPreamble = () => page('Reviews for the West End transfer', 'Reviews of the premiere at The Almeida')
  .replace('<p>Intro paragraph about the transfer.</p>',
    `<p>4 stars ⭑⭑⭑⭑</p>${row('The Stage', 'Sam Marlowe', 'deliciously natural together, funny and irreverent and tender')}`);

test('rows above the first heading go only to the matched production, never to both', () => {
  const html = withPreamble();
  const outlets = (id, matchedShowId) => extractReviews(html, id, { shows, matchedShowId }).map((r) => r.outlet);
  assert.ok(outlets(premiere.id, premiere.id).includes('The Stage'));
  assert.ok(!outlets(transfer.id, premiere.id).includes('The Stage'));
  // Matched show unknown (an archive read by another consumer): nobody gets them.
  assert.ok(!outlets(premiere.id, undefined).includes('The Stage'));
  assert.ok(!outlets(transfer.id, undefined).includes('The Stage'));
});

test('an unresolved section is reported with page and heading, not dropped silently', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (m) => warnings.push(String(m)));
  const html = page('Reviews for the Edinburgh run', 'Reviews of the premiere at The Almeida')
    .replace('<html>', '<html><head><link rel="canonical" href="https://theatre.reviews/reviews-roundup/play-unresolved-reviews/"></head>');
  const r = extractReviewsWithSections(html, premiere.id, { shows, matchedShowId: premiere.id });
  assert.deepEqual(r.unresolved, [{ heading: 'Edinburgh run', rows: 2 }]);
  const w = warnings.find((m) => m.includes('Edinburgh run'));
  assert.ok(w, `no warning logged: ${JSON.stringify(warnings)}`);
  assert.match(w, /play-unresolved-reviews/);
  assert.match(w, /2 row\(s\)/);
  assert.ok(!/arresting|blue-moon/.test(w), 'warning must not carry review text');
});

test('the transfer archive copy is written once and left alone while unchanged', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { writeSectionArchive } = require('../scrape-theatre-reviews');
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-section-'));
  t.after(() => fs.rmSync(archiveDir, { recursive: true, force: true }));
  const index = {};
  const args = { archiveDir, index, showId: transfer.id, url: 'https://theatre.reviews/reviews-roundup/play-reviews/', modified: '2026-05-16', html: '<p>v1</p>', sectionOf: premiere.id, dryRun: false };
  assert.equal(writeSectionArchive(args), true);
  const first = index[transfer.id].fetchedAt;
  assert.equal(writeSectionArchive(args), false);
  assert.equal(index[transfer.id].fetchedAt, first);
  assert.equal(writeSectionArchive({ ...args, html: '<p>v2</p>' }), true);
  assert.equal(fs.readFileSync(path.join(archiveDir, `${transfer.id}.html`), 'utf8'), '<p>v2</p>');
  assert.equal(writeSectionArchive({ ...args, html: '<p>v2</p>', url: 'https://theatre.reviews/reviews-roundup/other-reviews/' }), true);
  assert.equal(writeSectionArchive({ ...args, dryRun: true, html: '<p>v3</p>' }), false);
});
