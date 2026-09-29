/**
 * National-tour presentation (BRO-4211, Phase D). A tour entry's venue is
 * "North American Tour" and it shares its Broadway parent's title, so every
 * helper that fell through to a Broadway default mislabelled it: "on Broadway",
 * a /theater/north-american-tour link, "currently playing at North American
 * Tour", a PerformingArtsTheater named "North American Tour".
 *
 * Run: npx tsx --test tests/unit/tour-display.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getTourReviewYears } from '../../src/lib/tour-display';
import { getBrowseSlug, getMarketLabel } from '../../src/lib/browse-slugs';
import { getHeroDurationSuffix } from '../../src/lib/show-date-line';
import { getDurationSuffix } from '../../src/lib/date-utils';
import { getMarketFromPath } from '../../src/hooks/useCurrentMarket';
import { generateShowSchema, getShowFAQs } from '../../src/lib/seo';

const tour: any = {
  id: 'beetlejuice-tour-2022', slug: 'beetlejuice-tour-2022', title: 'Beetlejuice',
  venue: 'North American Tour', category: 'tour', type: 'musical', status: 'open',
  openingDate: null, closingDate: null, synopsis: 'x',
  criticScore: { score: 72.4, reviewCount: 43, tier1Count: 0, tier2Count: 5 },
};

test('getTourReviewYears spans the reviews\' publish years, whatever their date format', () => {
  assert.equal(getTourReviewYears([{ publishDate: '2022-12-21' }, { publishDate: 'April 29th, 2025' }, { publishDate: '' }]), '2022–2025');
  assert.equal(getTourReviewYears([{ publishDate: '2024-11-06' }]), '2024');
  assert.equal(getTourReviewYears([{ publishDate: null }]), null);
  assert.equal(getTourReviewYears(undefined), null);
});

test('a tour is labelled a tour, never "on Broadway"', () => {
  assert.equal(getHeroDurationSuffix({ category: 'tour' }), 'on tour');
  assert.equal(getDurationSuffix('tour'), 'on tour');
  assert.equal(getMarketLabel('tour'), 'Tour');
  assert.equal(getBrowseSlug('tour', 'musical'), 'broadway-national-tours');
  assert.equal(getBrowseSlug('tour', 'play'), 'broadway-national-tours');
});

test('header market: tour show pages and the tours hub read as tour; titles containing "tour" do not', () => {
  assert.equal(getMarketFromPath('/show/beetlejuice-tour-2022'), 'tour');
  assert.equal(getMarketFromPath('/browse/broadway-national-tours'), 'tour');
  assert.equal(getMarketFromPath('/show/september-l-davis-the-apology-tour-off-broadway-2026'), 'off-broadway');
  assert.equal(getMarketFromPath('/show/beetlejuice-2019'), 'nyc');
});

test('show JSON-LD: a tour is a Place in the US, not a theater named "North American Tour"', () => {
  const schema: any = generateShowSchema(tour);
  assert.equal(schema.location['@type'], 'Place');
  assert.equal(schema.location.address.addressCountry, 'US');
  assert.equal(schema.location.address.streetAddress, undefined);
  assert.equal(schema.organizer, undefined);
});

test('FAQ: no "still running / where is it playing" answers built on the venue string for a tour', () => {
  const faqs = getShowFAQs(tour);
  for (const f of faqs) {
    assert.doesNotMatch(f.answer, /playing at North American Tour|at North American Tour/, f.question);
    assert.doesNotMatch(f.question + f.answer, /on Broadway/, f.question);
  }
});

test('non-tour shows keep their existing labels', () => {
  assert.equal(getHeroDurationSuffix({ category: 'broadway' }), 'on Broadway');
  assert.equal(getHeroDurationSuffix({ category: 'regional' }), null);
  assert.equal(getBrowseSlug('broadway', 'musical'), 'best-broadway-musicals');
  const schema: any = generateShowSchema({ ...tour, category: 'broadway', venue: 'Winter Garden Theatre', theaterAddress: '1634 Broadway, New York, NY 10019' });
  assert.equal(schema.location['@type'], 'PerformingArtsTheater');
  assert.equal(schema.organizer.name, 'Winter Garden Theatre');
});
