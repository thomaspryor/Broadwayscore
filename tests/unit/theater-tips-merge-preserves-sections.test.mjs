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
      accessibility: { verified: true, sourceUrl: 'https://theatre.example/access', notes: '5 wheelchair spaces in Orchestra.' },
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

// BRO-8057: the class, not one field. The July 2026 wipe happened because the
// merge copied only the seating keys it named. Any key the LLM draft does not
// own (seatNotes, or a field nobody has invented yet) must survive unchanged.
import { validateMergedMetadata } from '../../scripts/lib/theater-tips-merge.js';

describe('buildMergedStructuredTips preserves every non-LLM key (BRO-8057)', () => {
  const seatNotes = [{ type: 'watch-out', level: 'orchestra', rows: 'K-Z', claim: 'Overhang from row K.', evidence: [{ url: 'https://seatplan.com/x/', quoteHash: 'abc' }], verifiedAt: '2026-11-22' }];
  const existing = {
    structuredTips: {
      lastUpdated: '2026-04-16T20:58:43.117Z',
      seating: { bestSeats: 'old', seatNotes, someFutureSeatingKey: { a: 1 } },
      someFutureTopKey: ['x'],
    },
  };
  const draft = { lastUpdated: '2026-10-01T06:00:00.000Z', seating: { bestSeats: 'new', avoidSeats: 'new avoid' }, parking: { tip: 'p' } };

  test('seatNotes and unknown seating keys survive; LLM keys are refreshed', () => {
    const { structuredTips } = buildMergedStructuredTips(draft, existing);
    assert.deepStrictEqual(structuredTips.seating.seatNotes, seatNotes);
    assert.deepStrictEqual(structuredTips.seating.someFutureSeatingKey, { a: 1 });
    assert.strictEqual(structuredTips.seating.bestSeats, 'new');
    assert.strictEqual(structuredTips.seating.avoidSeats, 'new avoid');
  });

  test('unknown top-level structuredTips keys survive', () => {
    const { structuredTips } = buildMergedStructuredTips(draft, existing);
    assert.deepStrictEqual(structuredTips.someFutureTopKey, ['x']);
  });

  test('non-LLM seating keys survive even when the draft has no seating at all', () => {
    const { structuredTips } = buildMergedStructuredTips({ lastUpdated: 'x', parking: { tip: 'p' } }, existing);
    assert.deepStrictEqual(structuredTips.seating.seatNotes, seatNotes);
  });

  test('validateMergedMetadata refuses a merge that drops or edits a non-LLM seating key', () => {
    const before = { _meta: {}, A: existing };
    const dropped = { _meta: {}, A: { structuredTips: { lastUpdated: 'x', seating: { bestSeats: 'new' } } } };
    assert.ok(validateMergedMetadata(before, dropped).some((p) => /seating\.seatNotes changed by merge: A/.test(p)));
    const top = JSON.parse(JSON.stringify(before)); delete top.A.structuredTips.someFutureTopKey;
    assert.ok(validateMergedMetadata(before, top).some((p) => /structuredTips\.someFutureTopKey changed by merge: A/.test(p)));
    const llmOnly = JSON.parse(JSON.stringify(before)); llmOnly.A.structuredTips.seating.bestSeats = 'refreshed';
    assert.deepStrictEqual(validateMergedMetadata(before, llmOnly), []);
  });
});
