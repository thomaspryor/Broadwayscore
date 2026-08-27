'use strict';
/**
 * scripts/lib/sync-audit-decision.js — the decision layer for
 * scripts/lib/sync-audit-checkout.sh (BRO-2314).
 *
 * WHY THIS EXISTS. The shared sync gate refused to run for six straight days
 * (2026-08-20 → 2026-08-26) and parked com.broadwayscore.predispatch-queue-audit
 * with it. Two separate defects, both of which live in a decision the shell was
 * making inline and untested:
 *
 *  1. WRONG BLOCKER SET. `git merge --ff-only` only refuses over a dirty path
 *     that the merge would actually have to write. The old classifier looked at
 *     EVERY dirty path in the tree, so an unrelated untracked job output
 *     (data/newsletter-drafts/sunday-review-*.log) — a path origin/main never
 *     touches, and therefore cannot block a fast-forward — was reported as the
 *     reason. Anyone reading the refusal snapshot chased the wrong file.
 *     ffBlockingPaths() intersects dirt with what origin actually moves.
 *
 *  2. NO RECOVERY FOR merge=union LEDGERS. The old script reset dirty
 *     regenerable data/audit/ snapshots but deliberately excluded *.jsonl,
 *     because those are real append-only data. Correct, but terminal:
 *     data/audit/stage-latency.jsonl and data/audit/scraper-spend-ledger.jsonl
 *     are appended by local jobs continuously AND moved by CI on origin/main
 *     many times a day, so the overlap is permanent and ff-only stayed blocked
 *     forever. This repo already declares the resolution for exactly those two
 *     files — `.gitattributes:19,41` mark them `merge=union`, with a header
 *     comment stating union is the lossless, sanctioned way to reconcile these
 *     bot-written append logs. classifyBlock() routes that case to a recovery
 *     stage instead of a refusal, and unionLedgerLines() is the line-level
 *     union the attribute describes.
 *
 * MEMBERSHIP IS NOT A HARDCODED LIST. The caller decides "is this path safe to
 * concatenate?" with `git check-attr merge -- <path>`, so .gitattributes stays
 * the single source of truth. A filename list here would drift from it — the
 * exact failure mode core-data-merge-registry.js:1-17 was created to end.
 *
 * Pure functions only — no fs, no git, no process. All git/IO lives in
 * sync-audit-checkout.sh. Tested by scripts/lib/sync-audit-checkout.test.mjs,
 * which require()s these functions rather than restating them (CLAUDE.md r15).
 */

// Reason vocabulary. Unchanged from the shell's original strings because
// scripts/lib/digest-snapshots.js:326 renders `reason` verbatim into the
// morning digest and tests/unit/digest-sync-refused-reporting.test.mjs pins
// that rendering — a new-for-the-sake-of-it string would silently change
// owner-facing copy. 'dirty-union-ledger' is the one addition, and it is a
// RECOVERY label, never written to a refusal snapshot.
const REASON_DIVERGED = 'diverged';
const REASON_OUTSIDE_AUDIT = 'dirty-outside-audit';
const REASON_JSONL_LEDGER = 'dirty-jsonl-ledger';
const REASON_UNRESOLVED = 'dirty-unresolved';
const REASON_UNION_LEDGER = 'dirty-union-ledger';

const ACTION_REFUSE = 'refuse';
const ACTION_UNION_RECOVER = 'union-recover';

function toList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
}

/**
 * The dirty paths that can actually block `git merge --ff-only origin/main`.
 *
 * A fast-forward rewrites only the paths that differ between HEAD and
 * origin/main; a dirty path outside that set is simply carried across
 * untouched (verified empirically, and it is why the checkout survives a
 * dirty ledger on days CI happens not to move it).
 *
 * `originChangedPaths` must come from `git diff --name-only HEAD origin/main`,
 * which DOES list a path origin adds even when the local copy of it is
 * untracked — that case (untracked file origin is about to create) blocks
 * ff-only too, and dropping it here would reintroduce the "misreported as
 * diverged" bug that scripts/lib/sync-audit-checkout.test.sh case 7 guards.
 * `dirtyPaths` must therefore come from `git status --porcelain -uall`, not
 * from `git diff`, so untracked paths are present on both sides.
 */
