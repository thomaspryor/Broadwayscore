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
  RELATIONS_PAGE_SIZE,
  relationNodes,
  existingDuplicateTarget,
  relationsPageMaybeTruncated,
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

// ── adversarial + fresh-eyes review findings, 2026-09-05 ───────────────────

test('refused: --duplicate-of names a DIFFERENT twin than the relation already on the issue', () => {
  // The original ordering returned "relation-already-present" before it looked
  // at duplicateOf at all, so BRO-20 was silently discarded and the card kept
  // BRO-10 with exit 0. Two answers to "which issue is this a duplicate of"
  // must stop the operator, not be resolved by argument order.
  const v = checkLinearDuplicateTransition({
    targetStateType: DUPLICATE_STATE_TYPE,
    relations: dupRelation('BRO-10'),
    duplicateOf: 'BRO-20',
  });
  assert.equal(v.allowed, false);
  assert.equal(v.verdict, 'duplicate-target-mismatch');
  assert.equal(v.existingTarget, 'BRO-10');
  assert.match(v.reason, /BRO-10/);
  assert.match(v.reason, /BRO-20/);
});

test('allowed: --duplicate-of naming the SAME twin already on the issue is a no-op, not a mismatch', () => {
  const v = checkLinearDuplicateTransition({
    targetStateType: DUPLICATE_STATE_TYPE,
    relations: dupRelation('BRO-2823'),
    duplicateOf: '  BRO-2823  ',
  });
  assert.equal(v.allowed, true);
  assert.equal(v.verdict, 'relation-already-present');
  assert.equal(v.needsRelation, false, 'the relation exists — do not create a second one');
});

test('the refusal leads with the ACTION, not the explanation', () => {
  const v = checkLinearDuplicateTransition({
    targetStateType: DUPLICATE_STATE_TYPE,
    relations: { nodes: [] },
  });
  assert.match(v.reason.split('\n')[0], /^Pass --duplicate-of <BRO-N>/);
});

test('a FULL relations page says the read may be truncated instead of asserting absence', () => {
  // relations(first: N) is unpaginated, so N nodes back cannot PROVE the
  // duplicate relation is absent — it could be node N+1. The verdict stays
  // "refuse" (guessing is how a silent wrong write happens) but the message
  // must not claim a fact it never established.
  const full = {
    nodes: Array.from({ length: RELATIONS_PAGE_SIZE }, () => ({
      type: 'blocks',
      relatedIssue: { identifier: 'BRO-1' },
    })),
  };
  const v = checkLinearDuplicateTransition({ targetStateType: DUPLICATE_STATE_TYPE, relations: full });
  assert.equal(v.allowed, false, 'a truncated read must still refuse, not pass');
  assert.match(v.reason, /truncated read/);
  assert.equal(relationsPageMaybeTruncated(full), true);
  assert.equal(relationsPageMaybeTruncated({ nodes: full.nodes.slice(0, RELATIONS_PAGE_SIZE - 1) }), false);
});

test('RELATIONS_PAGE_SIZE is the same number buildIssueQuery actually asks for', () => {
  // Two constants that must agree: widen the query without widening this and
  // the truncation warning stops firing exactly when it starts being needed.
  const query = require('./linear-dispatch.js').buildIssueQuery();
  assert.ok(
    query.includes(`relations(first: ${RELATIONS_PAGE_SIZE})`),
    `query must ask for relations(first: ${RELATIONS_PAGE_SIZE}); got:\n${query}`
  );
});
