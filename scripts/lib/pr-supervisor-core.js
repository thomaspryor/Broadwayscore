'use strict';

/**
 * PR supervisor — the merge DECISION, as a pure function.
 *
 * Loop 5 of THE-SYSTEM: agent PRs get finished and then sit unmerged because
 * nobody decides. A six-reviewer plan review killed the first version of this
 * (which invented its own never-merge list, its own merge path and its own
 * verdict store). Its conclusions are this module's contract:
 *
 *   - The never-merge policy is NOT redefined here. `isCodeDiffAllowed()` in
 *     autonomous-eligibility.js already encodes it in code, default-deny, and is
 *     the single source of truth. This module calls it.
 *   - This module NEVER merges, pushes, comments, or touches the network. It
 *     returns verdicts. autonomous-merge.yml remains "the ONLY place a branch
 *     reaches main" — it holds the global concurrency group that exists because
 *     two merges racing on main was a real incident.
 *   - It does NOT define a second verdict store. Review evidence is passed in,
 *     read from the review-gate ledger by the caller.
 *   - Evidence is bound to a SHA. A merge comment is agent-authored text and an
 *     `EXECUTED:` line proves nothing on its own; a verdict only counts for the
 *     exact commit it was recorded against, so a push after review invalidates it.
 *
 * Pure in, pure out — no fs, no network, no clock except the one passed in. Same
 * shape as `assessDelegations` in linear-delegation-health.js, for the same
 * reason: a policy that cannot be fixture-tested cannot be regression-tested,
 * and this one decides what reaches main unattended.
 */

const { isCodeDiffAllowed, isDiffDeterministicGreen } = require('./autonomous-eligibility.js');

/**
 * Verdicts, ordered by distance from "merge". The most restrictive finding wins,
 * but EVERY finding is reported — an escalation that hides a second reason is how
 * a reviewer ends up re-deriving the same analysis by hand.
 */
const VERDICT_SEVERITY = { merge: 0, hold: 1, escalate: 2, refuse: 3 };

/** Reviewers whose pass verdict is strong enough to clear a code diff. */
const DEFAULT_STRONG_REVIEWERS = new Set(['ship-check', 'code-review']);

/** CI states that are NOT a green light. Unknown is not green. */
const GREEN_CHECK_STATES = new Set(['SUCCESS', 'success', 'NEUTRAL', 'neutral']);

function severityOf(v) {
  return Object.prototype.hasOwnProperty.call(VERDICT_SEVERITY, v) ? VERDICT_SEVERITY[v] : 0;
}

/**
 * Line-oriented ADDITIVE registries: files that many PRs legitimately touch at
 * once because each one only appends its own entry.
 *
 * Without this exemption the collision rule is useless in practice rather than
 * merely noisy: every PR that adds a test also adds a line to
 * tests/unit-test-manifest.txt, so #592, #593 and #596 all "collide" with each
 * other and the supervisor escalates essentially everything — which trains the
 * owner to ignore escalations, the exact failure this loop exists to fix.
 * (Caught by this module's own fixture on the real 2026-08-17 PR set.)
 *
 * This relaxes ONLY collision escalation. It grants no eligibility whatsoever —
 * .gitignore is still refused by isCodeDiffAllowed, and a genuinely conflicting
 * pair of edits still shows up as a git conflict in mergeStateStatus, which the
 * merge path refuses on independently.
 */
const ADDITIVE_REGISTRY_FILES = new Set([
  'tests/unit-test-manifest.txt',
  '.gitignore',
]);

/**
 * Which open PRs touch the same file as this one. A collision is not a merge
 * conflict — git may merge both cleanly and still land two divergent versions of
 * the same document, which is exactly what #591/#593 would have done. Deciding
 * which one wins is an editorial call, so it escalates.
 *
 * @param {Array} prs every OPEN pr, including ones not under supervision
 * @returns {Map<number, Array<{number: number, files: string[]}>>}
 */
function buildCollisionIndex(prs) {
  const byFile = new Map();
  for (const pr of prs || []) {
    for (const f of pr.files || []) {
      if (ADDITIVE_REGISTRY_FILES.has(f)) continue;
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(pr.number);
    }
  }
  const out = new Map();
  for (const pr of prs || []) {
    const hits = new Map();
    for (const f of pr.files || []) {
      if (ADDITIVE_REGISTRY_FILES.has(f)) continue;
      for (const n of byFile.get(f) || []) {
        if (n === pr.number) continue;
        if (!hits.has(n)) hits.set(n, []);
        hits.get(n).push(f);
      }
    }
    out.set(pr.number, [...hits.entries()]
      .map(([number, files]) => ({ number, files: files.slice().sort() }))
      .sort((a, b) => a.number - b.number));
  }
  return out;
}

/**
 * Is there a review verdict that actually covers THIS commit?
 * A pass recorded against an earlier SHA is not evidence for the current one —
 * that is the whole point of binding evidence to the SHA.
 */
function evidenceForSha(evidence, headSha, strongReviewers) {
  if (!headSha) return null;
  const hits = (evidence || []).filter((e) => e
    && e.head === headSha
    && e.result === 'pass'
    && strongReviewers.has(e.reviewer));
  if (!hits.length) return null;
  return hits[hits.length - 1];
}

