import { test, describe } from 'node:test';
import assert from 'node:assert';

// These will be imported from the main script once it's created
// For now, implement the filterByConfidence function inline for testing
function filterByConfidence(changes) {
  const applied = [];
  const flagged = [];
  const skipped = [];

  for (const change of changes) {
    // Skip low confidence
    if (change.confidence === 'low') {
      skipped.push({ ...change, reason: 'Low confidence' });
      continue;
    }

    // Skip designation changes to/from protected designations
    if (change.field === 'designation') {
      const protectedDesignations = ['Miracle', 'Nonprofit', 'Tour Stop'];
      if (protectedDesignations.includes(change.oldValue) || protectedDesignations.includes(change.newValue)) {
        skipped.push({ ...change, reason: 'Protected designation' });
        continue;
      }

      // Flag designation upgrades (e.g., Windfall -> Miracle)
      const designationRank = { 'Flop': 0, 'Fizzle': 1, 'TBD': 2, 'Trickle': 3, 'Easy Winner': 4, 'Windfall': 5, 'Miracle': 6 };
      if ((designationRank[change.newValue] || 0) > (designationRank[change.oldValue] || 0) && change.newValue !== 'Windfall') {
        flagged.push({ ...change, reason: 'Designation upgrade requires manual review' });
        continue;
      }

      // Allow TBD -> Windfall (recoupment) or TBD -> Fizzle/Flop (closed)
      if (change.oldValue === 'TBD' && ['Windfall', 'Fizzle', 'Flop'].includes(change.newValue)) {
        applied.push(change);
        continue;
      }
    }

    // Flag productionType changes
    if (change.field === 'productionType') {
      flagged.push({ ...change, reason: 'productionType change requires manual review' });
      continue;
    }

    // Apply all other high/medium confidence changes
    applied.push(change);
  }

  return { applied, flagged, skipped };
}

describe('filterByConfidence', () => {
  test('high confidence weeklyRunningCost -> applied', () => {
    const result = filterByConfidence([{ field: 'weeklyRunningCost', confidence: 'high', oldValue: null, newValue: 800000 }]);
    assert.strictEqual(result.applied.length, 1);
  });

  test('medium confidence estimatedRecoupmentPct -> applied', () => {
    const result = filterByConfidence([{ field: 'estimatedRecoupmentPct', confidence: 'medium', oldValue: null, newValue: [60, 80] }]);
    assert.strictEqual(result.applied.length, 1);
  });

  test('low confidence capitalization -> skipped', () => {
    const result = filterByConfidence([{ field: 'capitalization', confidence: 'low', oldValue: 20000000, newValue: 25000000 }]);
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.applied.length, 0);
  });

  test('medium confidence Windfall->Miracle designation -> skipped', () => {
    const result = filterByConfidence([{ field: 'designation', confidence: 'medium', oldValue: 'Windfall', newValue: 'Miracle' }]);
    assert.strictEqual(result.skipped.length, 1); // Miracle is protected
  });

  test('high confidence TBD->Windfall -> applied', () => {
    const result = filterByConfidence([{ field: 'designation', confidence: 'high', oldValue: 'TBD', newValue: 'Windfall' }]);
    assert.strictEqual(result.applied.length, 1);
  });

  test('high confidence TBD->Fizzle -> applied', () => {
    const result = filterByConfidence([{ field: 'designation', confidence: 'high', oldValue: 'TBD', newValue: 'Fizzle' }]);
    assert.strictEqual(result.applied.length, 1);
  });

  test('any confidence change TO Miracle -> skipped', () => {
    const result = filterByConfidence([{ field: 'designation', confidence: 'high', oldValue: 'Windfall', newValue: 'Miracle' }]);
    assert.strictEqual(result.skipped.length, 1);
  });

  test('any confidence change TO Nonprofit -> skipped', () => {
    const result = filterByConfidence([{ field: 'designation', confidence: 'high', oldValue: 'TBD', newValue: 'Nonprofit' }]);
    assert.strictEqual(result.skipped.length, 1);
  });

  test('any confidence change TO Tour Stop -> skipped', () => {
    const result = filterByConfidence([{ field: 'designation', confidence: 'high', oldValue: 'TBD', newValue: 'Tour Stop' }]);
    assert.strictEqual(result.skipped.length, 1);
  });

  test('change to productionType -> flagged', () => {
    const result = filterByConfidence([{ field: 'productionType', confidence: 'high', oldValue: null, newValue: 'tour-stop' }]);
    assert.strictEqual(result.flagged.length, 1);
  });
});
