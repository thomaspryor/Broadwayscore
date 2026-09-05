/**
 * linear-duplicate-gate.js — refuse a move into a `duplicate`-type workflow
 * state BEFORE any write, when the issue carries no duplicate relation.
 *
 * WHY THIS EXISTS (crown BRO-343, 2026-09-05). `linear-brain.js update
 * <BRO-N> --state Duplicate` advertises "Duplicate" as a valid state — the
 * unknown-state error prints it in its own "Valid states:" list — but Linear
 * REFUSES the mutation with `missing duplicate relation` unless the issue
 * already has an outgoing duplicate relation to its canonical twin. That
 * refusal lands at mutation time, i.e. AFTER linear-brain.js has already
 * posted the `--comment`. Observed on BRO-2711 this cycle:
 *
 *     ⚠️  partially applied before the error: comment posted
 *     ❌ Linear GraphQL error: missing duplicate relation
 *
 * The operator reads a non-zero exit as "nothing happened", re-runs, and
 * double-posts the explanation onto a card that is still sitting open. That
 * is the exact failure linear-brain.js's own comment-before-state ordering
 * was written to prevent; this gate closes the remaining hole by resolving
 * the precondition before the first write instead of discovering it after.
 *
 * SHAPE deliberately mirrors linear-done-gate.js: a pure function over data
 * the caller already fetched, returning {gated, allowed, verdict, reason} so
 * the CLI owns all I/O and exit codes. Gated on `targetStateType`, not on the
 * literal state NAME, so renaming the team's "Duplicate" state does not
 * silently stop gating (the drift trap linear-done-gate.js:14 documents).
 *
 * DIRECTION MATTERS. Linear stores "A is a duplicate of B" as an OUTGOING
 * relation on A (confirmed live 2026-09-05: after issueRelationCreate with
 * issueId=BRO-2711, relatedIssueId=BRO-2823, BRO-2711.relations held the
 * node and BRO-2823.relations stayed empty). So the issue BEING MOVED must
 * own the relation; an inverse relation on the canonical twin does not
 * satisfy Linear and must not satisfy this gate either, or the gate would
 * pass and the mutation would still fail.
 */

'use strict';

const DUPLICATE_STATE_TYPE = 'duplicate';

/**
 * Normalize the two shapes a caller can hand us for an issue's relations:
 * the raw GraphQL connection ({ nodes: [...] }) or a bare array. Anything
 * else (null, undefined, a scalar) degrades to an empty list rather than
 * throwing — a fetch that silently omitted `relations` must read as "no
 * relation known", which is the REFUSING answer, not the permissive one.
 */
function relationNodes(relations) {
  if (Array.isArray(relations)) return relations;
  if (relations && Array.isArray(relations.nodes)) return relations.nodes;
  return [];
}

/**
 * Does this issue already own an outgoing duplicate relation? Returns the
 * canonical twin's identifier when it does (so the CLI can name it in its
 * success line), or null.
 */
function existingDuplicateTarget(relations) {
  for (const node of relationNodes(relations)) {
    if (!node || node.type !== DUPLICATE_STATE_TYPE) continue;
    const related = node.relatedIssue || {};
    return related.identifier || related.id || 'an unnamed issue';
  }
  return null;
}

/**
 * @param {object} input
 * @param {string} input.targetStateType   `type` of the state being moved INTO.
 * @param {object|Array} input.relations   the issue's own `relations` (connection or array).
 * @param {string} [input.duplicateOf]     value of `--duplicate-of`, when the caller passed one.
 * @returns {{gated: boolean, allowed: boolean, verdict: string, reason: string,
 *            needsRelation: boolean, existingTarget: string|null}}
 */
function checkLinearDuplicateTransition({ targetStateType, relations, duplicateOf } = {}) {
  if (targetStateType !== DUPLICATE_STATE_TYPE) {
    return {
      gated: false,
      allowed: true,
      verdict: 'not-a-duplicate-move',
      reason: '',
      needsRelation: false,
      existingTarget: null,
    };
  }

  const existingTarget = existingDuplicateTarget(relations);
  if (existingTarget) {
    return {
      gated: true,
      allowed: true,
      verdict: 'relation-already-present',
      reason: `already marked a duplicate of ${existingTarget}`,
      needsRelation: false,
      existingTarget,
    };
  }

  // `--duplicate-of` with no value parses to boolean true (parseArgs treats a
  // trailing flag that way), and an empty string is equally unusable. Both
  // must REFUSE rather than fall through into a relation call with a
  // garbage identifier.
  const asked = typeof duplicateOf === 'string' ? duplicateOf.trim() : '';
  if (asked) {
    return {
      gated: true,
      allowed: true,
      verdict: 'relation-will-be-created',
      reason: `will mark it a duplicate of ${asked} before the state move`,
      needsRelation: true,
      existingTarget: null,
    };
  }

  return {
    gated: true,
    allowed: false,
    verdict: 'no-duplicate-relation',
    reason:
      'Linear refuses a move into a duplicate-type state unless the issue owns an outgoing\n' +
      'duplicate relation naming its canonical twin. This issue has none, so the mutation\n' +
      'would fail server-side with "missing duplicate relation" — AFTER any --comment on\n' +
      'this call had already been posted.\n\n' +
      'Pass --duplicate-of <BRO-N> to create the relation and then move the state in one go.',
    needsRelation: false,
    existingTarget: null,
  };
}

module.exports = {
  DUPLICATE_STATE_TYPE,
  relationNodes,
  existingDuplicateTarget,
  checkLinearDuplicateTransition,
};
