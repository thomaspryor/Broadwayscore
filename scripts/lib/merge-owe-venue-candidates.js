/**
 * Push-time merge for data/audit/owe-venue-candidates.json (the Off-West End
 * venue-page / audit-evidence staging file) — BRO-4268.
 *
 * Three writers touch this file from hour-long workflows: discover-new-shows.js
 * (writeStagingCandidates, inside Update Shows), the promoter's post-run prune
 * (promote-owe-venue-candidates.js), and hand `--stage-only` merges landing
 * through land.yml. On 2026-09-29 the Update Shows run read the file at 02:47,
 * batch 4 landed 53 evidence-backed rows at 03:25, and the run's push at 03:49
 * wrote its stale copy back over them — a plain lost update, because the push
 * path had no merge fn for this file and fell back to ours-wins.
 *
 * Same rules as merge-ob-venue-candidates.js (one factory, two keyed
 * instances): union by key, ours wins on a shared key, remote-only rows
 * re-added, keyless rows pass through from both sides. The only difference is
 * the key: a hand-staged row may arrive without candidateHash, so the key is
 * derived from title+venue exactly as owe-venue-staging.js's candidateHash()
 * (owe-candidate-hash.js, write-free) would stamp it — a hand row and discovery's row for the same show dedupe.
 *
 * Removals (BRO-4484): given the common-ancestor `base` (every push-path
 * caller supplies one to a three-argument merger), a row the promoter pruned
 * stays pruned even when main moved mid-run, and a row another writer pruned
 * is not re-added by a stale copy, as long as the side that kept it never
 * edited it. Without a base it is the original pure union (a pruned row
 * reappears for one cycle). Before this, a mid-run move of main unioned the
 * prune away and push-content-survival.js rejected every push attempt as
 * REVERTED (2026-09-29/30 scheduled runs). Rules live in the factory.
 */
'use strict';

const { candidateHash } = require('./owe-candidate-hash');
const { makeVenueCandidatesMerge } = require('./merge-ob-venue-candidates');

function keyOf(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.candidateHash === 'string' && c.candidateHash) return c.candidateHash;
  if (c.title && c.venue) return candidateHash(c);
  return null;
}

const mergeOweVenueCandidates = makeVenueCandidatesMerge(keyOf);

module.exports = { mergeOweVenueCandidates, keyOf };
