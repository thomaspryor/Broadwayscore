/**
 * Natural key for an Off-West End staging candidate: sha256(title|venue)
 * truncated to 16 hex chars, both halves lower-cased and trimmed.
 *
 * Lives in its own write-free module (BRO-4268 land-gate finding): the push-
 * time merger (merge-owe-venue-candidates.js) needs this key, and the merge
 * registry is on the require graph of safe-form allowlisted audits
 * (audit-reconcile-coverage.js, audit-push-retry-budgets.js) that must not
 * reach an fs writer — owe-venue-staging.js writes the staging file, so it
 * cannot be the module the merger imports. owe-venue-staging.js re-exports
 * this function unchanged.
 */
'use strict';

const crypto = require('crypto');

function candidateHash({ title, venue }) {
  const norm = `${(title || '').toLowerCase().trim()}|${(venue || '').toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

module.exports = { candidateHash };
