/**
 * Unit tests for scripts/lib/duplicate-cycle.js — the shared duplicateOf
 * cycle-walk used by review-write-guard.js (write-time refusal),
 * audit-duplicate-of-url-mismatch.js (post-hoc detection), and
 * rebuild-all-reviews.js (circular-duplicate tiebreak).
 *
 * Notion #967 (write-time cousin of #941): both the write-time guard and the
 * rebuild's own circular-tiebreak used to carry a 2-node-only assumption
 * (`colliderData.duplicateOf === thisBasename`). A longer chain — A->B->C->A
 * — never found a terminal non-duplicate node, so every member fell through
 * and ALL of them landed in reviews.json as same-URL duplicates (the washpost
 * 3-cycle from Notion #941). These tests cover findDuplicateOfCycle (also
 * exercised via tests/unit/duplicate-of-url-mismatch.test.mjs's audit-level
 * cases) and resolveCycleTiebreak — the exact decision function
 * rebuild-all-reviews.js's circular block now calls for N-node cycles.
 *
 * Run: node --test tests/unit/duplicate-cycle.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDuplicateOfCycle, wouldFormDuplicateCycle, resolveCycleTiebreak } = require('../../scripts/lib/duplicate-cycle.js');
const { computeContentFingerprint } = require('../../scripts/lib/content-quality.js');
const { DUPLICATE_POINTER_FIELDS } = require('../../scripts/lib/canonical-duplicate-pointers.js');

// ---------------------------------------------------------------------------
// findDuplicateOfCycle
// ---------------------------------------------------------------------------

test('findDuplicateOfCycle: 2-node cycle (A<->B)', () => {
  const records = {
    'a.json': { duplicateOf: 'b.json' },
    'b.json': { duplicateOf: 'a.json' },
  };
  const load = (name) => records[name] || null;
  const result = findDuplicateOfCycle('a.json', load, 10);
  assert.equal(result.cycleFound, true);
  assert.deepEqual(result.chain, ['a.json', 'b.json', 'a.json']);
});

test('findDuplicateOfCycle: 3-node cycle (A->B->C->A, the Notion #941 washpost class)', () => {
  const records = {
    'andor-brodeur.json': { duplicateOf: 'justin-davidson.json' },
    'justin-davidson.json': { duplicateOf: 'michael-andor-brodeur.json' },
    'michael-andor-brodeur.json': { duplicateOf: 'andor-brodeur.json' },
  };
  const load = (name) => records[name] || null;
  const result = findDuplicateOfCycle('andor-brodeur.json', load, 10);
  assert.equal(result.cycleFound, true);
  assert.deepEqual(result.chain, ['andor-brodeur.json', 'justin-davidson.json', 'michael-andor-brodeur.json', 'andor-brodeur.json']);
});

test('findDuplicateOfCycle: chain that terminates (no cycle)', () => {
  const records = {
    'a.json': { duplicateOf: 'b.json' },
    'b.json': { duplicateOf: 'c.json' },
    'c.json': {},
  };
  const load = (name) => records[name] || null;
  const result = findDuplicateOfCycle('a.json', load, 10);
  assert.equal(result.cycleFound, false);
});

test('findDuplicateOfCycle: no duplicateOf at all', () => {
  const load = () => ({});
  const result = findDuplicateOfCycle('a.json', load, 10);
  assert.equal(result.cycleFound, false);
  assert.deepEqual(result.chain, ['a.json']);
});

test('findDuplicateOfCycle: stale pointer to a missing sibling is not a cycle', () => {
  const load = (name) => (name === 'a.json' ? { duplicateOf: 'gone.json' } : null);
  const result = findDuplicateOfCycle('a.json', load, 10);
  assert.equal(result.cycleFound, false);
});

// ---------------------------------------------------------------------------
// duplicateTextOf (Notion #1750, 2026-08-17): the walk used to follow
// duplicateOf ONLY. A corpus scan the same day found 386 mutual cycles, every
// one of the shape A.duplicateOf=B + B.duplicateTextOf=A — none refusable at
// write time. These cover both the mixed-field real-world shape and each
// field in DUPLICATE_POINTER_FIELDS individually, so a future field added to
// that canonical list is covered here without a test change.
// ---------------------------------------------------------------------------

test('findDuplicateOfCycle: 2-node cycle via each canonical pointer field (DUPLICATE_POINTER_FIELDS)', () => {
  for (const field of DUPLICATE_POINTER_FIELDS) {
    const records = {
      'a.json': { [field]: 'b.json' },
      'b.json': { [field]: 'a.json' },
    };
    const load = (name) => records[name] || null;
    const result = findDuplicateOfCycle('a.json', load, 10);
    assert.equal(result.cycleFound, true, `cycle via ${field} alone must be detected`);
  }
});

test('findDuplicateOfCycle: mixed-field 2-node cycle — A.duplicateOf=B, B.duplicateTextOf=A (the exact corpus-wide 2026-08-17 shape, all 386 mutual cycles)', () => {
  const records = {
    'times-uk--clive-davis.json': { duplicateOf: 'loves-labours-lost--clive-davis.json' },
    'loves-labours-lost--clive-davis.json': { duplicateTextOf: 'times-uk--clive-davis.json' },
  };
  const load = (name) => records[name] || null;
  const result = findDuplicateOfCycle('times-uk--clive-davis.json', load, 10);
  assert.equal(result.cycleFound, true);
  assert.deepEqual(result.chain, ['times-uk--clive-davis.json', 'loves-labours-lost--clive-davis.json', 'times-uk--clive-davis.json']);
});

test('findDuplicateOfCycle: mixed-field chain that does NOT cycle back (B.duplicateTextOf points to a third file, not A)', () => {
  const records = {
    'a.json': { duplicateOf: 'b.json' },
    'b.json': { duplicateTextOf: 'c.json' },
    'c.json': {},
  };
  const load = (name) => records[name] || null;
  const result = findDuplicateOfCycle('a.json', load, 10);
  assert.equal(result.cycleFound, false);
});

// ---------------------------------------------------------------------------
// wouldFormDuplicateCycle (write-time; also covered end-to-end via
// tests/unit/circular-duplicate-pair.test.mjs's safeWriteReview integration tests)
// ---------------------------------------------------------------------------

test('wouldFormDuplicateCycle: N-node — writing the edge that closes a 3-cycle', () => {
  const records = {
    'a.json': { duplicateOf: 'b.json' },
    'b.json': { duplicateOf: 'c.json' },
  };
  const load = (name) => records[name] || null;
  assert.equal(wouldFormDuplicateCycle('c.json', 'a.json', load), true);
});

test('wouldFormDuplicateCycle: refuses a write that would complete an A<->B cycle via duplicateTextOf (today only duplicateOf is seen, so all 386 latent corpus cycles are unrefusable)', () => {
  const records = {
    'b.json': { duplicateTextOf: 'a.json' },
  };
  const load = (name) => records[name] || null;
  // Writing a.json.duplicateOf = b.json would close the loop: b.json already
  // points back at a.json via duplicateTextOf.
  assert.equal(wouldFormDuplicateCycle('a.json', 'b.json', load), true);
});

test('wouldFormDuplicateCycle: duplicateTextOf 3-node cycle — writing the edge that closes it', () => {
  const records = {
    'a.json': { duplicateTextOf: 'b.json' },
    'b.json': { duplicateTextOf: 'c.json' },
  };
  const load = (name) => records[name] || null;
  assert.equal(wouldFormDuplicateCycle('c.json', 'a.json', load), true);
});

// ---------------------------------------------------------------------------
// resolveCycleTiebreak — the decision rebuild-all-reviews.js's circular block
// uses once findDuplicateOfCycle confirms a cycle exists.
// ---------------------------------------------------------------------------

const body = (n) => 'x'.repeat(n);

test('resolveCycleTiebreak: 2-node cycle, same text → lexicographically-smaller basename survives (parity with the pre-existing 2-node rule)', () => {
  const text = `A real critic review with substance and verdict. ${body(400)}`;
  const records = {
    'aaa-critic.json': { fullText: text },
    'zzz-critic.json': { fullText: text },
  };
  const load = (name) => records[name] || null;
  const { sameText, survivor } = resolveCycleTiebreak(['aaa-critic.json', 'zzz-critic.json'], load, computeContentFingerprint);
  assert.equal(sameText, true);
  assert.equal(survivor, 'aaa-critic.json');
});

test('resolveCycleTiebreak: 3-node cycle, all same text → exactly one survivor, the lexicographic minimum', () => {
  const text = `The Washington Post reviews this production with a clear verdict. ${body(400)}`;
  const records = {
    'wapo--andor-brodeur.json': { fullText: text },
    'wapo--justin-davidson.json': { fullText: text },
    'wapo--michael-andor-brodeur.json': { fullText: text },
  };
  const members = Object.keys(records);
  const load = (name) => records[name] || null;
  const { sameText, survivor } = resolveCycleTiebreak(members, load, computeContentFingerprint);
  assert.equal(sameText, true);
  assert.equal(survivor, 'wapo--andor-brodeur.json', 'lexicographic minimum of the three basenames');
  // Every member's independent rebuild pass computes the SAME members array
  // and reaches the SAME survivor — exactly one member excluded is wrong,
  // exactly one survivor is right, regardless of which member is asking.
  for (const m of members) {
    const excludeThis = m !== survivor;
    assert.equal(excludeThis, m !== 'wapo--andor-brodeur.json');
  }
});

test('resolveCycleTiebreak: 3-node cycle, DIFFERENT text on one member → sameText false, all kept (duplicateOf was wrongly set)', () => {
  const textA = `A real critic review with substance and verdict. ${body(400)}`;
  const textB = `A wholly distinct take with different verdict words. ${body(400)}`;
  const records = {
    'a.json': { fullText: textA },
    'b.json': { fullText: textA },
    'c.json': { fullText: textB },
  };
  const load = (name) => records[name] || null;
  const { sameText } = resolveCycleTiebreak(['a.json', 'b.json', 'c.json'], load, computeContentFingerprint);
  assert.equal(sameText, false, 'a diverging member means duplicateOf was wrongly set — nobody gets excluded on text grounds');
});

test('resolveCycleTiebreak: a member with no fullText breaks sameText (never tiebreak on an unprovable match)', () => {
  const text = body(400);
  const records = {
    'a.json': { fullText: text },
    'b.json': {}, // no fullText
  };
  const load = (name) => records[name] || null;
  const { sameText } = resolveCycleTiebreak(['a.json', 'b.json'], load, computeContentFingerprint);
  assert.equal(sameText, false);
});

test('resolveCycleTiebreak: empty members list is a safe no-op', () => {
  const { sameText, survivor } = resolveCycleTiebreak([], () => null, computeContentFingerprint);
  assert.equal(sameText, false);
  assert.equal(survivor, null);
});