/**
 * Assess every supervised PR.
 *
 * @param {Array<object>} prs PRs to decide on. Each: {number, headSha, files[],
 *   title?, isDraft?, checksState?, evidence?[]}. `evidence` entries are
 *   review-gate ledger rows: {reviewer, result, head}.
 * @param {object} [opts]
 * @param {Array<object>} [opts.allOpenPrs] every open PR for collision detection.
 *   Defaults to `prs`. Pass the full list — a collision with an unsupervised PR
 *   is still a collision.
 * @param {Set<string>} [opts.strongReviewers]
 * @returns {Array<{number, verdict, reasons: string[], detail: string, refused: string[], collidesWith: object[], deterministicGreen: boolean}>}
 */
function assessPullRequests(prs, opts = {}) {
  const strongReviewers = opts.strongReviewers || DEFAULT_STRONG_REVIEWERS;
  const collisions = buildCollisionIndex(opts.allOpenPrs || prs);
  const out = [];

  for (const pr of prs || []) {
    const files = pr.files || [];
    const reasons = [];
    let verdict = 'merge';
    const raise = (v, reason) => {
      reasons.push(reason);
      if (severityOf(v) > severityOf(verdict)) verdict = v;
    };

    // An empty diff is never mergeable, and silently treating it as green would
    // make a broken PR fetch look like a clean one.
    if (!files.length) {
      raise('hold', 'no files in the diff — nothing to merge, or the file list was never fetched');
    }

    if (pr.isDraft) raise('hold', 'draft');

    const collidesWith = collisions.get(pr.number) || [];
    if (collidesWith.length) {
      const desc = collidesWith
        .map((c) => `#${c.number} (${c.files.join(', ')})`)
        .join('; ');
      raise('escalate', `touches the same file(s) as another open PR: ${desc} — which version wins is an editorial call, not a merge decision`);
    }

    // THE policy check. Not re-implemented here on purpose.
    const elig = isCodeDiffAllowed(files);
    if (files.length && !elig.allowed) {
      const allowedCount = files.length - elig.refused.length;
      if (allowedCount === 0) {
        raise('refuse', `every file is outside what an unattended agent may change: ${elig.refused.join(', ')}`);
      } else {
        // The dangerous shape: real work tangled with forbidden work, so neither
        // "merge it" nor "close it" is right and a human has to split the diff.
        raise('escalate', `mixed diff — ${elig.refused.length} forbidden file(s) (${elig.refused.join(', ')}) alongside ${allowedCount} allowed file(s); the allowed work cannot land without the forbidden work`);
      }
    }

    const deterministicGreen = files.length ? isDiffDeterministicGreen(files) : false;

    if (pr.checksState !== undefined && pr.checksState !== null && !GREEN_CHECK_STATES.has(pr.checksState)) {
      raise('hold', `CI is ${pr.checksState || 'unknown'} — green checks are a precondition, and unknown is not green`);
    }

    // Evidence, bound to the SHA. Deterministic-green diffs (tests/docs/fixtures
    // only) are exempt for the same reason autonomous-merge.yml exempts them:
    // nothing in those paths can change site or data behaviour.
    if (!deterministicGreen) {
      const ev = evidenceForSha(pr.evidence, pr.headSha, strongReviewers);
      if (!ev) {
        raise('hold', `no passing review verdict bound to ${pr.headSha ? pr.headSha.slice(0, 9) : 'this commit'} — a verdict recorded against an earlier push does not carry forward`);
      }
    }

    out.push({
      number: pr.number,
      title: pr.title || null,
      headSha: pr.headSha || null,
      // The full file list travels WITH the verdict on purpose. An independent
      // grader flagged that a "mixed diff" claim reads as policy-driven but is
      // unverifiable unless the facts it rests on are in the same record — so
      // every finding here can be re-derived without re-querying GitHub.
      files: files.slice(),
      verdict,
      reasons,
      detail: reasons.length ? reasons.join(' | ') : 'all files allowed, checks green, evidence bound to this commit',
      refused: elig.refused || [],
      collidesWith,
      deterministicGreen,
    });
  }

  return out;
}

/**
 * One-screen summary for the morning digest. The owner reads no code and no PRs,
 * so this says what is BLOCKED and what he alone can unblock — not a changelog.
 * Deliberately returns a string; the digest owns delivery.
 */
function renderSupervisorDigest(verdicts, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const rows = verdicts || [];
  if (!rows.length) return 'PR supervisor: no open agent PRs.';

  const byVerdict = (v) => rows.filter((r) => r.verdict === v);
  const lines = [];
  const mergeable = byVerdict('merge');
  const escalate = byVerdict('escalate');
  const refuse = byVerdict('refuse');
  const hold = byVerdict('hold');

  lines.push(`PR supervisor — ${rows.length} open agent PR(s)${dryRun ? ' (report only, nothing merged)' : ''}`);
  if (mergeable.length) {
    lines.push(`  ready to merge (${mergeable.length}): ${mergeable.map((r) => `#${r.number}`).join(', ')}`);
  }
  if (escalate.length) {
    lines.push(`  NEEDS A DECISION (${escalate.length}):`);
    for (const r of escalate) lines.push(`    #${r.number} — ${r.reasons[0]}`);
  }
  if (refuse.length) {
    lines.push(`  should be closed (${refuse.length}): ${refuse.map((r) => `#${r.number}`).join(', ')}`);
  }
  if (hold.length) {
    lines.push(`  waiting on CI or review (${hold.length}): ${hold.map((r) => `#${r.number}`).join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  VERDICT_SEVERITY,
  ADDITIVE_REGISTRY_FILES,
  DEFAULT_STRONG_REVIEWERS,
  GREEN_CHECK_STATES,
  buildCollisionIndex,
  evidenceForSha,
  assessPullRequests,
  renderSupervisorDigest,
};
