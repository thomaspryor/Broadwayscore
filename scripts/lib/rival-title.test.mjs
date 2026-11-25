/**
 * Rival-title guard (BRO-8321).
 *
 * Run: node --test scripts/lib/rival-title.test.mjs
 *
 * Regression: 2026-11-25. The Reviews Hub's review of "A Christmas Carol Goes Wrong"
 * (Grand Theatre, Wolverhampton) was filed under the Old Vic's "A Christmas Carol"
 * and scored 80 into its composite. Fixtures are synthetic; no live data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rt = require('./rival-title.js');
const op = require('./other-production-signal.js');
const helpers = require('./outlet-listing-helpers.js');

const carol = { id: 'a-christmas-carol-west-end-2026', title: 'A Christmas Carol', category: 'west-end', venue: 'Old Vic', status: 'open', openingDate: '2026-11-20', previewsStartDate: '2026-11-10', market: 'london' };
const goesWrong = { id: 'christmas-carol-goes-wrong-west-end-2026', title: 'Christmas Carol Goes Wrong', status: 'upcoming' };
const oliver = { id: 'oliver-west-end-2026', title: 'Oliver!' };
const oliverMusical = { id: 'oliver-the-musical-regional', title: 'Oliver! The Musical' };
const beast = { id: 'beauty-and-the-beast-1994', title: 'Beauty and the Beast' };
const disneyBeast = { id: 'disneys-beauty-and-the-beast-tour', title: "Disney's Beauty and the Beast" };
const once = { id: 'once-2012', title: 'Once' };
const onceLifetime = { id: 'once-in-a-lifetime-2026', title: 'Once in a Lifetime' };
const feet = { id: 'on-your-feet-2015', title: 'On Your Feet!' };
const feetSub = { id: 'on-your-feet-tour', title: 'On Your Feet! The Story of Emilio & Gloria Estefan' };
const all = [carol, goesWrong, oliver, oliverMusical, beast, disneyBeast, once, onceLifetime, feet, feetSub];
const index = rt.buildRivalIndex(all);

test('a longer title that appends words is a rival, even without the leading article', () => {
  assert.deepEqual(index.rivalsFor(carol).map((r) => r.id), [goesWrong.id]);
});

test('name variants are never rivals (credit prefix, subtitle, generic suffix, one-word title)', () => {
  for (const s of [oliver, beast, once, feet]) assert.deepEqual(index.rivalsFor(s), [], s.title);
});

test('swallowed: the show title appears only inside the rival title', () => {
  const r = rt.rivalSwallowsTitle('a-christmas-carol-goes-wrong-grand-theatre-wolverhampton', carol, index);
  assert.equal(r?.id, goesWrong.id);
});

test('not swallowed when the show title also stands alone', () => {
  assert.equal(rt.rivalSwallowsTitle("A Christmas Carol Goes Wrong is a riot, unlike the Old Vic's A Christmas Carol", carol, index), null);
  assert.equal(rt.rivalSwallowsTitle('a-christmas-carol-old-vic-review', carol, index), null);
});

test('signal: the Wolverhampton url is flagged, the Old Vic url is not', () => {
  const bad = { url: 'https://www.thereviewshub.com/a-christmas-carol-goes-wrong-grand-theatre-wolverhampton/', outletId: 'thereviewshub', publishDate: '2026-11-11' };
  const good = { url: 'https://www.thereviewshub.com/a-christmas-carol-old-vic-review/', outletId: 'thereviewshub', publishDate: '2026-11-21' };
  assert.equal(op.otherProductionSignal(bad, carol, { only: op.URL_SIGNALS, rivalIndex: index })?.signal, 'rival-title');
  assert.equal(op.otherProductionSignal(good, carol, { only: op.URL_SIGNALS, rivalIndex: index }), null);
  assert.ok(op.auditIncludedReviews([{ ...bad, showId: carol.id }], [carol, goesWrong]).length === 1);
});

test('matcher: findMatchingShows drops the show when only the rival names it', () => {
  const pool = [carol];
  assert.deepEqual(helpers.findMatchingShows('A Christmas Carol Goes Wrong, Grand Theatre Wolverhampton', 'a-christmas-carol-goes-wrong-grand-theatre-wolverhampton', pool, '', { rivalIndex: index }), []);
  assert.deepEqual(helpers.findMatchingShows('A Christmas Carol at the Old Vic', 'a-christmas-carol-old-vic', pool, '', { rivalIndex: index }).map((s) => s.id), [carol.id]);
});

test('season label: an outlet labelled with an earlier year is another season of the annual show', () => {
  const sig = (r, show = carol) => op.otherProductionSignal(r, show, { only: op.URL_SIGNALS, rivalIndex: index });
  assert.equal(sig({ outlet: 'Time Out (2022)', outletId: 'time-out-2022' })?.signal, 'outlet-season-label');
  assert.equal(sig({ outlet: 'West End Best Friend (2024)', outletId: 'west-end-best-friend' })?.signal, 'outlet-season-label');
  assert.equal(sig({ outletId: 'london-theatre-2022' })?.signal, 'outlet-season-label');
  assert.equal(sig({ outlet: 'Time Out (2026)', outletId: 'time-out-2026' }), null);
  assert.equal(sig({ outlet: 'Time Out', outletId: 'time-out' }), null);
  // a declared prior run covering that year keeps its reviews
  assert.equal(sig({ outlet: 'Time Out (2022)', outletId: 'time-out-2022' }, { ...carol, priorRuns: [{ openingDate: '2022-11-01', closingDate: '2023-01-14' }] }), null);
});

test('edition, part and city tails are name variants, not rivals (BRO-8321 review)', () => {
  const pairs = [['Wolf Hall', 'Wolf Hall Parts One & Two'], ['Torch Song', 'Torch Song Trilogy'], ['The History Boys', 'The History Boys 20th Anniversary'], ['Magic Mike Live', 'Magic Mike Live New York'], ['Million Dollar Quartet', 'Million Dollar Quartet Christmas']];
  for (const [a, b] of pairs) assert.equal(rt.extendsAsSuffix(b, a), false, `${b} must not be a rival of ${a}`);
  assert.equal(rt.extendsAsSuffix('Christmas Carol Goes Wrong', 'A Christmas Carol'), true);
});

test('a headline that names the show alone outweighs a rival-only url slug', () => {
  const url = 'https://www.thereviewshub.com/a-christmas-carol-goes-wrong-grand-theatre-wolverhampton/';
  assert.ok(op.otherProductionSignal({ url }, carol, { rivalIndex: index }));
  assert.equal(op.otherProductionSignal({ url, headline: 'A Christmas Carol at the Old Vic review' }, carol, { rivalIndex: index }), null);
});
