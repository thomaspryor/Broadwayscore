import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectCountedReviewIssues,
  checkCrossShowDuplicates,
  checkSameShowMultiByline,
  checkUrlYearOutsideRun,
  checkUnopenedShowCounted,
  checkJunkOutlets,
  checkOpeningDateCluster,
  checkPriorRunLinks,
  urlYear,
} = require('./counted-review-integrity.js');

const QUOTE = 'Gross is the evening’s highlight, a comic performer of real timing and charm';

const show = (id, extra = {}) => ({
  id, title: 'Private Lives', category: 'broadway', venue: 'Music Box Theatre',
  openingDate: '2011-11-17', closingDate: '2011-12-31', ...extra,
});
const review = (showId, extra = {}) => ({
  showId, outletId: 'vulture', outlet: 'Vulture', criticName: 'Scott Brown',
  assignedScore: 79, pullQuote: QUOTE, publishDate: '2011-11-18', url: null, ...extra,
});

test('urlYear reads date path segments and ignores article ids', () => {
  assert.equal(urlYear('https://www.nytimes.com/2022/07/10/theater/into-the-woods-review.html'), 2022);
  assert.equal(urlYear('https://example.com/reviews/2019-03-07-three-days'), 2019);
  assert.equal(urlYear('https://www.theguardian.com/stage/2022/aug/25/review'), 2022);
  assert.equal(urlYear('https://example.com/article-15340469'), null);
  assert.equal(urlYear(null), null);
});

test('cross-show duplicate: the same Vulture row counted on four Private Lives years is flagged', () => {
  const shows = [
    show('private-lives-2011'),
    show('private-lives-2002', { openingDate: '2002-04-28', closingDate: '2002-09-01' }),
    show('private-lives-1992', { openingDate: '1992-02-20', closingDate: '1992-03-22' }),
  ];
  const reviews = shows.map((s) => review(s.id));
  const issues = checkCrossShowDuplicates(shows, reviews);
  assert.deepEqual(issues.map((i) => i.showId).sort(), ['private-lives-1992', 'private-lives-2002', 'private-lives-2011']);
  assert.ok(issues.every((i) => i.alsoOn.length === 2));
});

test('cross-show duplicate: a declared transfer, a re-listed production and tour stops are not flagged', () => {
  const bridge = show('itw-bridge', { title: 'Into the Woods', openingDate: '2025-12-11', closingDate: '2026-05-30' });
  const nc = show('itw-nc', { title: 'Into the Woods', openingDate: '2026-10-07', closingDate: '2027-01-09',
    priorRuns: [{ id: 'itw-bridge', venue: 'Bridge Theatre' }] });
  const a = show('pa-chicago', { title: 'Paranormal Activity', category: 'regional', openingDate: '2025-10-16', closingDate: '2025-11-30' });
  const b = show('pa-boston', { title: 'Paranormal Activity', category: 'regional', openingDate: '2026-03-01', closingDate: '2026-04-01' });
  const relisted = [show('k-1', { title: 'Kramer', openingDate: '2026-02-01', closingDate: '2026-03-01' }),
    show('k-2', { title: 'Kramer', openingDate: '2026-04-01', closingDate: '2026-05-01' })];
  const shows = [bridge, nc, a, b, ...relisted];
  const quoteFor = (id) => `${QUOTE} (${id.split('-')[0]})`;
  const reviews = shows.map((s) => review(s.id, { pullQuote: quoteFor(s.id) }));
  assert.deepEqual(checkCrossShowDuplicates(shows, reviews), []);
  // The pairs share a quote only inside their own group.
  const sameQuote = [bridge, nc].map((s) => review(s.id, { pullQuote: QUOTE + ' itw' }));
  assert.deepEqual(checkCrossShowDuplicates([bridge, nc], sameQuote), []);
  const tour = [a, b].map((s) => review(s.id, { pullQuote: QUOTE + ' pa' }));
  assert.deepEqual(checkCrossShowDuplicates([a, b], tour), []);
  const listed = relisted.map((s) => review(s.id, { pullQuote: QUOTE + ' k' }));
  assert.deepEqual(checkCrossShowDuplicates(relisted, listed), []);
});

test('cross-show duplicate: short generic quotes are never treated as identical content', () => {
  const shows = [show('a-2002', { openingDate: '2002-04-28', closingDate: '2002-09-01' }), show('a-2011')];
  const reviews = shows.map((s) => review(s.id, { pullQuote: 'A fine night out.' }));
  assert.deepEqual(checkCrossShowDuplicates(shows, reviews), []);
});

test('same-show multi-byline: Variety counted under Stasio and Suskin is flagged once', () => {
  const s = show('evita-2012', { title: 'Evita' });
  const reviews = [
    review('evita-2012', { outletId: 'variety', outlet: 'Variety', criticName: 'Marilyn Stasio', assignedScore: 76,
      url: 'https://variety.com/2012/legit/reviews/evita-1117947355/' }),
    review('evita-2012', { outletId: 'variety', outlet: 'Variety', criticName: 'Steven Suskin', assignedScore: 76,
      url: 'https://www.variety.com/2012/legit/reviews/evita-1117947355/?refCatId=33' }),
  ];
  const issues = checkSameShowMultiByline([s], reviews);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].critic, 'Steven Suskin');
  assert.equal(issues[0].keeps, 'Marilyn Stasio');
});

test('same-show multi-byline: two critics with different reviews at one outlet are fine', () => {
  const s = show('x-2011');
  const reviews = [
    review('x-2011', { criticName: 'A', url: 'https://vulture.com/2011/a', pullQuote: QUOTE }),
    review('x-2011', { criticName: 'B', url: 'https://vulture.com/2011/b', pullQuote: 'A completely different opinion about the staging and the cast of this production' }),
  ];
  assert.deepEqual(checkSameShowMultiByline([s], reviews), []);
});

