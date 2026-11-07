#!/usr/bin/env node
'use strict';
/**
 * Field-wise three-way merge for review-text JSON files (BRO-5211).
 *
 * Incident (broadway-review-texts b04b66762, 2026-10-12): a collector commit
 * (eaaae9beb) gave amelie/vulture--jesse-green.json its text plus publishDate,
 * fetchMethod, archivePath, textQuality, contentTier "complete" and
 * needsRefetch=false. A Rebuild Reviews (Fast) job that checked out before
 * that push had written its own stale classification of the old, text-less
 * file (contentTier "stub", incompleteReason "url_dead", wordCount 0). In
 * .github/actions/push-review-texts the pre-stage `git pull --rebase
 * --autostash` conflicted on the stash pop and the resolver took the stash's
 * WHOLE file (`git checkout --theirs -- .`). The protected-field restore only
 * re-adds fields the local copy is missing, so fullText came back but
 * publishDate, fetchMethod, archivePath, textQuality and needsRefetch=false
 * were lost and the stub classification stuck.
 *
 * Rule: merge per top-level field against the common base.
 *   - A field only one side changed takes that side's value (or absence).
 *   - The text-state fields (TEXT_STATE_GROUP) describe ONE fetch of the
 *     article; when both sides changed that group, the whole group comes from
 *     the side with the newer text fetch (textFetchedAt, when both sides have a
 *     text and a stamp), else the longer fullText, so a stale "stub, url_dead" never
 *     sits next to a fresh full text.
 *   - Any other field both sides changed differently goes to the same winner.
 * Scoring recency (scoring-recency.js) and the protected-field restore still
 * run after this in the action.
 *
 * CLI (inside the data repo, mid-conflict): for every unmerged *.json path
 * with stage 2 (upstream, HEAD) and stage 3 (this workflow: the stash in an
 * autostash pop, the replayed commit in a rebase), write the merge and
 * `git add` it. Paths it cannot merge (delete/modify, invalid JSON,
 * failed-fetches.json) are left unmerged for the caller's fallback.
 *   node review-json-three-way-merge.js --tie=workflow|upstream
 * Prints each merged path on stdout, one per line.
 */

const TEXT_STATE_GROUP = [
  'fullText', 'contentTier', 'contentTierReason', 'tierReason',
  'incompleteReason', 'incompleteDetail', 'wordCount', 'textWordCount',
  'textStatus', 'textQuality', 'isFullReview', 'truncationSignals', 'textIssues',
  'needsRefetch', 'fetchMethod', 'fetchTier', 'fetchAttempts', 'archivePath',
  'archiveOrgUrl', 'archiveOrgTimestamp', 'sourceMethod', 'textFetchedAt',
  'contentVerification',
];
const GROUP_SET = new Set(TEXT_STATE_GROUP);

const _same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const _textLen = (d) => (typeof d.fullText === 'string' ? d.fullText.length : 0);
const _fetchedMs = (d) => {
  const t = typeof d.textFetchedAt === 'string' ? Date.parse(d.textFetchedAt) : NaN;
  return Number.isFinite(t) ? t : null;
};

const TIER_RANK = { complete: 4, truncated: 3, excerpt: 2, stub: 1, invalid: 0 };

// BRO-5656: a newer, shorter refetch is the corrected article; length alone
// would revert it to the older, longer (wrong) body. Recency decides only when
// both sides hold a text and carry distinct parseable textFetchedAt stamps, and
// the newer side's contentTier is not known to be worse than the older side's
// (a newer paywall teaser must not displace an older complete text). Returns
// 'a', 'b', or null (caller falls back to length). Shared with
// restore-protected-fields' stale-checkout guard so both steps agree.
function fresherTextWins(a, b) {
  if (!_isObj(a) || !_isObj(b) || _textLen(a) === 0 || _textLen(b) === 0) return null;
  const aAt = _fetchedMs(a);
  const bAt = _fetchedMs(b);
  if (aAt === null || bAt === null || aAt === bAt) return null;
  const [newer, older, id] = aAt > bAt ? [a, b, 'a'] : [b, a, 'b'];
  const nr = TIER_RANK[newer.contentTier];
  const or = TIER_RANK[older.contentTier];
  if (nr !== undefined && or !== undefined && nr < or) return null;
  return id;
}

