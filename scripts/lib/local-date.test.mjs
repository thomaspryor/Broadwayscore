import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { localDateString, publishedStampToLocalDate, tzForUrl } = require('./local-date');

const NYSR = 'https://nystagereview.com/2026/10/15/memoirs/';
const UK = 'https://www.whatsonstage.com/reviews/x';

test('a UTC stamp after midnight is the previous evening in New York (opening night)', () => {
  assert.equal(publishedStampToLocalDate('2026-10-16T02:26:00+00:00', NYSR), '2026-10-15');
  assert.equal(publishedStampToLocalDate('2026-10-16T02:26:00Z', NYSR), '2026-10-15');
  assert.equal(publishedStampToLocalDate('2026-10-16T02:26:00.000Z', NYSR), '2026-10-15');
});
test('a UTC stamp in the daytime keeps its date', () => {
  assert.equal(publishedStampToLocalDate('2026-10-16T14:10:00Z', NYSR), '2026-10-16');
});
test('an explicit local offset is taken verbatim', () => {
  assert.equal(publishedStampToLocalDate('2026-10-15T21:30:00-04:00', NYSR), '2026-10-15');
  assert.equal(publishedStampToLocalDate('2026-10-15T23:59:00+01:00', UK), '2026-10-15');
});
test('date-only and zone-less stamps are calendar dates', () => {
  assert.equal(publishedStampToLocalDate('2026-10-15', NYSR), '2026-10-15');
  assert.equal(publishedStampToLocalDate('2026-10-15T21:30:00', NYSR), '2026-10-15');
});
test('UK hosts use London time: 23:30Z in BST is already the next day', () => {
  assert.equal(tzForUrl(UK), 'Europe/London');
  assert.equal(publishedStampToLocalDate('2026-10-15T23:30:00Z', UK), '2026-10-16');
});
test('Date instants and RFC-822 feed dates convert too', () => {
  assert.equal(localDateString(new Date('Fri, 16 Oct 2026 02:26:00 GMT')), '2026-10-15');
  assert.equal(publishedStampToLocalDate('Fri, 16 Oct 2026 02:26:00 +0000', NYSR), '2026-10-15');
});
test('garbage is null', () => {
  assert.equal(publishedStampToLocalDate('not a date', NYSR), null);
  assert.equal(publishedStampToLocalDate(null, NYSR), null);
});

test('localizeIsoStamp: converts zoned UTC stamps, passes everything else through', () => {
  const { localizeIsoStamp } = require('./local-date');
  assert.equal(localizeIsoStamp('2026-10-16T02:26:00+00:00'), '2026-10-15');
  assert.equal(localizeIsoStamp('2026-10-15T21:30:00-04:00'), '2026-10-15');
  assert.equal(localizeIsoStamp('March 15, 2024'), 'March 15, 2024');
  assert.equal(localizeIsoStamp('2026-10-15'), '2026-10-15');
});

test('UK host detection: UK publishers only, not US sites with a similar word', () => {
  for (const u of ['https://www.telegraph.co.uk/x', 'https://www.theguardian.com/stage/x', 'https://www.whatsonstage.com/x', 'https://www.independent.co.uk/x', 'https://www.thestage.co.uk/x']) assert.equal(tzForUrl(u), 'Europe/London', u);
  for (const u of ['https://www.independent.com/x', 'https://www.telegraph-herald.com/x', 'https://www.thestandard.com/x', 'https://nystagereview.com/2026/10/15/x/', 'https://www.nytimes.com/x']) assert.equal(tzForUrl(u), 'America/New_York', u);
});

test('timezone follows the publisher hostname, not substrings of the URL (BRO-5499 review)', () => {
  for (const u of ['https://www.thetimes.com/culture/x', 'https://www.ft.com/content/x', 'https://www.theartsdesk.com/x']) assert.equal(tzForUrl(u), 'Europe/London', u);
  for (const u of ['https://nashuatelegraph.com/x', 'https://theindependent.com/x', 'https://onthestage.tickets/x']) assert.equal(tzForUrl(u), 'America/New_York', u);
  // winter-or-summer 00:30 UTC at a UK publisher is still the same day; at a NY publisher it is the evening before
  assert.equal(publishedStampToLocalDate('2026-12-02T00:30:00Z', 'https://www.thetimes.com/x'), '2026-12-02');
  assert.equal(publishedStampToLocalDate('2026-12-02T00:30:00Z', 'https://nystagereview.com/x'), '2026-12-01');
});

test('midnight UTC is a date-only value, not an evening', () => {
  assert.equal(publishedStampToLocalDate('2026-10-15T00:00:00+00:00', 'https://x.com/a'), '2026-10-15');
  assert.equal(publishedStampToLocalDate('2026-10-15T00:00:00Z', 'https://x.com/a'), '2026-10-15');
  assert.equal(publishedStampToLocalDate(new Date('Thu, 15 Oct 2026 00:00:00 GMT'), 'https://x.com/a'), '2026-10-15');
});

test('an explicit tz (from the show market) overrides the host', () => {
  const { tzForMarket } = require('./local-date');
  assert.equal(tzForMarket('off-west-end'), 'Europe/London');
  assert.equal(tzForMarket('off-broadway'), 'America/New_York');
  assert.equal(tzForMarket('regional'), null);
  assert.equal(publishedStampToLocalDate('2026-10-15T23:30:00Z', 'https://x.com/a', { tz: 'Europe/London' }), '2026-10-16');
});

test('lenient offsets and hours still convert (+00, single-digit hour); garbage time keeps the date part upstream', () => {
  assert.equal(publishedStampToLocalDate('2026-05-27T02:00:00+00', 'https://x.com/a'), '2026-05-26');
  assert.equal(publishedStampToLocalDate('2026-05-27T2:00:00Z', 'https://x.com/a'), '2026-05-26');
  assert.equal(publishedStampToLocalDate('2026-05-27T21:00:00-04', 'https://x.com/a'), '2026-05-27');
});
