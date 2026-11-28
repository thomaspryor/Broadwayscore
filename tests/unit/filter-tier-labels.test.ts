/**
 * Score tier pill labels in the filter panel come from scripts/lib/score-tiers.js.
 * They used to be fixed strings, so the West End pages offered "Critical Gold (83+)"
 * while their badges and predicates put London Gold at 85.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTER_GROUPS, filterGroupsFor, scoreTierOptions } from '../../src/components/filters/filter-ui-config';
import { getGoldThreshold } from '../../src/config/score-buckets';

const labels = (opts: { label: string }[]) => opts.map((o) => o.label);

test('Broadway labels are unchanged', () => {
  assert.deepEqual(labels(scoreTierOptions()), [
    'Critical Gold (83+)', 'Recommended (75–82)', 'Worth Seeing (65–74)', 'Mixed (55–64)', 'Critical Miss (<55)',
  ]);
  assert.equal(filterGroupsFor(), FILTER_GROUPS);
  assert.equal(filterGroupsFor(getGoldThreshold('broadway')), FILTER_GROUPS);
});

test('London critics labels start Gold at 85', () => {
  const groups = filterGroupsFor(getGoldThreshold('west-end'));
  const tier = groups.find((g) => g.paramKey === 'score_tier');
  assert.ok(tier);
  assert.deepEqual(labels(tier.options).slice(0, 2), ['Critical Gold (85+)', 'Recommended (75–84)']);
  assert.equal(getGoldThreshold('off-west-end'), 85);
  // Only the score tier group changes; ids and predicates stay the same.
  assert.deepEqual(groups.map((g) => g.paramKey), FILTER_GROUPS.map((g) => g.paramKey));
  const base = FILTER_GROUPS.find((g) => g.paramKey === 'score_tier')!;
  assert.deepEqual(tier.options.map((o) => o.id), base.options.map((o) => o.id));
  tier.options.forEach((o, i) => assert.equal(o.predicate, base.options[i].predicate));
});

test('page score legends use the market Gold threshold', async () => {
  const { getScoreTierRange } = await import('../../src/components/show-cards/ScoreBadge');
  const keys = ['mustSee', 'recommended', 'worthSeeing', 'skippable', 'stayAway'] as const;
  assert.deepEqual(keys.map((k) => getScoreTierRange(k, 'broadway')), ['83-100', '75-82', '65-74', '55-64', '<55']);
  assert.deepEqual(keys.map((k) => getScoreTierRange(k)), keys.map((k) => getScoreTierRange(k, 'broadway')));
  assert.deepEqual(keys.slice(0, 2).map((k) => getScoreTierRange(k, 'west-end')), ['85-100', '75-84']);
  assert.equal(getScoreTierRange('mustSee', 'off-west-end'), '85-100');
});
