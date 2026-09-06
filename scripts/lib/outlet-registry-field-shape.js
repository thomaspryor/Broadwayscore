/**
 * outlet-registry-field-shape.js
 *
 * The starScale / multiAuthor shape check for outlet-registry.json entries,
 * extracted out of validate-data.js so a test can require() the real decision
 * instead of restating it (CLAUDE.md rule 15).
 *
 * Why this is its own module rather than an inline block: the MESSAGE is the
 * product here, not just the boolean. Test Suite run 34003135401 went red on
 * 2026-09-06 for a single hand-added outlet ("arbuturian") whose author wrote
 * `"starScale": null` to mean "this outlet has no star scale". The check was
 * right to reject it — null is present, and "present" is what the rule gates
 * on — but the message it printed, "must be one of 4, 5, 10, 100", reads as
 * if the author now has to invent a scale. They must not. 1,094 of the 1,129
 * outlets express "no star scale" by OMITTING the key, every consumer tests
 * it with Number.isFinite() so null and absent are indistinguishable
 * downstream, and adding a second spelling for the same fact buys nothing.
 * So null gets a sentence naming the actual fix.
 */

'use strict';

const ALLOWED_STAR_SCALES = new Set([4, 5, 10, 100]);

/**
 * @param {string} id     outlet id, for the message
 * @param {object} entry  the registry entry
 * @returns {string[]} zero or more error messages, already prefixed
 */
function outletFieldShapeErrors(id, entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return errors;

  if (entry.starScale !== undefined) {
    if (typeof entry.starScale !== 'number' || !ALLOWED_STAR_SCALES.has(entry.starScale)) {
      const fix = entry.starScale === null
        ? ' — for an outlet with no star scale, OMIT the key entirely rather than setting it to null (that is how the other ~1,094 outlets express it)'
        : '';
      errors.push(`[registry-field] outlet "${id}": starScale=${JSON.stringify(entry.starScale)} is invalid — must be one of ${[...ALLOWED_STAR_SCALES].join(', ')}${fix}`);
    }
  }

  if (entry.multiAuthor !== undefined) {
    if (typeof entry.multiAuthor !== 'boolean') {
      errors.push(`[registry-field] outlet "${id}": multiAuthor=${JSON.stringify(entry.multiAuthor)} must be a boolean (true or false)`);
    }
  }

  return errors;
}

module.exports = { outletFieldShapeErrors, ALLOWED_STAR_SCALES };
