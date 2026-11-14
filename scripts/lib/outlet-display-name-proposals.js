'use strict';

/**
 * outlet-display-name-proposals (BRO-5507)
 *
 * Applies a hand-reviewed list of outlet display-name decisions to
 * data/outlet-registry.json. The list lives in
 * data/audit/outlet-display-name-proposals.json; each row was read off the
 * outlet's own homepage (og:site_name / <title>) by a worker, because
 * audit-registry-slug-displaynames.js --fetch only accepts a masthead that
 * spells the id exactly and its selector skips ids under 12 characters or with
 * digits ("Theatrecat", "Showbiz411").
 *
 * No name matching happens here: the row says what to write, and this code
 * only refuses rows that no longer fit the registry.
 *
 *   { outletId, from, action: 'rename', to, evidence }
 *       displayName from -> to. The old name stays resolvable (its lowercase
 *       form is added to aliases), displayNameInferred is dropped and
 *       displayNameSource becomes 'homepage-reviewed'.
 *   { outletId, from, action: 'reviewed', evidence }
 *       the one-word name is the outlet's own masthead: stamp
 *       displayNameReviewed so the slug audits stop listing it.
 *
 * A row whose outlet already shows `to` (or is already stamped) is an ok
 * no-op, so a re-run plan does not fail. A row whose current displayName is
 * neither `from` nor `to` is refused: someone renamed it since review.
 * A rename that would make the new name resolve to two outlets
 * (findOutletAliasCollisions) is refused and rolled back.
 *
 * Pure: mutates the parsed registry passed in.
 */

const { findOutletAliasCollisions } = require('./outlet-alias-collision');

const ACTIONS = new Set(['rename', 'reviewed']);

function collisionKeysFor(outlets, aliasIndex, outletId) {
  return new Set(findOutletAliasCollisions(outlets, aliasIndex)
    .filter((c) => c.outletIds.includes(outletId))
    .map((c) => c.key));
}

/** Why a proposal row is malformed, or null. */
function proposalShapeProblem(row) {
  if (!row || typeof row !== 'object') return 'row is not an object';
  if (!row.outletId || typeof row.outletId !== 'string') return 'outletId missing';
  if (!ACTIONS.has(row.action)) return `${row.outletId}: action must be rename or reviewed`;
  if (typeof row.from !== 'string' || !row.from) return `${row.outletId}: from missing`;
  if (!row.evidence || String(row.evidence).trim().length < 10) return `${row.outletId}: evidence (>=10 chars) required`;
  if (row.action === 'rename') {
    const to = typeof row.to === 'string' ? row.to.trim() : '';
    if (to.length < 2 || to.length > 60) return `${row.outletId}: to must be 2-60 characters`;
    if (to !== row.to) return `${row.outletId}: to has surrounding whitespace`;
    if (to === row.from) return `${row.outletId}: to equals from`;
  }
  return null;
}

/**
 * @param {{outlets: Record<string, object>, _aliasIndex?: object}} registry
 * @param {Array<object>} proposals
 * @returns {{changed: Array<object>, unchanged: Array<object>, refused: Array<{outletId: string, reason: string}>}}
 */
function applyDisplayNameProposals(registry, proposals) {
  const outlets = registry && registry.outlets;
  if (!outlets) throw new Error('registry has no outlets');
  const changed = [];
  const unchanged = [];
  const refused = [];
  const seen = new Set();
  for (const row of proposals || []) {
    const shape = proposalShapeProblem(row);
    if (shape) { refused.push({ outletId: (row && row.outletId) || '?', reason: shape }); continue; }
    const { outletId, from, action, to } = row;
    if (seen.has(outletId)) { refused.push({ outletId, reason: 'listed twice' }); continue; }
    seen.add(outletId);
    const entry = Object.prototype.hasOwnProperty.call(outlets, outletId) ? outlets[outletId] : null;
    if (!entry) { refused.push({ outletId, reason: 'not in outlet-registry.json' }); continue; }

    if (action === 'reviewed') {
      if (entry.displayName !== from) { refused.push({ outletId, reason: `displayName is now ${JSON.stringify(entry.displayName)}, reviewed ${JSON.stringify(from)}` }); continue; }
      if (entry.displayNameReviewed === true) { unchanged.push({ outletId, action }); continue; }
      entry.displayNameReviewed = true;
      changed.push({ outletId, action, displayName: from });
      continue;
    }

    if (entry.displayName === to) { unchanged.push({ outletId, action }); continue; }
    if (entry.displayName !== from) { refused.push({ outletId, reason: `displayName is now ${JSON.stringify(entry.displayName)}, reviewed ${JSON.stringify(from)}` }); continue; }
    const before = collisionKeysFor(outlets, registry._aliasIndex, outletId);
    const snapshot = JSON.parse(JSON.stringify(entry));
    entry.displayName = to;
    delete entry.displayNameInferred;
    entry.displayNameSource = 'homepage-reviewed';
    const oldKey = from.toLowerCase();
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    if (!aliases.some((a) => String(a).toLowerCase() === oldKey)) entry.aliases = [...aliases, oldKey];
    const added = [...collisionKeysFor(outlets, registry._aliasIndex, outletId)].filter((k) => !before.has(k));
    if (added.length) {
      outlets[outletId] = snapshot;
      refused.push({ outletId, reason: `"${to}" would collide with another outlet on ${added.join(', ')}` });
      continue;
    }
    changed.push({ outletId, action, from, to });
  }
  return { changed, unchanged, refused };
}

module.exports = { applyDisplayNameProposals, proposalShapeProblem };
