// BRO-7058: a Chicago production (Babes with Blades, Theater Wit) of King Lear sat on the
// Off-Broadway Secret Theatre page because the 30-day opening-week net downgraded CV's
// wrongProduction. CV text that names a different city's production must bypass that net.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const g = require('./review-guards.js');

const NYC_SHOW = { id: 'king-lear-off-broadway-2026', title: 'King Lear', venue: 'The Secret Theatre', market: 'broadway', category: 'off-broadway', openingDate: '2026-11-05' };
const CHICAGO_SHOW = { id: 'passing-strange-regional-2023', title: 'Passing Strange', venue: 'The Fred Anzevino Theatre, Evanston, IL', market: 'regional', category: 'regional' };

const KING_LEAR_CHICAGO_READER = [
  'Venue mismatch: Review is of a production at Theater Wit (1229 W. Belmont, Chicago), not The Secret Theatre (Off-Broadway in NYC)',
  'Publication outlet mismatch: Review is from Chicago Reader, reviewing a Chicago production, not an Off-Broadway venue',
  'Geographic location: Production is in Chicago, Illinois, not New York City',
];
const KING_LEAR_NEW_CITY = [
  'Review evaluates production at Theater Wit in Chicago (1229 West Belmont), not The Secret Theatre in New York City',
  'Expected market is Off-Broadway NYC; actual production is regional theater (Chicago)',
];

for (const [name, issues] of [['Chicago Reader', KING_LEAR_CHICAGO_READER], ['New City Stage', KING_LEAR_NEW_CITY]]) {
  test(`${name}: different-city signal fires`, () => {
    assert.equal(g.hasDifferentCityProductionSignal(issues, '', NYC_SHOW), true);
    assert.equal(g.hasStrongDifferentProductionSignal({ contentVerification: { issues, reasoning: '' } }, NYC_SHOW), true);
  });
  test(`${name}: opening-week override no longer downgrades wrongProduction`, () => {
    const r = g.applyTemporalOverrides(true, false, 'high', '2026-11-05', '2026-10-28', { issues, reasoning: '', show: NYC_SHOW });
    assert.equal(r.bypassedForStrongSignal, true);
    assert.equal(r.wpConfidence, 'high');
  });
}

test('other live cousins: Norfolk VA and the Chicago Titanique run', () => {
  for (const issues of [
    ['The scraped review is of a Virginia Stage Company production at Wells Theatre in Norfolk, Virginia, NOT an Off-Broadway production'],
    ['Review describes an off-Broadway production at Broadway Playhouse (Chicago), not the Broadway St. James Theatre production'],
  ]) assert.equal(g.hasDifferentCityProductionSignal(issues, '', NYC_SHOW), true, issues[0]);
});

test('same-city venue mismatch (MTC vs City Center) is not a different-city signal', () => {
  assert.equal(g.hasDifferentCityProductionSignal(["Venue mismatch: review describes Manhattan Theatre Club, not New York City Center"], '', NYC_SHOW), false);
});

test('tryout / tour / transfer descriptions stay out (same production, other stop)', () => {
  for (const issues of [
    ['Review describes the Chicago Goodman Theatre pre-Broadway tryout, not the Broadway opening'],
    ['Review describes touring production at Pantages Theatre (Los Angeles), not Broadway production at Palace Theatre'],
    ["Review evaluates the Kennedy Center production (pre-Broadway tryout from May 2011), not the Broadway opening"],
  ]) assert.equal(g.hasDifferentCityProductionSignal(issues, '', NYC_SHOW), false, issues[0]);
});

test('UK/overseas names stay out: CV "London production" verdicts are mostly critics citing history', () => {
  assert.equal(g.hasDifferentCityProductionSignal(['Review describes the West End/London production, not the Off-Broadway production'], '', NYC_SHOW), false);
});

test('city names inside quoted passages or a play title are not a staging location', () => {
  assert.equal(g.hasDifferentCityProductionSignal(["Review quotes 'just arrived on Broadway after successful runs in London, Chicago, Los Angeles', not the Broadway production"], '', NYC_SHOW), false);
  assert.equal(g.hasDifferentCityProductionSignal(["not the Broadway version of 'Who's Afraid of Virginia Woolf?'"], '', NYC_SHOW), false);
  assert.equal(g.hasDifferentCityProductionSignal(['Critic is Chris Jones (Chicago Tribune), not New York Daily News'], '', NYC_SHOW), false);
});

test('a city alone, with no not-this-market statement, is not a signal', () => {
  assert.equal(g.hasDifferentCityProductionSignal(['Critic is based in Chicago; review covers the Broadway production'], ''), false);
});

test('a regional (Chicago) show or a missing show never fires: Chicago is the right production there', () => {
  assert.equal(g.hasDifferentCityProductionSignal(KING_LEAR_CHICAGO_READER, '', CHICAGO_SHOW), false);
  assert.equal(g.hasDifferentCityProductionSignal(KING_LEAR_CHICAGO_READER, ''), false);
});

test('the temporal net still rescues an ordinary near-opening false positive', () => {
  const r = g.applyTemporalOverrides(true, false, 'high', '2026-11-05', '2026-11-03', { issues: ['Cast list differs slightly from metadata'], reasoning: 'minor', show: NYC_SHOW });
  assert.equal(r.bypassedForStrongSignal, false);
  assert.equal(r.wpConfidence, 'low');
});

test('DIFFERENT_CITY_SIGNAL_DISABLED=1 kill switch restores the old behaviour', () => {
  process.env.DIFFERENT_CITY_SIGNAL_DISABLED = '1';
  try {
    assert.equal(g.hasDifferentCityProductionSignal(KING_LEAR_CHICAGO_READER, '', NYC_SHOW), false);
  } finally { delete process.env.DIFFERENT_CITY_SIGNAL_DISABLED; }
  assert.equal(g.hasDifferentCityProductionSignal(KING_LEAR_CHICAGO_READER, '', NYC_SHOW), true);
});
