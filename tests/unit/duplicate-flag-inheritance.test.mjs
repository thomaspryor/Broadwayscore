/**
 * Unit tests for duplicateOfInheritedFlag (task #1256).
 *
 * BUG: rebuild-all-reviews.js's duplicateOf handling treats "the reference
 * file is excluded" as a recovery signal and lets the duplicateOf file
 * through unconditionally — even when the reference is excluded because its
 * OWN CONTENT is wrong (wrongShow/wrongProduction/isNonReview). Confirmed
 * live on The Play That Goes Wrong (West End 2021): a duplicateOf file
 * inherited its wrongShow-flagged twin's bad content and scored 84.
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { duplicateOfInheritedFlag, isIncludableForRebuild } = require('../../scripts/lib/review-guards.js');

const longReviewText = 'A real critic review with substance and verdict. '.repeat(40);

function basePayload(overrides = {}) {
  return {
    contentTier: 'complete',
    isFullReview: true,
    fullText: longReviewText,
    ...overrides,
  };
}

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-flag-inheritance-'));
});
after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name, payload) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  return p;
}

describe('duplicateOfInheritedFlag', () => {
  test('twin carries uncleared wrongShow → inherits "wrongShow"', () => {
    const aData = basePayload({ duplicateOf: 'twin.json' });
    const refData = basePayload({ wrongShow: true });

    assert.equal(duplicateOfInheritedFlag(aData, refData), 'wrongShow');
  });

  test('twin carries uncleared wrongProduction → inherits "wrongProduction"', () => {
    const aData = basePayload({ duplicateOf: 'twin.json' });
    const refData = basePayload({ wrongProduction: true });

    assert.equal(duplicateOfInheritedFlag(aData, refData), 'wrongProduction');
  });

  test('twin carries isNonReview → inherits "nonReview"', () => {
    const aData = basePayload({ duplicateOf: 'twin.json' });
    const refData = basePayload({ isNonReview: true });

    assert.equal(duplicateOfInheritedFlag(aData, refData), 'nonReview');
  });

  test('explicit clear breadcrumb on the promoted file → no inheritance, even though twin is flagged', () => {
    const aData = basePayload({ duplicateOf: 'twin.json', duplicateOfFlagInheritanceCleared: true });
    const refData = basePayload({ wrongShow: true });

    assert.equal(duplicateOfInheritedFlag(aData, refData), null);
  });

  test('twin\'s wrongShow was already manually cleared → no inheritance', () => {
    const aData = basePayload({ duplicateOf: 'twin.json' });
    const refData = basePayload({ wrongShow: true, wrongShowManualClear: true });

    assert.equal(duplicateOfInheritedFlag(aData, refData), null);
  });

  test('twin is clean (no content-wrongness flag) → no inheritance', () => {
    const aData = basePayload({ duplicateOf: 'twin.json' });
    const refData = basePayload({});

    assert.equal(duplicateOfInheritedFlag(aData, refData), null);
  });

  test('twin excluded for a non-content reason (pre-window date) → no inheritance', () => {
    // isPrematureReviewForUnopenedShow style exclusion — structural, not a
    // "this content is wrong" signal. The existing refExcluded recovery path
    // must stay untouched for this case.
    const aData = basePayload({ duplicateOf: 'twin.json' });
    const refData = basePayload({ contentTier: 'invalid', fullText: null });
    // contentTierInvalid (without a text/signal fallback) excludes refData
    // via explainExclusion but is not one of the inherited reasons.
    assert.equal(duplicateOfInheritedFlag(aData, refData), null);
  });

  test('missing data or refData → null, does not throw', () => {
    assert.equal(duplicateOfInheritedFlag(null, basePayload()), null);
    assert.equal(duplicateOfInheritedFlag(basePayload(), null), null);
    assert.equal(duplicateOfInheritedFlag(null, null), null);
  });

  test('circular pair (A<->B) where B independently carries wrongShow → still inherits (B\'s content flag wins)', () => {
    const aName = 'aaa-critic.json';
    const bName = 'zzz-critic.json';
    const aData = basePayload({ duplicateOf: bName });
    const bData = basePayload({ duplicateOf: aName, wrongShow: true });
    writeFile(aName, aData);
    const bPath = writeFile(bName, bData);

    assert.equal(duplicateOfInheritedFlag(aData, bData, undefined, bPath), 'wrongShow');
  });

  test('end-to-end: isIncludableForRebuild alone cannot distinguish this case (documents why the detector must not use it)', () => {
    // The reason this fix needs a NEW detector: isIncludableForRebuild(A) is
    // already false whenever A.duplicateOf is set and the reference exists
    // and is clean — the SAME false it would be if the twin were flagged.
    // duplicateOfInheritedFlag is what actually distinguishes "legit dup,
    // safe to exclude" from "twin's content is wrong, exclude for THAT
    // reason" — isScoreable/isIncludableForRebuild give no signal either way
    // without a filePath-driven duplicateOf walk of their own.
    const aData = basePayload({ duplicateOf: 'twin.json' });
    const refDataFlagged = basePayload({ wrongShow: true });
    const refDataClean = basePayload({});

    assert.equal(isIncludableForRebuild(aData), false, 'no filePath — isIncludableForRebuild always excludes on any duplicateOf');
    assert.equal(duplicateOfInheritedFlag(aData, refDataFlagged), 'wrongShow');
    assert.equal(duplicateOfInheritedFlag(aData, refDataClean), null);
  });
});
