/**
 * Push-time merge for data/audit/owe-venue-candidates.json (the Off-West End
 * venue-page / audit-evidence staging file) — BRO-4268.
 *
 * Three writers touch this file from hour-long workflows: discover-new-shows.js
 * (writeStagingCandidates, inside Update Shows), the promoter's post-run prune
 * (promote-owe-venue-candidates.js), and hand `--stage-only` merges. On
 * 2026-09-29 the Update Shows run read the file at 02:47, batch 4 landed 53
 * evidence-backed rows at 03:25, and the run's push at 03:49 wrote its stale
 * copy back over them — a plain lost update, because the push path had no
 * merge fn for this file and fell back to ours-wins.
 *
 * Union by candidateHash: every row on either side survives; on a shared key
 * ours (the pusher's copy) wins, remote-only rows are re-added. A row the
 * promoter pruned that remote still carries comes back — deliberately: the
 * prune is idempotent (a re-staged duplicate is pruned again next run, a
 * promoted row is skip-duplicate against shows.json), while a lost row is
 * gone until someone notices. Same shape as merge-diary-shows.js.
 */
'use strict';

const { candidateHash } = require('./owe-venue-staging');

function keyOf(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.candidateHash === 'string' && c.candidateHash) return c.candidateHash;
  if (c.title && c.venue) return candidateHash(c);
  return null;
}

function asArray(v) {
  return Array.isArray(v) ? v.filter((c) => c && typeof c === 'object') : [];
}

/**
 * @param {unknown} ours   the pusher's copy (array of candidates)
 * @param {unknown} remote origin/main's copy
 * @returns {{ merged: object[], stats: { ours: number, remote: number, added: number, kept: number, unkeyed: number } }}
 */
function mergeOweVenueCandidates(ours, remote) {
  const oursRows = asArray(ours);
  const remoteRows = asArray(remote);
  const seen = new Set();
  let unkeyed = 0;
  for (const c of oursRows) {
    const k = keyOf(c);
    if (k) seen.add(k); else unkeyed++;
  }
  const merged = [...oursRows];
  let added = 0;
  let kept = 0;
  for (const c of remoteRows) {
    const k = keyOf(c);
    if (k && seen.has(k)) { kept++; continue; } // shared key: ours wins
    if (!k) { unkeyed++; continue; }            // no title+venue: nothing to key on, drop
    merged.push(c);
    seen.add(k);
    added++;
  }
  return { merged, stats: { ours: oursRows.length, remote: remoteRows.length, added, kept, unkeyed } };
}

module.exports = { mergeOweVenueCandidates, keyOf };
