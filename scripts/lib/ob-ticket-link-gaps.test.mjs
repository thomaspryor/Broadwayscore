import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDeadEndShows, venueFallbackUrl } = require('./ob-ticket-link-gaps.js');

function show(overrides = {}) {
  return {
    id: 'test-show',
    category: 'off-broadway',
    status: 'open',
    venue: 'Irish Repertory Theatre',
    ticketLinks: [],
    ...overrides,
  };
}

test('findDeadEndShows: flags an active OB show with no ticketLinks and no officialUrl', () => {
  const shows = [show()];
  assert.deepEqual(findDeadEndShows(shows).map((s) => s.id), ['test-show']);
});

test('findDeadEndShows: a show with a real ticketLinks entry is not a dead end', () => {
  const shows = [show({ ticketLinks: [{ platform: 'TodayTix', url: 'https://todaytix.com/x' }] })];
  assert.deepEqual(findDeadEndShows(shows), []);
});

test('findDeadEndShows: a show with officialUrl already set is not a dead end', () => {
  const shows = [show({ officialUrl: 'https://example.com' })];
  assert.deepEqual(findDeadEndShows(shows), []);
});

test('findDeadEndShows: closed shows are excluded (correctly buttonless)', () => {
  const shows = [show({ status: 'closed' })];
  assert.deepEqual(findDeadEndShows(shows), []);
});

test('findDeadEndShows: broadway category is out of scope for this script', () => {
  const shows = [show({ category: 'broadway' })];
  assert.deepEqual(findDeadEndShows(shows), []);
});

test('findDeadEndShows: off-west-end is in scope alongside off-broadway', () => {
  const shows = [show({ category: 'off-west-end', status: 'announced' })];
  assert.deepEqual(findDeadEndShows(shows).map((s) => s.id), ['test-show']);
});

test('findDeadEndShows: upcoming/announced/previews are all in-scope active statuses', () => {
  for (const status of ['upcoming', 'announced', 'previews', 'open']) {
    const shows = [show({ status })];
    assert.deepEqual(findDeadEndShows(shows).map((s) => s.id), ['test-show'], `status=${status}`);
  }
});

const VENUE_CONFIGS = [
  { name: 'Irish Rep', url: 'https://irishrep.org/' },
  { name: 'Soho Rep', url: 'https://sohorep.org/' },
  { name: 'BAM', url: 'https://www.bam.org/' },
];

test('venueFallbackUrl: abbreviation in config matches full venue name', () => {
  const url = venueFallbackUrl(show({ venue: 'Irish Repertory Theatre' }), VENUE_CONFIGS);
  assert.equal(url, 'https://irishrep.org/');
});

test('venueFallbackUrl: short config name (BAM) does not false-positive on unrelated venues', () => {
  const url = venueFallbackUrl(show({ venue: 'Alabama Theatre' }), VENUE_CONFIGS);
  assert.equal(url, null);
});

test('venueFallbackUrl: BAM matches its own full venue name', () => {
  const url = venueFallbackUrl(show({ venue: 'BAM Howard Gilman Opera House' }), VENUE_CONFIGS);
  assert.equal(url, 'https://www.bam.org/');
});

test('venueFallbackUrl: partial-word overlap (Soho) alone is not enough — Rep must also match', () => {
  const url = venueFallbackUrl(show({ venue: 'Soho Playhouse' }), VENUE_CONFIGS);
  assert.equal(url, null);
});

test('venueFallbackUrl: no venue on the show returns null', () => {
  const url = venueFallbackUrl(show({ venue: '' }), VENUE_CONFIGS);
  assert.equal(url, null);
});

test('venueFallbackUrl: no matching config returns null', () => {
  const url = venueFallbackUrl(show({ venue: 'Some Random Church Basement' }), VENUE_CONFIGS);
  assert.equal(url, null);
});

test('venueFallbackUrl: normalizes to the domain root, never a season-specific path', () => {
  const configs = [{ name: 'MCC Theater', url: 'https://mcctheater.org/our-2025-26-season/' }];
  const url = venueFallbackUrl(show({ venue: 'MCC Theater' }), configs);
  assert.equal(url, 'https://mcctheater.org/');
});

test('venueFallbackUrl: refuses listing sites, malformed URLs and non-http URLs', () => {
  for (const url of [
    'https://www.newyorktheatreguide.com/venues/test',
    'https://www.broadway.org/shows/test',
    'https://tickets.todaytix.com/show',
    'not a URL', 'javascript:alert(1)', 'ftp://irishrep.org/',
  ]) {
    assert.equal(venueFallbackUrl(show(), [{ name: 'Irish Rep', url }]), null, url);
  }
});

test('venueFallbackUrl: explicit officialUrl overrides a listing reader, null disables fallback', () => {
  const config = { name: 'Irish Rep', url: 'https://www.newyorktheatreguide.com/venues/test' };
  assert.equal(venueFallbackUrl(show(), [{ ...config, officialUrl: null }]), null);
  assert.equal(venueFallbackUrl(show(), [{ ...config, officialUrl: 'https://irishrep.org/productions/' }]), 'https://irishrep.org/');
  assert.equal(venueFallbackUrl(show(), [{ ...config, officialUrl: 'https://www.broadway.org/' }]), null);
});

test('venueFallbackUrl: real editorial reader configs cannot become official links', () => {
  const { OB_VENUE_CONFIGS, OWE_VENUE_CONFIGS } = require('./venue-listing-discover.js');
  const editorial = OB_VENUE_CONFIGS.filter(v => v.strategy === 'nytg-venue');
  assert.ok(editorial.length > 0);
  for (const config of editorial) {
    assert.equal(config.officialUrl, null, config.name);
    assert.equal(venueFallbackUrl(show({ venue: config.name }), [config]), null, config.name);
  }
  const { isBlockedOfficialUrl } = require('./official-url-discovery.js');
  for (const config of [...OB_VENUE_CONFIGS, ...OWE_VENUE_CONFIGS].filter(v => v.strategy !== 'nytg-venue')) {
    const fallback = venueFallbackUrl(show({ venue: config.name }), [config]);
    if (fallback) assert.equal(isBlockedOfficialUrl(fallback), false, config.name);
  }
});
