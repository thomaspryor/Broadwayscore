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

// Ship-check review findings (BRO-7058)
test('Goodman transfer wording ("presentation of the ... production") is exempt, real talkinbroadway verdict', () => {
  assert.equal(g.hasDifferentCityProductionSignal([
    'Review evaluates Goodman Theatre production (Chicago), not the Off-Broadway production. Text explicitly states \'in Audible Theater\'s presentation of the Goodman Theatre production\'.',
  ], '', { ...NYC_SHOW, id: 'swing-state-off-broadway-2023', title: 'Swing State', venue: 'Minetta Lane Theatre' }), false);
});

test('loose "not ... Broadway" probes do not fire', () => {
  for (const [issues, show] of [
    [['Critic is a Los Angeles-based writer; review does not mention Broadway'], NYC_SHOW],
    [['The review discusses Chicago at the Ambassador; not the expected Broadway cast'], { ...NYC_SHOW, title: 'Chicago' }],
    [['Austin Pendleton directs; the cast list differs, not Off-Broadway'], NYC_SHOW],
    [['Review is a Chicago critic roundup', 'Review does not reference New York City at all'], NYC_SHOW],
  ]) assert.equal(g.hasDifferentCityProductionSignal(issues, '', show), false, issues[0]);
});

test('city and "not this market" must sit in the same issue string', () => {
  assert.equal(g.hasDifferentCityProductionSignal(['Venue is in Chicago', 'Cast list is not the Broadway cast'], '', NYC_SHOW), false);
});

test('original-bug wording that slipped through before now fires', () => {
  assert.equal(g.hasDifferentCityProductionSignal(['Review is of the Chicago premiere at Theater Wit, not the Off-Broadway production in New York City'], '', NYC_SHOW), true);
  assert.equal(g.hasDifferentCityProductionSignal(['Review is of Theater Wit (Chicago), not The Secret Theatre'], '', NYC_SHOW), true);
});

// BRO-7077: CV's other phrasing for the same King Lear review had no "not Off-Broadway"
// clause, so the market-statement test missed it and the opening-week net still downgraded.
test('BRO-7077: "a Chicago production by ..." fires without a not-this-market clause', () => {
  const issues = ['The review is of a Chicago production by Babes with Blades at Theater Wit.'];
  assert.equal(g.hasDifferentCityProductionSignal(issues, '', NYC_SHOW), true);
  const r = g.applyTemporalOverrides(true, false, 'high', '2026-11-05', '2026-10-28', { issues, reasoning: '', show: NYC_SHOW });
  assert.equal(r.wpConfidence, 'high');
  assert.equal(g.hasDifferentCityProductionSignal(['Reviews a Boston-based company staging of the play.'], '', NYC_SHOW), true, '-based form');
  assert.equal(g.hasDifferentCityProductionSignal(['Mentions a Boston-based troupe touring the piece.'], '', NYC_SHOW), false, 'tour veto still applies');
});

test('BRO-7077: locator phrase stays off for history and other markets', () => {
  for (const s of [
    'The critic compares it to the previous Chicago production.',
    'The show premiered as a Chicago production before transferring.',
    'Reviewer writes for the Chicago Tribune about the New York staging.',
    // second-opinion: comparison/history mentions must never fire (they would beat the run-window veto)
    'compares this staging to the Chicago production starring X',
    'references the Boston revival as a point of comparison',
    'the director previously helmed the Chicago staging',
    'references the Los Angeles staging from 2019',
    'praised the Atlanta company that developed the show',
    'The review compares it to the Chicago production.',
  ]) assert.equal(g.hasDifferentCityProductionSignal([s], '', NYC_SHOW), false, s);
  assert.equal(g.hasDifferentCityProductionSignal(['The review is of a Chicago production.'], '', CHICAGO_SHOW), false, 'regional page');
});
