// Unit tests for scripts/lib/merge-commercial-data.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  mergeCommercialJson,
  mergePendingReview,
  mergeResearchQueue,
} = require('../../scripts/lib/merge-commercial-data');

describe('mergeCommercialJson', () => {
  it('returns union of slugs when no overlap', () => {
    const ours = { shows: { 'a': { designation: 'Hit' } } };
    const remote = { shows: { 'b': { designation: 'Flop' } } };
    const { merged, stats } = mergeCommercialJson(ours, remote);
    assert.equal(Object.keys(merged.shows).length, 2);
    assert.ok(merged.shows.a);
    assert.ok(merged.shows.b);
    assert.equal(stats.added, 1);
  });

  it('picks the newer entry on lastUpdated when both sides have the slug', () => {
    const ours = { shows: { 'a': { designation: 'TBD', lastUpdated: '2026-01-01T00:00:00.000Z' } } };
    const remote = { shows: { 'a': { designation: 'Easy Winner', lastUpdated: '2026-05-24T00:00:00.000Z' } } };
    const { merged } = mergeCommercialJson(ours, remote);
    assert.equal(merged.shows.a.designation, 'Easy Winner');
  });

  it('preserves humanReviewedDesignation from the loser side', () => {
    // ours is newer, remote has the manual review flag — manual must survive
    const ours = { shows: { 'a': { designation: 'Easy Winner', lastUpdated: '2026-05-24T00:00:00.000Z' } } };
    const remote = { shows: { 'a': {
      designation: 'TBD',
      humanReviewedDesignation: true,
      lastUpdated: '2026-05-23T00:00:00.000Z',
    } } };
    const { merged, stats } = mergeCommercialJson(ours, remote);
    assert.equal(merged.shows.a.designation, 'Easy Winner', 'newer designation wins');
    assert.equal(merged.shows.a.humanReviewedDesignation, true, 'manual review flag must survive merge');
    assert.equal(stats.overlaid, 1);
  });

  it('preserves humanReviewedRecouped flag', () => {
    const ours = { shows: { 'a': { recouped: false, lastUpdated: '2026-05-24T00:00:00.000Z' } } };
    const remote = { shows: { 'a': {
      recouped: true,
      humanReviewedRecouped: true,
      lastUpdated: '2026-05-01T00:00:00.000Z',
    } } };
    const { merged } = mergeCommercialJson(ours, remote);
    assert.equal(merged.shows.a.recouped, false, 'newer wins for non-protected fields');
    assert.equal(merged.shows.a.humanReviewedRecouped, true, 'human flag overlaid from loser');
  });

  it('handles missing lastUpdated by falling back to firstAdded', () => {
    const ours = { shows: { 'a': { designation: 'TBD', firstAdded: '2026-04-01T00:00:00.000Z' } } };
    const remote = { shows: { 'a': { designation: 'Flop', firstAdded: '2026-05-01T00:00:00.000Z' } } };
    const { merged } = mergeCommercialJson(ours, remote);
    assert.equal(merged.shows.a.designation, 'Flop');
  });

  it('handles null/empty inputs gracefully', () => {
    assert.deepEqual(mergeCommercialJson(null, null).merged.shows, {});
    assert.deepEqual(mergeCommercialJson({}, {}).merged.shows, {});
  });

  it('preserves _meta.lastUpdated to the newer side', () => {
    const ours = { shows: {}, _meta: { lastUpdated: '2026-05-01' } };
    const remote = { shows: {}, _meta: { lastUpdated: '2026-05-24', designations: { Miracle: {} } } };
    const { merged } = mergeCommercialJson(ours, remote);
    assert.equal(merged._meta.lastUpdated, '2026-05-24');
    assert.ok(merged._meta.designations, 'designations carried from remote');
  });
});

