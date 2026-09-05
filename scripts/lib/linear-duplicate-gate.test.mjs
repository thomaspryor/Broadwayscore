// Pure-function tests for scripts/lib/linear-duplicate-gate.js (crown BRO-343).
// The CLI wiring — exit 6, "nothing written on refusal", --duplicate-of
// creating the relation BEFORE the comment — is proved separately in a real
// subprocess by tests/unit/linear-brain-duplicate-gate.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DUPLICATE_STATE_TYPE,
  relationNodes,
  existingDuplicateTarget,
  checkLinearDuplicateTransition,
} = require('./linear-duplicate-gate.js');

const dupRelation = (identifier) => ({
  nodes: [{ type: 'duplicate', relatedIssue: { id: 'uuid-canonical', identifier } }],
});

test('not gated: any non-duplicate target state passes untouched', () => {
  for (const type of ['completed', 'canceled', 'started', 'unstarted', 'backlog', undefined]) {
    const v = checkLinearDuplicateTransition({ targetStateType: type, relations: null });
    assert.equal(v.gated, false, `type=${type} must not be gated`);
    assert.equal(v.allowed, true);
    assert.equal(v.needsRelation, false);
  }
});

test('refused: duplicate-type move with no relation and no --duplicate-of', () => {
  const v = checkLinearDuplicateTransition({
    targetStateType: DUPLICATE_STATE_TYPE,
    relations: { nodes: [] },
  });
  assert.equal(v.gated, true);
  assert.equal(v.allowed, false);
  assert.equal(v.verdict, 'no-duplicate-relation');
  assert.equal(v.needsRelation, false);
  assert.match(v.reason, /missing duplicate relation/);
  assert.match(v.reason, /--duplicate-of/);
});

test('allowed: the issue already owns an outgoing duplicate relation', () => {
  const v = checkLinearDuplicateTransition({
    targetStateType: DUPLICATE_STATE_TYPE,
    relations: dupRelation('BRO-2823'),
  });
  assert.equal(v.allowed, true);
  assert.equal(v.verdict, 'relation-already-present');
  assert.equal(v.needsRelation, false, 'an existing relation must not be created a second time');
  assert.equal(v.existingTarget, 'BRO-2823');
});

test('allowed: --duplicate-of asks for the relation to be created first', () => {
  const v = checkLinearDuplicateTransition({
    targetStateType: DUPLICATE_STATE_TYPE,
    relations: { nodes: [] },
    duplicateOf: 'BRO-2823',
  });
  assert.equal(v.allowed, true);
  assert.equal(v.verdict, 'relation-will-be-created');
  assert.equal(v.needsRelation, true);
});

test('refused: a NON-duplicate relation (blocks/related) does not satisfy the gate', () => {
  for (const type of ['blocks', 'related', 'similar']) {
    const v = checkLinearDuplicateTransition({
      targetStateType: DUPLICATE_STATE_TYPE,
      relations: { nodes: [{ type, relatedIssue: { identifier: 'BRO-1' } }] },
    });
    assert.equal(v.allowed, false, `relation type ${type} must not pass the duplicate gate`);
    assert.equal(v.verdict, 'no-duplicate-relation');
  }
});

test('refused: --duplicate-of with no value (parses to boolean true) and empty/whitespace strings', () => {
  // parseArgs turns a trailing `--duplicate-of` into boolean true. Falling
  // through on that would call issueRelationCreate with "true" as an
  // identifier — a write attempted on garbage input.
  for (const bad of [true, '', '   ', undefined, null, 0]) {
    const v = checkLinearDuplicateTransition({
      targetStateType: DUPLICATE_STATE_TYPE,
      relations: { nodes: [] },
      duplicateOf: bad,
    });
    assert.equal(v.allowed, false, `--duplicate-of ${JSON.stringify(bad)} must refuse, not proceed`);
    assert.equal(v.needsRelation, false);
  }
});

test('a MISSING relations field reads as "no relation known", i.e. refuses — absence is never the permissive answer', () => {
  // The failure mode this guards: a future query edit drops `relations` from
  // buildIssueQuery, every issue reads as unrelated, and a permissive default
  // would silently stop gating while every call still fails server-side.
  for (const relations of [undefined, null, {}, { nodes: null }, 42, 'nodes']) {
    const v = checkLinearDuplicateTransition({ targetStateType: DUPLICATE_STATE_TYPE, relations });
    assert.equal(v.allowed, false, `relations=${JSON.stringify(relations)} must refuse`);
  }
});

test('relationNodes normalizes a bare array as well as a GraphQL connection', () => {
  const nodes = [{ type: 'duplicate', relatedIssue: { identifier: 'BRO-9' } }];
  assert.deepEqual(relationNodes(nodes), nodes);
  assert.deepEqual(relationNodes({ nodes }), nodes);
  assert.deepEqual(relationNodes(null), []);
  assert.equal(existingDuplicateTarget(nodes), 'BRO-9');
});

test('existingDuplicateTarget falls back to the uuid, then a placeholder, when identifier is absent', () => {
  assert.equal(
    existingDuplicateTarget([{ type: 'duplicate', relatedIssue: { id: 'uuid-only' } }]),
    'uuid-only'
  );
  assert.equal(existingDuplicateTarget([{ type: 'duplicate' }]), 'an unnamed issue');
  assert.equal(existingDuplicateTarget([]), null);
});
