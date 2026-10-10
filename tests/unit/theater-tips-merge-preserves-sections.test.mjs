/**
 * Regression for BRO-932: the quarterly generate-theater-tips.yml workflow
 * (scripts/generate-theater-tips.js -> scripts/merge-theater-tips.js) wiped
 * every theater's hand-curated structuredTips.seating.sections on its
 * 2026-07-01 run, because merge-theater-tips.js rebuilt structuredTips.seating
 * from the LLM draft alone — which never produces a `sections` field.
 *
 * This requires the real merge function (CLAUDE.md §15) so a future edit that
 * reintroduces the wipe fails this test instead of shipping silently.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildMergedStructuredTips } from '../../scripts/lib/theater-tips-merge.js';

describe('buildMergedStructuredTips preserves hand-curated seating sections', () => {
  const existingSections = [
    { name: 'Orchestra Center', rowRange: 'D-L', verdict: 'sweet-spot', verdictLabel: 'Best overall' },
    { name: 'Rear Mezzanine', verdict: 'skip', verdictLabel: 'Distant' },
  ];

  test('sections survive a merge where the LLM draft only has bestSeats/avoidSeats', () => {
    const draftTips = {
      lastUpdated: '2026-10-01T06:00:00.000Z',
      seating: { bestSeats: 'Center orchestra offers the best view.' },
    };
    const existingTheaterMetadata = {
      structuredTips: {
        lastUpdated: '2026-04-16T20:58:43.117Z',
        seating: {
          bestSeats: 'Center orchestra offers the best view.',
          sections: existingSections,
        },
      },
    };

    const { structuredTips } = buildMergedStructuredTips(draftTips, existingTheaterMetadata);

    assert.deepStrictEqual(structuredTips.seating.sections, existingSections, 'sections must be carried forward unchanged');
  });

  test('theaters with no prior sections stay without sections (no fabrication)', () => {
    const draftTips = { lastUpdated: '2026-10-01T06:00:00.000Z', seating: { bestSeats: 'Good views throughout.' } };
    const existingTheaterMetadata = { structuredTips: { lastUpdated: '2026-04-02T00:00:00.000Z', seating: { bestSeats: 'Good views throughout.' } } };

    const { structuredTips } = buildMergedStructuredTips(draftTips, existingTheaterMetadata);

    assert.strictEqual(structuredTips.seating.sections, undefined);
  });

  test('verified accessibility text still overrides seating.accessibility alongside preserved sections', () => {
    const draftTips = { lastUpdated: '2026-10-01T06:00:00.000Z', seating: { bestSeats: 'Great sightlines.' } };
    const existingTheaterMetadata = {
      accessibility: { verified: true, notes: '5 wheelchair spaces in Orchestra.' },
      structuredTips: {
        lastUpdated: '2026-04-16T20:58:43.117Z',
        seating: { bestSeats: 'Great sightlines.', sections: existingSections },
      },
    };

    const { structuredTips, accessibilityInjected } = buildMergedStructuredTips(draftTips, existingTheaterMetadata);

    assert.strictEqual(accessibilityInjected, true);
    assert.strictEqual(structuredTips.seating.accessibility, '5 wheelchair spaces in Orchestra.');
    assert.deepStrictEqual(structuredTips.seating.sections, existingSections);
  });

  test('a theater with sections but no draft seating field still keeps sections', () => {
    const draftTips = { lastUpdated: '2026-10-01T06:00:00.000Z', parking: { streetParking: 'Limited.' } };
    const existingTheaterMetadata = {
      structuredTips: { lastUpdated: '2026-04-16T20:58:43.117Z', seating: { sections: existingSections } },
    };

    const { structuredTips } = buildMergedStructuredTips(draftTips, existingTheaterMetadata);

    assert.deepStrictEqual(structuredTips.seating.sections, existingSections);
  });
});
