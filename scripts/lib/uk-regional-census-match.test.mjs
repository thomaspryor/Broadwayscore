import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchItem, inWindow } = require('./uk-regional-census-match.js');

const show = (o) => ({ status: 'closed', closingDate: null, ...o });
const crucibleLear = show({ id: 'king-lear-crucible-regional-2026', title: 'King Lear', venue: 'Crucible Theatre, Sheffield', city: 'sheffield-uk', openingDate: '2026-09-01' });
const exchangeLear = show({ id: 'king-lear-royal-exchange-regional-2026', title: 'King Lear', venue: 'Royal Exchange Theatre, Manchester', city: 'manchester-uk', openingDate: '2026-09-10' });
const magic = show({ id: 'magic-chichester-festival-regional-2026', title: 'Magic', venue: 'Chichester Festival Theatre, Chichester', city: 'chichester-uk', openingDate: '2026-06-01' });
const lowryWoman = show({ id: 'the-woman-in-black-lowry-regional-2025', title: 'The Woman in Black', venue: 'The Lowry, Salford', city: 'manchester-uk', openingDate: '2025-08-01' });
const shows = [crucibleLear, exchangeLear, magic, lowryWoman];

test('the house decides between two same-titled productions', () => {
  assert.deepEqual(matchItem({ url: 'https://www.whatsonstage.com/news/king-lear-at-the-crucible-theatre-review_1/', headline: 'King Lear at the Crucible Theatre – review', publishDate: '2026-09-05' }, shows), [crucibleLear.id]);
  assert.deepEqual(matchItem({ url: 'https://www.thestage.co.uk/reviews/king-lear-review-royal-exchange-manchester', headline: 'king lear review royal exchange manchester', publishDate: '2026-09-12' }, shows), [exchangeLear.id]);
});

test('a one-word title must lead the headline', () => {
  assert.deepEqual(matchItem({ url: 'https://www.thestage.co.uk/reviews/the-magic-flute-review-chichester-festival-theatre', headline: 'the magic flute review chichester festival theatre', publishDate: '2026-06-05' }, shows), []);
  assert.deepEqual(matchItem({ url: 'https://www.thestage.co.uk/reviews/magic-review-chichester-festival-theatre', headline: 'magic review chichester festival theatre', publishDate: '2026-06-05' }, shows), [magic.id]);
});

test('British Theatre Guide 15-character slugs need the venue fragment', () => {
  assert.deepEqual(matchItem({ url: 'https://www.britishtheatreguide.info/reviews/the-woman-in-bl-the-lowry-8812', headline: 'the woman in bl the lowry 8812', publishDate: '2025-08-06' }, shows), [lowryWoman.id]);
  assert.deepEqual(matchItem({ url: 'https://www.britishtheatreguide.info/reviews/king-lear-national-theatr-9000', headline: 'king lear national theatr 9000', publishDate: '2026-09-05' }, shows), []);
});

test('run window: 45 days before opening to 150 after when there is no closing date', () => {
  assert.equal(inWindow(crucibleLear, '2026-07-20'), true);
  assert.equal(inWindow(crucibleLear, '2026-07-01'), false);
  assert.equal(inWindow(crucibleLear, '2027-03-01'), false);
  assert.equal(inWindow({ ...crucibleLear, closingDate: '2026-10-01' }, '2026-11-20'), true);
});

test('reviewer holes: town alone, loose BTG prefix, a short title inside a longer one', () => {
  const playhouseLear = show({ id: 'kenrex-sheffield-playhouse-regional-2026', title: 'Kenrex', venue: 'Sheffield Playhouse, Sheffield', city: 'sheffield-uk', openingDate: '2026-02-01' });
  const bathOnce = show({ id: 'once-royal-bath-regional-2026', title: 'Once', venue: 'Theatre Royal Bath, Bath', city: 'bath-uk', openingDate: '2026-05-01' });
  const both = [playhouseLear, bathOnce];
  assert.deepEqual(matchItem({ url: 'https://www.thestage.co.uk/reviews/kenrex-review-sheffield-lyceum-theatre', headline: 'kenrex review sheffield lyceum theatre', publishDate: '2026-02-05' }, both), []);
  assert.deepEqual(matchItem({ url: 'https://www.britishtheatreguide.info/reviews/kenrex-sheffield-lyceu-23917', headline: 'kenrex sheffield lyceu 23917', publishDate: '2026-02-05' }, both), []);
  assert.deepEqual(matchItem({ url: 'https://www.britishtheatreguide.info/reviews/once-theatre-royal-w-23918', headline: 'once theatre royal w 23918', publishDate: '2026-05-05' }, both), []);
  assert.deepEqual(matchItem({ url: 'https://www.thestage.co.uk/reviews/once-in-a-lifetime-review-theatre-royal-bath', headline: 'once in a lifetime review theatre royal bath', publishDate: '2026-05-05' }, both), []);
  assert.deepEqual(matchItem({ url: 'https://www.thestage.co.uk/reviews/once-review-theatre-royal-bath', headline: 'once review theatre royal bath', publishDate: '2026-05-05' }, both), [bathOnce.id]);
});
