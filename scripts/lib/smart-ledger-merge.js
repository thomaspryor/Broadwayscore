'use strict';

/**
 * smart-ledger-merge.js (BRO-2498): lets sync-audit-checkout.sh's union-recovery
 * stage use the per-file merge functions registered in
 * core-data-merge-registry.js instead of the dumb line union
 * (unionLedgerLines), so a same-date-replace ledger such as
 * census-recall-trend.jsonl does not end up with two rows for one date.
 *
 * Argument order matches push-with-retry's reconcile: merge(ours, remote).
 * "ours" is the locally saved copy, "remote" is origin's version, so a tie
 * keeps the local row, exactly like the CI pass.
 */

const { findEntry } = require('./core-data-merge-registry');

/** The registered jsonl merge entry for a repo-relative path, or null. */
function smartMergeEntryFor(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.endsWith('.jsonl')) return null;
  const e = findEntry(repoPath, 'public-repo');
  return e && e.status === 'active' && e.format === 'jsonl' && typeof e.merge === 'function' ? e : null;
}

/**
 * Ledgers whose registered merge function does something git's line-union
 * driver cannot (same-date-replace), so a git merge/rebase of two sides that
 * both touched them leaves duplicate keys. They are declared merge=union so
 * the ff-only recovery can reach them, but must never be resolved by a git
 * merge or rebase: those paths refuse instead (classifyBlock, merge-origin).
 */
const GIT_MERGE_UNSAFE_LEDGERS = [
  'data/audit/census-recall-trend.jsonl',
  'data/audit/coverage-adversarial-probe-trend.jsonl',
];
const gitMergeUnsafe = (repoPath) => GIT_MERGE_UNSAFE_LEDGERS.includes(repoPath);

const parseLines = (lines) => lines.filter((l) => l !== '').map((l) => JSON.parse(l));

/**
 * @param {string} repoPath  e.g. data/audit/census-recall-trend.jsonl
 * @param {string[]} baseLines  origin's lines (the post-fast-forward file)
 * @param {string[]} extraLines the locally saved lines
 * @returns {{merged: string[], stats: {base: number, added: number, total: number}} | null}
 *   null when no smart merge is registered; throws on an unparseable row
 */
function smartMergeLines(repoPath, baseLines, extraLines) {
  const entry = smartMergeEntryFor(repoPath);
  if (!entry) return null;
  const remote = parseLines(baseLines);
  const ours = parseLines(extraLines);
  const { merged } = entry.merge(ours, remote);
  const out = merged.map((e) => JSON.stringify(e));
  return { merged: out, stats: { base: remote.length, added: Math.max(0, out.length - remote.length), total: out.length } };
}

module.exports = { smartMergeEntryFor, smartMergeLines, GIT_MERGE_UNSAFE_LEDGERS, gitMergeUnsafe };
