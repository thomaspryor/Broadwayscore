import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { monthsBetween, standardReviewUrls, matchStandardSlugs, candidateWindow } = createRequire(import.meta.url)('./we-sitemap-candidates.js');

const U = (s) => `https://www.standard.co.uk/culture/theatre/${s}.html`;

test('monthsBetween spans a year boundary', () => {
  assert.deepEqual(monthsBetween('2012-11-20', '2013-01-05'), ['2012-11', '2012-12', '2013-01']);
});

test('standardReviewUrls keeps only theatre review slugs', () => {
  const xml = `<urlset><url><loc>${U('cabaret-savoy-theatre-review-8800001')}</loc></url>
  <url><loc>https://www.standard.co.uk/going-out/bars/best-bars-8820287.html</loc></url>
  <url><loc>${U('laurence-fox-on-his-new-west-end-role-8915734')}</loc></url></urlset>`;
  assert.deepEqual(standardReviewUrls(xml), [U('cabaret-savoy-theatre-review-8800001')]);
});

test('matches a title-first slug with the right venue', () => {
  const show = { title: 'The Scottsboro Boys', venue: 'Garrick Theatre' };
  assert.deepEqual(matchStandardSlugs(show, [U('the-scottsboro-boys-garrick-theatre-review-8912729')]), [U('the-scottsboro-boys-garrick-theatre-review-8912729')]);
});

test('rejects a slug naming another venue (another production)', () => {
  const show = { title: 'The Scottsboro Boys', venue: 'Garrick Theatre' };
  assert.deepEqual(matchStandardSlugs(show, [U('the-scottsboro-boys-young-vic-theatre-review-8912729')]), []);
});

test('rejects a longer title that merely starts with the show title', () => {
  const show = { title: 'Cabaret', venue: 'Savoy Theatre' };
  assert.deepEqual(matchStandardSlugs(show, [U('cabaret-lounge-orange-tree-theatre-review-1')]), []);
});

test('bare-title slug passes through to the ingest guards; too many hits are dropped', () => {
  const show = { title: 'Betrayal', venue: 'Harold Pinter Theatre' };
  assert.equal(matchStandardSlugs(show, [U('betrayal-theatre-review-1')]).length, 1);
  const many = [1, 2, 3, 4].map((n) => U(`betrayal-theatre-review-${n}`));
  assert.deepEqual(matchStandardSlugs(show, many), []);
});

test('candidateWindow uses the first performance', () => {
  assert.deepEqual(candidateWindow({ openingDate: '2013-10-01' }), { lo: '2013-09-17', hi: '2013-12-15' });
  assert.equal(candidateWindow({}), null);
});

test('2015+ slugs carry the headline after "theatre-review"', () => {
  const show = { title: 'Hangmen', venue: "Wyndham's Theatre" };
  const u = 'https://www.standard.co.uk/theatre/hangmen-theatre-review-blackest-of-black-comedies-a3132091.html';
  assert.deepEqual(standardReviewUrls(`<loc>${u}</loc>`), [u]);
  assert.deepEqual(matchStandardSlugs(show, [u]), [u]);
});

test('"the musical" in a slug is not a venue', () => {
  const u = 'https://www.standard.co.uk/theatre/elf-the-musical-review-a-charming-evening-a3108286.html';
  assert.deepEqual(matchStandardSlugs({ title: 'Elf', venue: 'Dominion Theatre' }, [u]), [u]);
});

test('two headline-form slugs for the same title are ambiguous', () => {
  const urls = [
    'https://www.standard.co.uk/culture/theatre/macbeth-review-earthy-urgent-a3795191.html',
    'https://www.standard.co.uk/culture/theatre/macbeth-review-bloody-brilliant-a3795999.html',
  ];
  assert.deepEqual(matchStandardSlugs({ title: 'Macbeth', venue: 'Trafalgar Studios' }, urls), []);
  assert.deepEqual(matchStandardSlugs({ title: 'Macbeth', venue: 'Trafalgar Studios' }, urls.slice(0, 1)), urls.slice(0, 1));
});

test('a shared venue word is not enough (Old Vic vs Young Vic, Royal Haymarket vs Royal Bath)', () => {
  const hamlet = (venue) => ({ title: 'Hamlet', venue });
  const oldVic = [U('hamlet-old-vic-theatre-review-8000001')];
  const bath = [U('hamlet-theatre-royal-bath-review-8000002')];
  assert.deepEqual(matchStandardSlugs(hamlet('Young Vic'), oldVic), []);
  assert.deepEqual(matchStandardSlugs(hamlet('Theatre Royal Haymarket'), bath), []);
  assert.deepEqual(matchStandardSlugs(hamlet('Old Vic'), oldVic), oldVic);
  assert.deepEqual(matchStandardSlugs(hamlet("Duke of York's Theatre"), [U('hamlet-duke-of-yorks-theatre-review-8000003')]).length, 1);
});

test('bodyNamesVenue requires the venue in a headline-form article', () => {
  const { bodyNamesVenue } = createRequire(import.meta.url)('./we-sitemap-candidates.js');
  assert.equal(bodyNamesVenue('A gripping Macbeth at the Young Vic last night', 'Trafalgar Studios'), false);
  assert.equal(bodyNamesVenue('Macbeth at Trafalgar Studios was gripping', 'Trafalgar Studios'), true);
  assert.equal(bodyNamesVenue('anything', ''), true);
});