// BRO-4657: Commercial Friday Refresh run 37251705556 deleted two id-keyed
// duplicates, its push was rejected, and the two-way union re-added both from
// remote. A true common ancestor tells a delete from an add.
describe('mergeCommercialJson with a base (honours deletions)', () => {
  const slugEntry = { designation: 'TBD', notes: 'kept record', lastUpdated: '2026-10-01T00:00:00.000Z' };
  const idEntry = { designation: 'TBD', notes: 'duplicate', lastUpdated: '2026-09-01T00:00:00.000Z' };

  it('is three-argument and asks reconcile-merged-json for a true base only', () => {
    assert.equal(mergeCommercialJson.length, 3);
    assert.equal(mergeCommercialJson.requiresTrueBase, true);
  });

  it('replay: ours deleted the id-keyed duplicate, remote still has it unchanged -> stays deleted', () => {
    const base = { shows: { 'the-balusters': slugEntry, 'the-balusters-2026': idEntry } };
    const remote = { shows: { 'the-balusters': slugEntry, 'the-balusters-2026': idEntry, 'new-show': { designation: 'TBD' } } };
    const ours = { shows: { 'the-balusters': slugEntry } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    assert.ok(!('the-balusters-2026' in merged.shows), 'deleted key must not be resurrected');
    assert.deepEqual(merged.shows['the-balusters'], slugEntry);
    assert.ok(merged.shows['new-show'], 'remote addition (absent from base) still lands');
    assert.equal(stats.resolvedAsDeletion, 1);
    assert.equal(stats.added, 1);
  });

  it('remote deleted a key ours left unchanged -> stays deleted', () => {
    const base = { shows: { a: slugEntry, b: idEntry } };
    const ours = { shows: { a: slugEntry, b: idEntry } };
    const remote = { shows: { a: slugEntry } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    assert.ok(!('b' in merged.shows));
    assert.equal(stats.resolvedAsDeletion, 1);
    assert.equal(stats.kept, 0);
  });

  it('ours added a key (absent from base) -> kept', () => {
    const base = { shows: { a: slugEntry } };
    const ours = { shows: { a: slugEntry, fresh: idEntry } };
    const remote = { shows: { a: slugEntry } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    assert.deepEqual(merged.shows.fresh, idEntry);
    assert.equal(stats.kept, 1);
    assert.equal(stats.resolvedAsDeletion, 0);
  });

  it('a delete racing an edit keeps the edit (either direction)', () => {
    const base = { shows: { a: slugEntry, b: idEntry } };
    const edited = { ...idEntry, designation: 'Flop', lastUpdated: '2026-10-04T00:00:00.000Z' };
    // ours deleted b, remote edited it
    let r = mergeCommercialJson({ shows: { a: slugEntry } }, { shows: { a: slugEntry, b: edited } }, base);
    assert.deepEqual(r.merged.shows.b, edited);
    assert.equal(r.stats.resolvedAsDeletion, 0);
    // remote deleted b, ours edited it
    r = mergeCommercialJson({ shows: { a: slugEntry, b: edited } }, { shows: { a: slugEntry } }, base);
    assert.deepEqual(r.merged.shows.b, edited);
    assert.equal(r.stats.resolvedAsDeletion, 0);
  });

  it('no base (undefined or null) -> two-way union, unchanged behaviour', () => {
    const ours = { shows: { a: slugEntry } };
    const remote = { shows: { a: slugEntry, b: idEntry } };
    for (const base of [undefined, null, {}]) {
      const { merged, stats } = mergeCommercialJson(ours, remote, base);
      assert.deepEqual(merged.shows.b, idEntry, `base=${JSON.stringify(base)}`);
      assert.equal(stats.resolvedAsDeletion, 0);
    }
  });

  it('does not mutate its inputs', () => {
    const base = { shows: { a: slugEntry, b: idEntry } };
    const ours = { shows: { a: slugEntry, b: idEntry } };
    const remote = { shows: { a: slugEntry } };
    const snapshot = JSON.stringify(ours);
    mergeCommercialJson(ours, remote, base);
    assert.equal(JSON.stringify(ours), snapshot);
  });
});

// BRO-4657, second half: an approved fix rewrote Lucky Guy without touching
// lastUpdated; Commercial Friday's copy had only refreshed model bookkeeping,
// tied on lastUpdated, won whole-record and reverted the fix.
describe('mergeCommercialJson with a base (field by field when both sides kept a record)', () => {
  const T = '2026-09-01T00:00:00.000Z';
  const baseRec = { designation: 'Flop', recouped: false, recoupedDate: null, notes: 'old', modelLastRun: '2026-09-28', lastUpdated: T };

  it('replay: remote fixed the label, ours touched only bookkeeping -> both kept', () => {
    const base = { shows: { 'lucky-guy-2013': baseRec } };
    const remote = { shows: { 'lucky-guy-2013': { ...baseRec, designation: 'Easy Winner', recouped: true, recoupedDate: '2013-05', notes: 'new' } } };
    const ours = { shows: { 'lucky-guy-2013': { ...baseRec, modelLastRun: '2026-10-05', modelP: 0.4 } } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    assert.deepEqual(merged.shows['lucky-guy-2013'], {
      designation: 'Easy Winner', recouped: true, recoupedDate: '2013-05', notes: 'new',
      modelLastRun: '2026-10-05', lastUpdated: T, modelP: 0.4,
    });
    assert.equal(stats.fieldMerged, 1);
    assert.equal(stats.fieldConflicts, 0);
    // The pre-fix behaviour, for contrast: no base, ours wins the tie.
    assert.equal(mergeCommercialJson(ours, remote).merged.shows['lucky-guy-2013'].designation, 'Flop');
  });

  it('a field both sides changed differently takes the newer record\'s value', () => {
    const base = { shows: { a: baseRec } };
    const ours = { shows: { a: { ...baseRec, notes: 'ours', lastUpdated: '2026-10-02T00:00:00.000Z' } } };
    const remote = { shows: { a: { ...baseRec, notes: 'remote', lastUpdated: '2026-10-03T00:00:00.000Z' } } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    assert.equal(merged.shows.a.notes, 'remote');
    assert.equal(merged.shows.a.lastUpdated, '2026-10-03T00:00:00.000Z');
    assert.equal(stats.fieldConflicts, 2);
  });

  it('a field one side deleted stays deleted; one side added is kept', () => {
    const base = { shows: { a: baseRec } };
    const { notes, ...withoutNotes } = baseRec;
    const ours = { shows: { a: withoutNotes } };
    const remote = { shows: { a: { ...baseRec, capitalization: 5000000 } } };
    const { merged } = mergeCommercialJson(ours, remote, base);
    assert.ok(!('notes' in merged.shows.a));
    assert.equal(merged.shows.a.capitalization, 5000000);
  });

  it('a manual-review flag on the losing side still survives', () => {
    const base = { shows: { a: baseRec } };
    const ours = { shows: { a: { ...baseRec, humanReviewedDesignation: false, lastUpdated: '2026-10-03T00:00:00.000Z' } } };
    const remote = { shows: { a: { ...baseRec, humanReviewedDesignation: true, lastUpdated: '2026-10-02T00:00:00.000Z' } } };
    assert.equal(mergeCommercialJson(ours, remote, base).merged.shows.a.humanReviewedDesignation, true);
  });

  it('linked fields move together: never one side\'s label with the other\'s recoupment', () => {
    const { commercialRecordErrors } = require('../../scripts/lib/commercial-record-checks.js');
    const b0 = { designation: 'TBD', recouped: null, capitalization: 1000000, capitalizationSource: 'old', lastUpdated: T };
    const base = { shows: { a: b0 } };
    // ours (newer) labels it Fizzle; remote records a recoupment and a new cap figure.
    const ours = { shows: { a: { ...b0, designation: 'Fizzle', recouped: false, lastUpdated: '2026-10-03T00:00:00.000Z' } } };
    const remote = { shows: { a: { ...b0, recouped: true, recoupedDate: '2026-09', capitalizationSource: 'Playbill', lastUpdated: '2026-10-02T00:00:00.000Z' } } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    const m = merged.shows.a;
    assert.deepEqual([m.designation, m.recouped, m.recoupedDate], ['Fizzle', false, undefined]);
    assert.equal(m.capitalizationSource, 'Playbill', 'an unrelated group only remote changed still merges');
    assert.deepEqual(commercialRecordErrors('a', m), []);
    assert.equal(stats.fieldConflicts, 2); // the designation group and lastUpdated
  });

  it('a linked group only one side changed is taken whole from that side', () => {
    const base = { shows: { a: baseRec } };
    const remote = { shows: { a: { ...baseRec, designation: 'Easy Winner', recouped: true, recoupedDate: '2013-05' } } };
    const ours = { shows: { a: { ...baseRec, notes: 'ours', lastUpdated: '2026-10-03T00:00:00.000Z' } } };
    const m = mergeCommercialJson(ours, remote, base).merged.shows.a;
    assert.deepEqual([m.designation, m.recouped, m.recoupedDate, m.notes], ['Easy Winner', true, '2013-05', 'ours']);
  });

  it('a record not in base falls back to whole-record pickNewer', () => {
    const base = { shows: {} };
    const ours = { shows: { a: { designation: 'TBD', lastUpdated: '2026-10-01T00:00:00.000Z' } } };
    const remote = { shows: { a: { designation: 'Hit', notes: 'x', lastUpdated: '2026-10-02T00:00:00.000Z' } } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    assert.deepEqual(merged.shows.a, remote.shows.a);
    assert.equal(stats.fieldMerged, 0);
  });
});

// BRO-4989 Step 0: a model re-run on a stale copy racing a cost fix.
describe('mergeCommercialJson: model-run fields and cost (BRO-4989 Step 0)', () => {
  const { LINKED_FIELD_GROUPS, MODEL_RUN_FIELDS } = require('../../scripts/lib/merge-commercial-data');
  const { breakevenBelowCost } = require('../../scripts/lib/commercial-breakeven');
  const T = '2026-10-01T00:00:00.000Z';
  // operation-mincemeat, 2026-10-06: break-even 536,585 on a 480,000 cost basis.
  const base0 = {
    designation: 'TBD', weeklyRunningCost: 480000, costMethodology: 'industry-estimate',
    modelBreakeven: 536585, modelCostBasis: 480000, modelRecoupmentPct: [10, 20, 30], modelLastRun: '2026-10-05', lastUpdated: T,
  };

  it('replay: cost fix (remote) vs stale model re-run (ours) keeps the fix and break-even >= cost', () => {
    const base = { shows: { m: base0 } };
    // The write guard rescaled the fix side's break-even (BRO-4985).
    const remote = { shows: { m: { ...base0, weeklyRunningCost: 560000, costMethodology: 'trade-reported', modelBreakeven: 626016, modelCostBasis: 560000, lastUpdated: '2026-10-06T00:00:00.000Z' } } };
    const ours = { shows: { m: { ...base0, modelBreakeven: 540000, modelCostBasis: 480000, modelRecoupmentPct: [11, 21, 31], modelLastRun: '2026-10-06' } } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    const m = merged.shows.m;
    assert.equal(m.weeklyRunningCost, 560000);
    assert.equal(m.costMethodology, 'trade-reported');
    // Both sides touched the run's fields (the guard rescaled the fix side's
    // break-even), so one side's run is taken whole: never ours' % with
    // remote's break-even. Either run was built on the old cost; the next
    // run refreshes it.
    assert.deepEqual([m.modelRecoupmentPct, m.modelLastRun], [[10, 20, 30], '2026-10-05']);
    assert.deepEqual([m.modelBreakeven, m.modelCostBasis], [626016, 560000]);
    assert.deepEqual(breakevenBelowCost(merged.shows), []);
    assert.deepEqual(stats.conflictSlugs, []);
  });

  it('a cost fix that bypassed the write guard: the merge rescales the run\'s break-even', () => {
    const base = { shows: { m: base0 } };
    const remote = { shows: { m: { ...base0, weeklyRunningCost: 560000, lastUpdated: '2026-10-06T00:00:00.000Z' } } };
    const ours = { shows: { m: { ...base0, modelBreakeven: 540000, modelRecoupmentPct: [11, 21, 31], modelLastRun: '2026-10-06' } } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    const m = merged.shows.m;
    assert.deepEqual([m.weeklyRunningCost, m.modelRecoupmentPct], [560000, [11, 21, 31]]);
    assert.deepEqual([m.modelBreakeven, m.modelCostBasis], [Math.round(540000 * 560000 / 480000), 560000]);
    assert.equal(stats.breakevenResynced, 1);
  });

  it('two model runs never mix: the newer run is taken whole', () => {
    const base = { shows: { m: base0 } };
    const ours = { shows: { m: { ...base0, modelBreakeven: 540000, modelRecoupmentPct: [1, 2, 3], modelLastRun: '2026-10-06', lastUpdated: '2026-10-06T00:00:00.000Z' } } };
    const remote = { shows: { m: { ...base0, modelBreakeven: 550000, modelRecoupmentPct: [4, 5, 6], modelWarnings: ['w'], modelLastRun: '2026-10-07' } } };
    const { merged, stats } = mergeCommercialJson(ours, remote, base);
    const m = merged.shows.m;
    assert.deepEqual([m.modelBreakeven, m.modelRecoupmentPct, m.modelLastRun, m.modelWarnings], [540000, [1, 2, 3], '2026-10-06', undefined]);
    assert.deepEqual(stats.conflictSlugs, [], 'two re-runs are not a content conflict');
    assert.equal(stats.modelRunConflicts, 1);
  });

  it('an isEstimate flag follows the side its field came from', () => {
    const b = { ...base0, recouped: false, isEstimate: { weeklyRunningCost: true } };
    const base = { shows: { m: b } };
    // remote: a reported cost replaces the estimate; ours (newer): marks recouped as an estimate.
    const remote = { shows: { m: { ...b, weeklyRunningCost: 600000, isEstimate: {} } } };
    const ours = { shows: { m: { ...b, recouped: true, designation: 'Windfall', isEstimate: { weeklyRunningCost: true, recouped: true }, lastUpdated: '2026-10-08T00:00:00.000Z' } } };
    const m = mergeCommercialJson(ours, remote, base).merged.shows.m;
    assert.equal(m.weeklyRunningCost, 600000);
    assert.deepEqual(m.isEstimate, { recouped: true });
  });

  it('an isEstimate-only edit survives whichever side is ours', () => {
    const b = { ...base0, isEstimate: { weeklyRunningCost: true } };
    const base = { shows: { m: b } };
    const flagSide = { shows: { m: { ...b, isEstimate: { weeklyRunningCost: false, recouped: true } } } };
    const notesSide = { shows: { m: { ...b, notes: 'n', lastUpdated: '2026-10-09T00:00:00.000Z' } } };
    for (const [ours, remote] of [[flagSide, notesSide], [notesSide, flagSide]]) {
      const m = mergeCommercialJson(ours, remote, base).merged.shows.m;
      assert.deepEqual(m.isEstimate, { weeklyRunningCost: false, recouped: true });
      assert.equal(m.notes, 'n');
    }
  });

  it('an ungrouped field with an isEstimate flag counts one conflict', () => {
    const b = { foo: 1, isEstimate: { foo: true }, lastUpdated: T };
    const base = { shows: { x: b } };
    const ours = { shows: { x: { ...b, foo: 2, lastUpdated: '2026-10-09T00:00:00.000Z' } } };
    const remote = { shows: { x: { ...b, foo: 3, lastUpdated: '2026-10-08T00:00:00.000Z' } } };
    const { stats } = mergeCommercialJson(ours, remote, base);
    assert.equal(stats.fieldConflicts, 2); // foo and lastUpdated
    assert.deepEqual(stats.conflictSlugs, ['x (foo)']);
  });

  it('a content conflict is reported by slug and unit', () => {
    const base = { shows: { m: base0 } };
    const ours = { shows: { m: { ...base0, weeklyRunningCost: 500000, lastUpdated: '2026-10-07T00:00:00.000Z' } } };
    const remote = { shows: { m: { ...base0, weeklyRunningCost: 510000 } } };
    const { stats } = mergeCommercialJson(ours, remote, base);
    assert.deepEqual(stats.conflictSlugs, ['m (weeklyRunningCost)']);
  });

  it('every model field merge-model-recoupment.js writes is in MODEL_RUN_FIELDS', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../scripts/merge-model-recoupment.js', import.meta.url), 'utf8');
    const written = [...new Set([...src.matchAll(/comm\.(model[A-Za-z0-9]+)\s*=[^=]/g)].map((x) => x[1]))];
    assert.ok(written.length >= 8, 'pattern still finds the writes');
    assert.deepEqual(written.filter((f) => !MODEL_RUN_FIELDS.includes(f)), []);
  });

  it('fields commercialRecordErrors checks against each other share one group', () => {
    const groupOf = (f) => LINKED_FIELD_GROUPS.findIndex((g) => g.includes(f));
    for (const pair of [['designation', 'recouped'], ['recouped', 'recoupedDate'], ['designation', 'productionType'], ['weeklyRunningCost', 'costMethodology'], ['modelBreakeven', 'modelCostBasis']]) {
      assert.ok(groupOf(pair[0]) >= 0 && groupOf(pair[0]) === groupOf(pair[1]), pair.join(' + '));
    }
  });
});

describe('mergePendingReview', () => {
  it('unions pending entries from both sides', () => {
    const ours = { shows: { 'giant': { confidence: 'high', researchedAt: '2026-05-24T00:00:00.000Z' } } };
    const remote = { shows: { 'ragtime': { confidence: 'low', researchedAt: '2026-04-01T00:00:00.000Z' } } };
    const { merged, stats } = mergePendingReview(ours, remote);
    assert.equal(Object.keys(merged.shows).length, 2);
    assert.equal(stats.added, 1);
  });

  it('picks newer entry on researchedAt for conflicting slugs', () => {
    const ours = { shows: { 'giant': { confidence: 'medium', researchedAt: '2026-05-20T00:00:00.000Z' } } };
    const remote = { shows: { 'giant': { confidence: 'high', researchedAt: '2026-05-24T00:00:00.000Z' } } };
    const { merged } = mergePendingReview(ours, remote);
    assert.equal(merged.shows.giant.confidence, 'high');
  });

  it('falls back to detectedAt if researchedAt is missing', () => {
    const ours = { shows: { 'giant': { confidence: 'medium', detectedAt: '2026-05-20T00:00:00.000Z' } } };
    const remote = { shows: { 'giant': { confidence: 'high', detectedAt: '2026-05-24T00:00:00.000Z' } } };
    const { merged } = mergePendingReview(ours, remote);
    assert.equal(merged.shows.giant.confidence, 'high');
  });

  it('does NOT resurrect a slug remote already applied and deleted (what-else follow-up)', () => {
    // ours is a stale pre-application snapshot still carrying 'giant';
    // remote is apply-commercial-pending.js's write after removing it —
    // its file-level lastUpdated is stamped AFTER giant's own entry
    // timestamp, proving remote has seen (and intentionally removed) it.
    const ours = { shows: { 'giant': { confidence: 'high', researchedAt: '2026-07-19T09:00:00.000Z' } } };
    const remote = { shows: {}, lastUpdated: '2026-07-19T10:00:00.000Z' };
    const { merged, stats } = mergePendingReview(ours, remote);
    assert.equal(merged.shows.giant, undefined, 'applied/removed entry must not be resurrected');
    assert.equal(stats.resolvedAsDeletion, 1);
  });

  it('still keeps a slug remote has not seen yet (remote predates the local addition)', () => {
    // remote's last write happened BEFORE ours added 'giant' — remote simply
    // hasn't seen it, this is NOT a deletion signal.
    const ours = { shows: { 'giant': { confidence: 'high', researchedAt: '2026-07-19T11:00:00.000Z' } } };
    const remote = { shows: {}, lastUpdated: '2026-07-19T09:00:00.000Z' };
    const { merged } = mergePendingReview(ours, remote);
    assert.equal(merged.shows.giant.confidence, 'high', 'a genuinely new local entry must survive');
  });

  it('keeps ours when remote has no lastUpdated at all (no evidence of deletion)', () => {
    const ours = { shows: { 'giant': { confidence: 'high', researchedAt: '2026-07-19T09:00:00.000Z' } } };
    const remote = { shows: {} };
    const { merged } = mergePendingReview(ours, remote);
    assert.equal(merged.shows.giant.confidence, 'high');
  });

  it('keeps ours on an exact timestamp tie (equality does not prove remote saw it)', () => {
    const ours = { shows: { 'giant': { confidence: 'high', researchedAt: '2026-07-19T09:00:00.000Z' } } };
    const remote = { shows: {}, lastUpdated: '2026-07-19T09:00:00.000Z' };
    const { merged, stats } = mergePendingReview(ours, remote);
    assert.equal(merged.shows.giant.confidence, 'high', 'a tie must not be treated as proof of deletion');
    assert.equal(stats.resolvedAsDeletion, 0);
  });
});

describe('mergeResearchQueue', () => {
  it('unions slugs from both sides with no duplicates', () => {
    const ours = { shows: ['giant', 'ragtime'], triggers: { giant: 'closing' } };
    const remote = { shows: ['ragtime', 'hairspray'], triggers: { hairspray: 'pre-opening' } };
    const { merged, stats } = mergeResearchQueue(ours, remote);
    assert.deepEqual(merged.shows, ['giant', 'ragtime', 'hairspray']);
    assert.equal(stats.added, 1, 'only hairspray is a genuinely new slug');
  });

  it('does not silently drop local-only slugs (the bug this fixes)', () => {
    // Simulates the exact regression: local run added a slug that the remote
    // side never saw. The old "accept remote" behavior would have dropped it.
    const ours = { shows: ['locally-added-slug'], triggers: {} };
    const remote = { shows: [], triggers: {} };
    const { merged } = mergeResearchQueue(ours, remote);
    assert.ok(merged.shows.includes('locally-added-slug'));
  });

  it('merges triggers from both sides', () => {
    const ours = { shows: ['a'], triggers: { a: 'closing' } };
    const remote = { shows: ['b'], triggers: { b: 'pre-opening' } };
    const { merged } = mergeResearchQueue(ours, remote);
    assert.equal(merged.triggers.a, 'closing');
    assert.equal(merged.triggers.b, 'pre-opening');
  });

  it('picks the newer updatedAt', () => {
    const ours = { shows: [], triggers: {}, updatedAt: '2026-07-14T09:00:00.000Z' };
    const remote = { shows: [], triggers: {}, updatedAt: '2026-07-15T09:36:30.155Z' };
    const { merged } = mergeResearchQueue(ours, remote);
    assert.equal(merged.updatedAt, '2026-07-15T09:36:30.155Z');
  });

  it('handles null/empty inputs gracefully', () => {
    assert.deepEqual(mergeResearchQueue(null, null).merged.shows, []);
    assert.deepEqual(mergeResearchQueue({}, {}).merged.shows, []);
  });

  it('does NOT resurrect slugs a newer consumption clear already processed (ship-check finding)', () => {
    // ours is a stale pre-consumption snapshot still carrying 'giant';
    // remote is deep-research-commercial.js's clear, written after
    // processing it. A plain union would re-add 'giant' forever.
    const ours = { shows: ['giant', 'ragtime'], triggers: { giant: 'closing', ragtime: 'pre-opening' }, updatedAt: '2026-07-19T09:00:00.000Z' };
    const remote = { shows: [], updatedAt: '2026-07-19T10:00:00.000Z' };
    const { merged, stats } = mergeResearchQueue(ours, remote);
    assert.deepEqual(merged.shows, [], 'consumed slugs must not be resurrected');
    assert.equal(stats.resolvedAsConsumption, 'remote');
  });

  it('does NOT resurrect when local side is the newer consumption clear', () => {
    const ours = { shows: [], updatedAt: '2026-07-19T10:00:00.000Z' };
    const remote = { shows: ['giant'], triggers: { giant: 'closing' }, updatedAt: '2026-07-19T09:00:00.000Z' };
    const { merged, stats } = mergeResearchQueue(ours, remote);
    assert.deepEqual(merged.shows, []);
    assert.equal(stats.resolvedAsConsumption, 'ours');
  });

  it('still unions a producer add that lands AFTER an older consumption clear', () => {
    // remote's clear is OLDER than ours' add — this is the normal case
    // (queue producer runs after the researcher already cleared it), not a
    // race, so the new slug must still be picked up.
    const ours = { shows: ['newly-queued'], triggers: { 'newly-queued': 'closing' }, updatedAt: '2026-07-19T11:00:00.000Z' };
    const remote = { shows: [], updatedAt: '2026-07-19T09:00:00.000Z' };
    const { merged } = mergeResearchQueue(ours, remote);
    assert.deepEqual(merged.shows, ['newly-queued']);
  });
});
