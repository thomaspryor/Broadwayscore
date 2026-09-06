/**
 * Field-shape contract for data/outlet-registry.json entries.
 *
 * Why this is shared rather than inline in validate-data.js
 * --------------------------------------------------------
 * These rules used to live only inside validate-data.js (the "Run data
 * validation" step of the Data Validation CI job). audit-outlet-registry.js —
 * the gate an operator actually runs WHILE registering a new outlet, and the
 * later "Audit outlet-registry gaps" step of that same job — checked outlet
 * IDs and cvStyle but never starScale/multiAuthor.
 *
 * That split produced a real CI failure on 2026-09-06: a new outlet
 * (`arbuturian`) was registered with `starScale: null` after
 * audit-outlet-registry.js --strict reported exit 0, and Data Validation then
 * failed at the EARLIER validate-data.js step. Because "Audit outlet-registry
 * gaps" carries no `if:` (so it defaults to `if: success()`), that earlier
 * failure SKIPPED the gaps step entirely — the registration gate never got to
 * report on the very registration that broke the build.
 *
 * One predicate, both callers, so registering an outlet cannot pass the gate
 * you run and fail the gate you don't.
 *
 * Note `starScale: null` is NOT equivalent to omitting the key. The contract is
 * "absent or a number in ALLOWED_STAR_SCALES"; an explicit null means "someone
 * set this" and is rejected, matching validate-data.js's original
 * `!== undefined` test. Outlets that publish no star rating omit the key.
 */

// Denominators the score parsers understand. Keep in sync with
// scripts/lib/score-parsers.js.
const ALLOWED_STAR_SCALES = new Set([4, 5, 10, 100]);

/**
 * Find every registry entry whose starScale/multiAuthor field violates the
 * contract.
 *
 * @param {object} registry Parsed outlet-registry.json (either the `{outlets:
 *   {...}}` wrapper or a bare id->entry map).
 * @returns {Array<{outletId: string, field: string, value: *, message: string}>}
 *   One record per violating field. Empty array means the registry conforms.
 */
function findInvalidRegistryFields(registry) {
  const outlets = (registry && registry.outlets) || registry || {};
  const invalid = [];

  for (const [outletId, entry] of Object.entries(outlets)) {
    // These two are metadata siblings of the outlet entries, not outlets.
    if (outletId === '_aliasIndex' || outletId === '_meta') continue;
    if (!entry || typeof entry !== 'object') continue;

    if (entry.starScale !== undefined) {
      if (typeof entry.starScale !== 'number' || !ALLOWED_STAR_SCALES.has(entry.starScale)) {
        invalid.push({
          outletId,
          field: 'starScale',
          value: entry.starScale,
          message: `outlet "${outletId}": starScale=${JSON.stringify(entry.starScale)} is invalid — must be one of ${[...ALLOWED_STAR_SCALES].join(', ')} (or omit the key entirely for an outlet that publishes no star rating)`,
        });
      }
    }

    if (entry.multiAuthor !== undefined) {
      if (typeof entry.multiAuthor !== 'boolean') {
        invalid.push({
          outletId,
          field: 'multiAuthor',
          value: entry.multiAuthor,
          message: `outlet "${outletId}": multiAuthor=${JSON.stringify(entry.multiAuthor)} must be a boolean (true or false)`,
        });
      }
    }
  }

  return invalid;
}

module.exports = { ALLOWED_STAR_SCALES, findInvalidRegistryFields };