test('url year: a 2016 URL on a 2022-2023 run is flagged, a declared prior run and a title year are not', () => {
  const run = show('run-2022', { title: 'Run', openingDate: '2022-08-06', closingDate: '2023-01-08' });
  const bad = review('run-2022', { url: 'https://independent.co.uk/2016/05/review' });
  assert.equal(checkUrlYearOutsideRun([run], [bad]).length, 1);
  const withPrior = { ...run, priorRuns: [{ openingDate: '2016-04-01', closingDate: '2016-06-01' }] };
  assert.deepEqual(checkUrlYearOutsideRun([withPrior], [bad]), []);
  const titled = show('1984-2017', { title: '1984', openingDate: '2017-06-22', closingDate: '2017-10-08' });
  assert.deepEqual(checkUrlYearOutsideRun([titled], [review('1984-2017', { url: 'https://x.com/1984/01/y' })]), []);
  const longRun = show('lk', { title: 'Lion King', openingDate: '1997-11-13', closingDate: '2030-01-01' });
  assert.deepEqual(checkUrlYearOutsideRun([longRun], [review('lk', { url: 'https://x.com/2018/01/y' })]), []);
});

test('unopened show: a cancelled-before-opening production cannot carry counted reviews', () => {
  const never = show('woolf-2020', { cancelledBeforeOpening: true, openingDate: null });
  assert.equal(checkUnopenedShowCounted([never], [review('woolf-2020')]).length, 1);
  assert.deepEqual(checkUnopenedShowCounted([show('ok')], [review('ok')]), []);
});

test('junk outlet: a topic index page, a domainless defunct outlet and an unregistered outlet are flagged', () => {
  const s = show('evita-2012', { title: 'Evita' });
  const registry = { outlets: {
    'ricky-martin': { displayName: 'Ricky Martin', domain: null, accessModel: 'defunct' },
    vulture: { displayName: 'Vulture', domain: 'vulture.com', accessModel: 'free' },
  } };
  const reviews = [
    review('evita-2012', { outletId: 'ricky-martin', outlet: 'Ricky Martin',
      url: 'https://topics.nytimes.com/top/reference/timestopics/people/m/ricky-martin/index.html' }),
    review('evita-2012', { outletId: 'vulture' }),
    review('evita-2012', { outletId: 'unknown-blog' }),
  ];
  assert.deepEqual(checkJunkOutlets([s], reviews, registry).map((i) => i.outlet), ['Ricky Martin', 'Vulture']);
});

test('opening date cluster: opening-night reviews four weeks before openingDate flag the date', () => {
  const s = show('itw-2022', { title: 'Into the Woods', openingDate: '2022-08-06', closingDate: '2023-01-08' });
  const days = ['2022-07-10', '2022-07-10', '2022-07-10', '2022-07-11', '2022-07-11', '2022-07-12'];
  const reviews = days.map((d, i) => review('itw-2022', { criticName: `c${i}`, publishDate: d }));
  const issues = checkOpeningDateCluster([s], reviews);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].suggestedOpeningDate, '2022-07-10');
});

test('opening date cluster: correct dates, thin data and declared prior runs are not flagged', () => {
  const good = show('good', { openingDate: '2022-07-10' });
  const reviews = ['2022-07-10', '2022-07-10', '2022-07-11', '2022-07-11', '2022-07-12'].map((d, i) => review('good', { criticName: `c${i}`, publishDate: d }));
  assert.deepEqual(checkOpeningDateCluster([good], reviews), []);
  const thin = show('thin', { openingDate: '2022-08-06' });
  assert.deepEqual(checkOpeningDateCluster([thin], reviews.slice(0, 3).map((r) => ({ ...r, showId: 'thin' }))), []);
  const transfer = show('xfer', { openingDate: '2022-08-06', priorRuns: [{ id: 'old' }] });
  assert.deepEqual(checkOpeningDateCluster([transfer], reviews.map((r) => ({ ...r, showId: 'xfer' }))), []);
});

test('prior run link: an id-less entry is fine (London reviews stay off the Broadway page), only a missing target is flagged', () => {
  const palladium = { id: 'evita-we-2025', title: 'Evita', category: 'west-end', venue: 'London Palladium', openingDate: '2025-07-01' };
  const broadway = { id: 'evita-2026', title: 'Evita', category: 'broadway', venue: 'Winter Garden Theatre', openingDate: '2027-03-25',
    priorRuns: [{ venue: 'London Palladium', openingDate: '2025-06-14', closingDate: '2025-09-06' }] };
  // Owner decision 2026-10-08: Broadway Evita must NOT inherit the London Palladium reviews, so no finding.
  assert.deepEqual(checkPriorRunLinks([palladium, broadway]), []);
  const linked = { ...broadway, priorRuns: [{ id: 'evita-we-2025', venue: 'London Palladium' }] };
  assert.deepEqual(checkPriorRunLinks([palladium, linked]), []);
  const dangling = { ...broadway, priorRuns: [{ id: 'nope' }] };
  assert.equal(checkPriorRunLinks([palladium, dangling])[0].missingId, 'nope');
});

test('detectCountedReviewIssues totals every check and reports a zero for the clean ones', () => {
  const s = show('private-lives-2011');
  const result = detectCountedReviewIssues({ shows: [s], reviews: [review(s.id)], outletRegistry: { outlets: { vulture: { domain: 'vulture.com' } } } });
  assert.equal(result.total, 0);
  assert.equal(Object.keys(result.counts).length, 7);
});
