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
