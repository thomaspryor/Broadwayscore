/**
 * BRO-6286: the /biz hero numbers (commercial productions, disclosed
 * capitalization, confirmed recoupments) use the season stats' population.
 * A first draft counted pure nonprofits and summed our own capitalization
 * estimates and Form D ceilings as "disclosed"; these check the live data path keeps them out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAllCommercialSlugs, getCommercialHeadlineStats, getShowCommercial } from '../../src/lib/data-commercial';
import { isExcludedFromSeasonStats } from '../../src/lib/commercial-metrics';
import { isOwnEstimate } from '../../src/lib/season-profile';
import { isMaximumCapitalization } from '../../scripts/lib/public-source-text';

const stats = getCommercialHeadlineStats();

test('productions leave out pure nonprofits and tour stops', () => {
  const included = getAllCommercialSlugs().filter((slug) => !isExcludedFromSeasonStats(getShowCommercial(slug)!));
  assert.ok(stats.productions > 0, 'no productions counted');
  assert.ok(stats.productions <= included.length, `${stats.productions} counted, only ${included.length} are commercial`);
});

test('disclosed capitalization excludes our own estimates and offering ceilings', () => {
  let ceiling = 0;
  for (const slug of getAllCommercialSlugs()) {
    const c = getShowCommercial(slug)!;
    if (isExcludedFromSeasonStats(c) || isOwnEstimate(c) || isMaximumCapitalization(c) || typeof c.capitalization !== 'number') continue;
    ceiling += c.capitalization;
  }
  assert.ok(stats.disclosedCapitalization > 0);
  assert.ok(stats.disclosedCapitalization <= ceiling, 'summed an estimate, a ceiling or an excluded record');
  assert.ok(stats.disclosedCount <= stats.productions);
});

test('recoupments only count recouped === true records', () => {
  const flagged = getAllCommercialSlugs().filter((slug) => getShowCommercial(slug)?.recouped === true).length;
  assert.ok(stats.recouped > 0 && stats.recouped <= flagged);
});