function ffBlockingPaths({ dirtyPaths = [], originChangedPaths = [] } = {}) {
  const changed = new Set(toList(originChangedPaths));
  const seen = new Set();
  const out = [];
  for (const p of toList(dirtyPaths)) {
    if (!changed.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * What should the sync gate do about a still-blocked fast-forward?
 *
 * @param {string[]} blockingPaths   output of ffBlockingPaths()
 * @param {number}   aheadCount      `git rev-list --count origin/main..HEAD`
 * @param {string[]} unionMergePaths blocking paths that are BOTH tracked and
 *                                   declared `merge=union` in .gitattributes.
 *                                   Untracked paths must never appear here:
 *                                   `git checkout HEAD -- <p>` cannot restore
 *                                   a path HEAD does not contain, so the
 *                                   recovery stage has nothing to roll back to.
 * @returns {{action: string, reason: string, blockingPaths: string[], unionPaths: string[]}}
 */
function classifyBlock({ blockingPaths = [], aheadCount = 0, unionMergePaths = [] } = {}) {
  const blocking = toList(blockingPaths);
  const unionSet = new Set(toList(unionMergePaths).filter((p) => blocking.includes(p)));
  const unionPaths = blocking.filter((p) => unionSet.has(p));
  const base = { blockingPaths: blocking, unionPaths };

  // A local commit origin does not have is not a dirty-file problem and no
  // reset or union can fix it. Checked FIRST so a diverged checkout that also
  // happens to have a dirty ledger is never handed to the recovery stage,
  // where `git merge --ff-only` would fail anyway and the ledger would be
  // truncated for nothing.
  if (Number(aheadCount) > 0) return { ...base, action: ACTION_REFUSE, reason: REASON_DIVERGED };

  // Nothing dirty that origin also moves, yet ff-only still failed: there is
  // no file to blame, so this is real divergence (or a fetch/ref problem).
  if (!blocking.length) return { ...base, action: ACTION_REFUSE, reason: REASON_DIVERGED };

  if (unionPaths.length === blocking.length) {
    return { ...base, action: ACTION_UNION_RECOVER, reason: REASON_UNION_LEDGER };
  }

  // Refusal reasons are derived from the BLOCKING paths only — that is fix #1.
  // Order matches the original shell classifier so the digest copy is stable.
  const unrecoverable = blocking.filter((p) => !unionSet.has(p));
  if (unrecoverable.some((p) => !p.startsWith('data/audit/'))) {
    return { ...base, action: ACTION_REFUSE, reason: REASON_OUTSIDE_AUDIT };
  }
  if (unrecoverable.some((p) => p.endsWith('.jsonl'))) {
    return { ...base, action: ACTION_REFUSE, reason: REASON_JSONL_LEDGER };
  }
  return { ...base, action: ACTION_REFUSE, reason: REASON_UNRESOLVED };
}

/**
 * Line-level union of an append-only ledger — the `merge=union` attribute's
 * semantics, applied by hand because a fast-forward never invokes a merge
 * driver (it rewrites the path wholesale, which is why a dirty ledger blocks
 * it in the first place).
 *
 * baseLines MUST be the post-merge (origin) content and extraLines the saved
 * local copy, NOT the other way round. Both ledgers rotate by dropping from
 * the FRONT and keeping the newest tail — provider-telemetry.js:69
 * (`lines.slice(lines.length - MAX_LEDGER_LINES)`) and stage-latency.js's
 * rotateIfNeeded() — so the locally-appended rows have to land at the END or
 * the very next append would trim away exactly the rows we just rescued.
 * This is deliberately the OPPOSITE order from merge-scraper-spend-ledger.js's
 * ours-first rule, which merges committed snapshots where no trim follows.
 *
 * The key is the whole line, matching merge-scraper-spend-ledger.js:23-28
 * ("the natural key is the FULL serialized record"): two rows collapse only
 * when every byte matches, which is the read-the-same-write-twice case, and
 * two genuinely different calls survive because some field always differs.
 * Done at line level rather than by reusing mergeScraperSpendLedger() so a
 * 153k-line ledger is never parsed and re-serialised — that would rewrite the
 * formatting of every untouched row into one enormous diff.
 *
 * The result is a strict SUPERSET of baseLines, so whoever commits the ledger
 * next adds rows and deletes none.
 */
function unionLedgerLines(baseLines, extraLines) {
  const base = Array.isArray(baseLines) ? baseLines : [];
  const extra = Array.isArray(extraLines) ? extraLines : [];
  const merged = base.slice();
  const seen = new Set(base);
  let added = 0;
  for (const line of extra) {
    if (line === '' || seen.has(line)) continue;
    seen.add(line);
    merged.push(line);
    added += 1;
  }
  return { merged, stats: { base: base.length, added, total: merged.length } };
}

/**
 * Drop a torn trailing line from a saved ledger copy.
 *
 * The local copy is taken with `cp` while other processes may be mid-append
 * (stage-latency.js appends with a raw appendFileSync and takes no lock), so
 * the last line can be a half-written record. Persisting that through the
 * union would commit a corrupt row into a file that reconcile-merged-json.js's
 * parseJsonlLines() refuses to reconcile at all.
 *
 * Deliberately narrow: only the LAST non-empty line, only when it fails to
 * parse as JSON, and only when at least one earlier line does parse — so a
 * ledger that is legitimately not JSON-per-line is passed through untouched
 * rather than silently emptied.
 */
function stripTornTrailingLine(lines) {
  const arr = Array.isArray(lines) ? lines.slice() : [];
  let last = arr.length - 1;
  while (last >= 0 && arr[last] === '') last -= 1;
  if (last < 1) return { lines: arr, dropped: null };
  if (parsesAsJson(arr[last])) return { lines: arr, dropped: null };
  const anyEarlierParses = arr.slice(0, last).some((l) => l !== '' && parsesAsJson(l));
  if (!anyEarlierParses) return { lines: arr, dropped: null };
  const dropped = arr[last];
  arr.splice(last, 1);
  return { lines: arr, dropped };
}

function parsesAsJson(line) {
  try { JSON.parse(line); return true; } catch { return false; }
}

/**
 * Post-union safety assertion. The union must never shrink either side; if it
 * somehow does, the caller restores its verbatim backup and refuses rather
 * than writing a file with fewer rows than it started with.
 */
function unionIsSafe({ mergedCount = 0, baseCount = 0, extraCount = 0 } = {}) {
  return Number(mergedCount) >= Math.max(Number(baseCount), Number(extraCount));
}

module.exports = {
  ffBlockingPaths,
  classifyBlock,
  unionLedgerLines,
  stripTornTrailingLine,
  unionIsSafe,
  ACTION_REFUSE,
  ACTION_UNION_RECOVER,
  REASON_DIVERGED,
  REASON_OUTSIDE_AUDIT,
  REASON_JSONL_LEDGER,
  REASON_UNRESOLVED,
  REASON_UNION_LEDGER,
};