function _pickWinner(upstream, workflow, tie) {
  const fresher = fresherTextWins(workflow, upstream);
  if (fresher) return fresher === 'a' ? 'workflow' : 'upstream';
  const uLen = _textLen(upstream);
  const wLen = _textLen(workflow);
  return wLen > uLen ? 'workflow' : uLen > wLen ? 'upstream' : tie;
}

/**
 * @param {object|null} base     common ancestor (null/undefined: added on both sides)
 * @param {object} upstream      the remote version (HEAD after the pull)
 * @param {object} workflow      this workflow's version
 * @param {{tie?: 'workflow'|'upstream'}} [opts] who wins when fullText lengths tie
 * @returns {{merged: object, winner: 'workflow'|'upstream', conflicts: string[], groupFrom: string|null}}
 */
function mergeReviewJson(base, upstream, workflow, opts = {}) {
  if (!_isObj(upstream) || !_isObj(workflow)) throw new TypeError('upstream and workflow must be objects');
  const b = _isObj(base) ? base : {};
  const tie = opts.tie === 'upstream' ? 'upstream' : 'workflow';
  const winner = _pickWinner(upstream, workflow, tie);
  const pick = (k) => (winner === 'workflow' ? workflow[k] : upstream[k]);

  const keys = [...new Set([...Object.keys(upstream), ...Object.keys(workflow), ...Object.keys(b)])];
  const changed = (side, k) => !_same(side[k], b[k]);
  const groupBothChanged = TEXT_STATE_GROUP.some((k) => changed(upstream, k))
    && TEXT_STATE_GROUP.some((k) => changed(workflow, k));

  const out = {};
  const conflicts = [];
  for (const k of keys) {
    let v;
    if (GROUP_SET.has(k) && groupBothChanged) {
      v = pick(k);
      if (changed(upstream, k) && changed(workflow, k) && !_same(upstream[k], workflow[k])) conflicts.push(k);
    } else if (!changed(workflow, k)) {
      v = upstream[k];
    } else if (!changed(upstream, k) || _same(upstream[k], workflow[k])) {
      v = workflow[k];
    } else {
      v = pick(k);
      conflicts.push(k);
    }
    if (v !== undefined) out[k] = v;
  }
  return { merged: JSON.parse(JSON.stringify(out)), winner, conflicts, groupFrom: groupBothChanged ? winner : null };
}

function _cli() {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const tieArg = process.argv.find((a) => a.startsWith('--tie='));
  const tie = tieArg && tieArg.split('=')[1] === 'upstream' ? 'upstream' : 'workflow';
  const git = (args, input) => execFileSync('git', args, {
    encoding: 'utf8', input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'ignore'], maxBuffer: 1 << 28,
  });

  // `git ls-files -u -z`: "<mode> <sha> <stage>\t<path>\0"
  const stages = new Map();
  for (const rec of git(['ls-files', '-u', '-z']).split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [, , stage] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (!stages.has(p)) stages.set(p, new Set());
    stages.get(p).add(stage);
  }
  const show = (stage, p) => JSON.parse(git(['show', `:${stage}:${p}`]));
  for (const [p, have] of stages) {
    if (!p.endsWith('.json') || p.includes('failed-fetches')) continue;
    if (!have.has('2') || !have.has('3')) continue; // delete/modify: caller decides
    try {
      const base = have.has('1') ? show(1, p) : null;
      const { merged, winner, conflicts, groupFrom } = mergeReviewJson(base, show(2, p), show(3, p), { tie });
      fs.writeFileSync(p, JSON.stringify(merged, null, 2) + '\n');
      git(['add', '--', p]);
      process.stderr.write(`  three-way merged ${p} (conflicts -> ${winner}: ${conflicts.join(', ') || 'none'}`
        + `${groupFrom ? `; text state from ${groupFrom}` : ''})\n`);
      process.stdout.write(p + '\n');
    } catch (e) {
      process.stderr.write(`  three-way merge skipped ${p}: ${e.message}\n`);
    }
  }
}

if (require.main === module) {
  try { _cli(); } catch (e) { process.stderr.write(`review-json-three-way-merge: ${e.message}\n`); }
}

module.exports = { mergeReviewJson, TEXT_STATE_GROUP, fresherTextWins };
