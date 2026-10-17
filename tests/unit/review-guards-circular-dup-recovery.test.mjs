/**
 * Unit tests for isScoreable / isIncludableForRebuild — circular-duplicate
 * recovery parity with rebuild-all-reviews.js.
 *
 * BUG F (Heated Rivalry nyt-theater--*, 2026-05-27): rebuild's circular-
 * duplicate-recovery path keeps the lexically-lower file when two review-text
 * files mutually point at each other with the same fullText fingerprint. The
 * LLM scorer skipped both because its `if (data.duplicateOf) return false;`
 * guard fired before it had a chance to consult the partner file. Result:
 * the file rebuild keeps never gets a score, never appears in reviews.json.
 *
 * Fix: isIncludableForRebuild (and its wrapper isScoreable) now accept an
 * optional filePath. When passed AND data.duplicateOf is set, we mirror the
 * rebuild logic at scripts/rebuild-all-reviews.js ~lines 1685-1730 to keep
 * the same side rebuild keeps. When filePath is omitted, behavior is
 * unchanged (skip on any duplicateOf) — recovery is opt-in.
 *
 * Pattern: require() the real function; never copy logic into tests.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
const { isIncludableForRebuild } = require('../../scripts/lib/review-guards.js');

// Build a minimal "complete" review payload that passes every other guard in
// isIncludableForRebuild. Anything failing those would shadow the duplicateOf
// behavior under test.
const longReviewText = 'A real critic review with substance and verdict. '.repeat(40);
const differentReviewText = 'A wholly distinct take with different verdict words. '.repeat(40);
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circular-dup-recovery-'));
});
after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name, payload) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  return p;
}

describe('isScoreable — circular-duplicate-recovery parity with rebuild', () => {

  test('case 1: A.duplicateOf=B, B.duplicateOf=A, same text, A < B → A scoreable, B not', () => {
    const aName = 'aaa-critic.json';
    const bName = 'zzz-critic.json'; // lexically greater
    const aData = basePayload({ duplicateOf: bName });
    const bData = basePayload({ duplicateOf: aName });
    const aPath = writeFile(aName, aData);
    const bPath = writeFile(bName, bData);

    assert.equal(
      isScoreable(aData, undefined, aPath),
      true,
      'A (lexically lower) should be scoreable — matches rebuild keep-side',
    );
    assert.equal(
      isScoreable(bData, undefined, bPath),
      false,
      'B (lexically greater) should be skipped — matches rebuild tiebreak',
    );
    // isIncludableForRebuild directly should mirror.
    assert.equal(isIncludableForRebuild(aData, undefined, aPath), true);
    assert.equal(isIncludableForRebuild(bData, undefined, bPath), false);
  });

  test('case 2: A.duplicateOf=B, B.duplicateOf=A, DIFFERENT text → both scoreable', () => {
    // Rebuild keeps both when text fingerprints diverge — duplicateOf was
    // wrongly set on a legitimate separate review (see rebuild-all-reviews.js
    // comment at line 1693).
    const aName = 'aaa-critic.json';
    const bName = 'zzz-critic.json';
    const aData = basePayload({ duplicateOf: bName, fullText: longReviewText });
    const bData = basePayload({ duplicateOf: aName, fullText: differentReviewText });
    const aPath = writeFile(aName, aData);
    const bPath = writeFile(bName, bData);

    assert.equal(
      isScoreable(aData, undefined, aPath),
      true,
      'A should be scoreable — different text means duplicateOf was wrongly set',
    );
    assert.equal(
      isScoreable(bData, undefined, bPath),
      true,
      'B should also be scoreable — same reason',
    );
  });

  test('case 3: A.duplicateOf=B, B file missing on disk → A scoreable (stale pointer)', () => {
    const aName = 'aaa-critic.json';
    const missingName = 'never-existed.json';
    const aData = basePayload({ duplicateOf: missingName });
    const aPath = writeFile(aName, aData);

    assert.equal(
      isScoreable(aData, undefined, aPath),
      true,
      'A should be scoreable — pointer is stale; rebuild keeps it',
    );
  });

  test('case 4: A.duplicateOf=B, B exists but B.duplicateOf NOT set → A NOT scoreable (legit dup)', () => {
    const aName = 'aaa-critic.json';
    const bName = 'zzz-critic.json';
    const aData = basePayload({ duplicateOf: bName });
    const bData = basePayload({}); // no duplicateOf on B
    const aPath = writeFile(aName, aData);
    writeFile(bName, bData);

    assert.equal(
      isScoreable(aData, undefined, aPath),
      false,
      'A should be skipped — legitimate duplicate (current behavior preserved)',
    );
  });

  test('case 5: A.duplicateOf NOT set → A scoreable', () => {
    const aName = 'aaa-critic.json';
    const aData = basePayload({});
    const aPath = writeFile(aName, aData);

    assert.equal(
      isScoreable(aData, undefined, aPath),
      true,
      'A should be scoreable — no duplicateOf flag',
    );
    // And without filePath at all.
    assert.equal(isScoreable(aData), true);
  });

  test('regression: filePath omitted + duplicateOf set → skip (opt-in recovery)', () => {
    // Callers that don't have a path readily available must still get the
    // historical "skip on any duplicateOf" behavior — the recovery is opt-in.
    const data = basePayload({ duplicateOf: 'whatever.json' });
    assert.equal(isScoreable(data), false);
    assert.equal(isIncludableForRebuild(data, undefined), false);
  });
});
