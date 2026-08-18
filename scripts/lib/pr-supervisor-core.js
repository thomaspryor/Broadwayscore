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
 * KNOWN LIMIT OF THAT EVIDENCE, stated plainly rather than papered over:
 * the review-gate ledger is an append-only local file with no authentication.
 * Any process that can run `review-gate.mjs --query=record --reviewer=ship-check
 * --result=pass` at its own HEAD produces a record this module accepts as strong
 * evidence. SHA-binding stops STALE evidence, not FORGED evidence. Closing that
 * would mean a second, authenticated verdict store — precisely what the plan
 * review forbade — so the honest statement is: this raises the bar from "an agent
 * said it reviewed itself in prose" to "an agent recorded a verdict against this
 * exact commit", and no further. It is not a substitute for a human, and nothing
 * here should be described as human-reviewed.
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
 *
 * THE EXEMPTION IS CONDITIONAL ON THE EDIT ACTUALLY BEING ADDITIVE. An adversarial
 * review found the hole: the manifest is an explicit list of which tests CI runs,
 * so one PR DELETING a line while another adds one merges cleanly and silently
 * stops running a test — no conflict, no signal. Same shape for .gitignore, where
 * one PR can un-ignore content another assumes is still protected. So a file only
 * earns the exemption when the PR's edit to it has ZERO deletions; a deletion
 * makes it a normal collision and escalates.
 */
const ADDITIVE_REGISTRY_FILES = new Set([
  'tests/unit-test-manifest.txt',
  '.gitignore',
]);

/**
 * True when this PR's edit to `file` is purely additive (or we cannot prove it is,
 * in which case it is NOT exempt — absence of evidence is not additive).
 * @param {object} pr
 * @param {string} file
 */
function isAdditiveEdit(pr, file) {
  if (!ADDITIVE_REGISTRY_FILES.has(file)) return false;
  const stats = (pr && pr.fileStats) ? pr.fileStats[file] : null;
  // No per-file stats supplied → cannot prove additivity → treat as a collision.
  if (!stats || typeof stats.deletions !== 'number') return false;
  return stats.deletions === 0;
}

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
  // Index EVERY edit. The additive exemption is PAIRWISE — it applies only when
  // BOTH sides of a shared file are purely additive. Skipping additive edits at
  // index time instead would make them invisible, so a PR that DELETES a manifest
  // line would collide with nobody: the deletion that silently stops running a
  // test is exactly the case that must surface.
  const byFile = new Map();
  for (const pr of prs || []) {
    for (const f of pr.files || []) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push({ number: pr.number, additive: isAdditiveEdit(pr, f) });
    }
  }
  const out = new Map();
  for (const pr of prs || []) {
    const hits = new Map();
    for (const f of pr.files || []) {
      const mine = isAdditiveEdit(pr, f);
      for (const other of byFile.get(f) || []) {
        if (other.number === pr.number) continue;
        if (mine && other.additive) continue; // both append-only: a clean merge
        if (!hits.has(other.number)) hits.set(other.number, []);
        hits.get(other.number).push(f);
      }
    }
    out.set(pr.number, [...hits.entries()]
      .map(([number, files]) => ({ number, files: [...new Set(files)].sort() }))
      .sort((a, b) => a.number - b.number));
  }
  return out;
}

/**
 * Reduce GitHub's statusCheckRollup to ONE state: 'SUCCESS' | 'FAILURE' | 'PENDING'.
 *
 * Pure, and here rather than in the CLI so it is fixture-tested — a wrong reduction
 * here is a green light on a red PR. The rollup mixes two shapes: CheckRun entries
 * carry status/conclusion, StatusContext entries carry only `state`.
 *
 * Fails toward PENDING/FAILURE, never toward SUCCESS:
 *   - no checks at all is PENDING, not green (nothing has vouched for this commit)
 *   - anything still running is PENDING
 *   - an unrecognised conclusion is treated as a failure, not ignored
 * SKIPPED and NEUTRAL are green: they are how this repo's own Test Suite reports a
 * job that correctly did not need to run.
 */
const OK_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

function rollupCheckState(rollup) {
  const entries = Array.isArray(rollup) ? rollup : [];
  if (!entries.length) return 'PENDING';
  let pending = false;
  for (const e of entries) {
    if (!e || typeof e !== 'object') return 'FAILURE';
    if (e.__typename === 'StatusContext' || (e.state && !e.conclusion && !e.status)) {
      const s = String(e.state || '').toUpperCase();
      if (s === 'PENDING' || s === 'EXPECTED' || s === '') { pending = true; continue; }
      if (!OK_CONCLUSIONS.has(s)) return 'FAILURE';
      continue;
    }
    if (String(e.status || '').toUpperCase() !== 'COMPLETED') { pending = true; continue; }
    if (!OK_CONCLUSIONS.has(String(e.conclusion || '').toUpperCase())) return 'FAILURE';
  }
  return pending ? 'PENDING' : 'SUCCESS';
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
    const graded = [];
    let verdict = 'merge';
    // Each reason remembers the severity it raised. The digest shows only the
    // reasons that actually DROVE the verdict: printing reasons[0] surfaced
    // "draft" (a hold) as the thing needing an owner decision on an escalated
    // PR — a lesser reason wearing the headline. Caught by running the tool
    // against all 22 live PRs, 2026-08-17.
    const raise = (v, reason) => {
      reasons.push(reason);
      graded.push({ verdict: v, reason });
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

    // ABSENT is not green either. The first version only held when checksState was
    // PRESENT and non-green, so a caller that simply never fetched check state got
    // a `merge` verdict with CI entirely unexamined — the module asserting
    // "unknown is not green" while its own boundary treated unknown as green.
    // (Adversarial review, 2026-08-17.) There is no way to express "don't check CI":
    // supply a state or get a hold.
    if (!GREEN_CHECK_STATES.has(pr.checksState)) {
      const shown = pr.checksState === undefined || pr.checksState === null
        ? 'not supplied'
        : String(pr.checksState);
      raise('hold', `CI is ${shown} — green checks are a precondition, and neither unknown nor unfetched counts as green`);
    }

    // Evidence, bound to the SHA. Deterministic-green diffs (tests/docs/fixtures
    // only) are exempt for the same reason autonomous-merge.yml exempts them:
    // nothing in those paths can change site or data behaviour.
    // EXEMPT FROM EVIDENCE, NOT FROM CI — the check-state hold above still applies
    // to a deterministic-green PR. A docs-only change can still break the build
    // (a bad fence, a lint rule, a link checker), so green checks are required of
    // everything; only the human-review-shaped requirement is waived here.
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
      // Every reason recorded AT the final verdict's severity — i.e. any of the
      // findings that could have produced this verdict, not lower-severity noise.
      // (Not "the single cause": two mixed-diff/collision findings can both sit at
      // escalate, and either is a legitimate headline.) Guaranteed non-empty for
      // any non-merge verdict, since the verdict can only come from a raise().
      decidingReasons: graded.filter((g) => g.verdict === verdict).map((g) => g.reason),
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
    for (const r of escalate) {
      // decidingReasons is non-empty for every escalate (asserted in the tests);
      // the fallback only covers a verdict object built by an older caller.
      const headline = (r.decidingReasons && r.decidingReasons[0]) || r.reasons[0];
      lines.push(`    #${r.number} — ${headline}`);
    }
  }
  if (refuse.length) {
    lines.push(`  should be closed (${refuse.length}): ${refuse.map((r) => `#${r.number}`).join(', ')}`);
  }
  if (hold.length) {
    lines.push(`  waiting on CI or review (${hold.length}): ${hold.map((r) => `#${r.number}`).join(', ')}`);
  }
  return lines.join('\n');
}

/** At most this many PR numbers inline before the sentence is truncated. */
const MAX_LISTED_PRS = 6;

/** How long a published verdict stays trustworthy before the digest disowns it. */
const STATUS_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** A little future-dating is clock skew; a lot is a broken file. */
const STATUS_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * `#12, #13` — never `#undefined`, never an unbounded wall of numbers.
 *
 * Returns null (not '') when nothing is listable, so a caller can drop the
 * parenthetical entirely rather than emitting "waiting to be merged ()", which
 * an earlier version did whenever a row had an unusable id.
 */
function listPrs(rows) {
  const nums = (rows || []).map((v) => v && v.number).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  const shown = nums.slice(0, MAX_LISTED_PRS).map((n) => `#${n}`).join(', ');
  const extra = nums.length - Math.min(nums.length, MAX_LISTED_PRS);
  return extra > 0 ? `${shown} and ${extra} more` : shown;
}

/** "N thing(s) doing X (#1, #2)" — parenthetical omitted when no id is usable. */
function phrase(count, text, rows) {
  const ids = listPrs(rows);
  return ids ? `${count} ${text} (${ids})` : `${count} ${text}`;
}

/**
 * The verdict payload the morning digest reads, as a pure function of the
 * verdicts plus the clock.
 *
 * Lives here rather than in pr-supervisor.js for the same reason assessPullRequests
 * does: the OWNER-FACING SENTENCE is the deliverable of this loop, and a sentence
 * built inside an I/O script cannot be fixture-tested. The owner reads no PRs and
 * no code, so if this line is wrong or empty he simply never learns that finished
 * work is piling up — which is precisely the failure Loop 5 exists to close.
 *
 * @param {Array} verdicts output of assessPullRequests
 * @param {string} nowIso ISO timestamp, injected so the test is deterministic
 */
function buildStatusPayload(verdicts, nowIso, { scoped = false } = {}) {
  const rows = (verdicts || []).filter(Boolean);
  const readyToMerge = rows.filter((v) => v.verdict === 'merge');
  const needsDecision = rows.filter((v) => v.verdict === 'escalate');
  // A verdict this function does not recognise must be SURFACED, not filtered
  // away. Silently dropping it is how a newly added verdict becomes invisible to
  // the only human in the loop while still looking handled in the JSON.
  // (Adversarial review, 2026-08-17.)
  const unknown = rows.filter((v) => !Object.prototype.hasOwnProperty.call(VERDICT_SEVERITY, v.verdict));

  // EVERY non-merge verdict has to be able to reach the owner, not just escalate.
  // An adversarial review found a live day where 5 PRs were verdicted "should be
  // closed" and 3 were waiting on CI, and the alarm was silent — because only
  // merge and escalate were counted. A PR parked at `hold` forever is verbatim
  // the Loop 5 failure this whole thing exists to end.
  const shouldClose = rows.filter((v) => v.verdict === 'refuse');
  const waiting = rows.filter((v) => v.verdict === 'hold');

  const parts = [
    readyToMerge.length
      ? phrase(readyToMerge.length, `finished agent PR${readyToMerge.length === 1 ? ' is' : 's are'} green and waiting to be merged`, readyToMerge)
      : null,
    needsDecision.length
      ? phrase(needsDecision.length, `need${needsDecision.length === 1 ? 's' : ''} a decision nobody can make automatically`, needsDecision)
      : null,
    shouldClose.length
      ? phrase(shouldClose.length, `should be closed rather than merged and ${shouldClose.length === 1 ? 'is' : 'are'} still open`, shouldClose)
      : null,
    waiting.length
      ? phrase(waiting.length, `${waiting.length === 1 ? 'is' : 'are'} waiting on checks or a review`, waiting)
      : null,
    unknown.length
      ? phrase(unknown.length, `came back with an unrecognised verdict and nobody has looked at ${unknown.length === 1 ? 'it' : 'them'}`, unknown)
      : null,
  ].filter(Boolean);

  return {
    at: nowIso,
    total: rows.length,
    // True when the run only looked at a subset (`--pr=594`). Without this a
    // one-PR view publishes as though it were the whole world, and the digest
    // cheerfully reports "nothing else is waiting" on no evidence.
    scoped: !!scoped,
    // Null, not an empty string: the digest renders a row only when there is
    // something to say, and '' would print an empty warning banner, which trains
    // the reader to ignore the section.
    alarm: parts.length ? parts.join('; ') : null,
    verdicts: rows.map((v) => ({
      number: Number.isFinite(v.number) ? v.number : null,
      title: v.title || null,
      verdict: v.verdict || null,
      headSha: v.headSha || null,
      decidingReasons: v.decidingReasons || [],
    })),
  };
}

/**
 * The digest side: turn a published payload into the one line to render, or null.
 *
 * Mirrors assessCyrusRelay's contract exactly ({status, message}, absent means
 * unknown and never an alarm) so the sender needs no new rendering code.
 *
 * THE STALENESS CASE IS THE POINT. A payload carries `at` so a reader can tell
 * the supervisor stopped running; without this function that timestamp is written
 * and never read, and a week-old "green and waiting" line renders as current
 * forever. That is the 2026-08-16 failure with extra steps — a healthy-looking
 * report over machinery that had stopped. An adversarial review flagged shipping
 * the timestamp without its consumer, correctly.
 *
 * @param {object|null} payload parsed pr-supervisor-status.json, or null if absent
 * @param {number} nowMs
 * @returns {{status:'ok'|'warn'|'error'|'unknown', message:string|null}}
 */
function assessSupervisorStatus(payload, nowMs = Date.now()) {
  if (payload === null || payload === undefined) {
    // Never published on this machine — genuinely unknown, not an alarm.
    return { status: 'unknown', message: null };
  }
  const writtenMs = Date.parse(payload.at);
  if (!Number.isFinite(writtenMs)) {
    return { status: 'error', message: 'PR supervisor: its status file is unreadable, so nobody is checking whether finished work is piling up.' };
  }
  // The window is two-sided. A clock skew or a hand-edited file dated in the
  // future would otherwise sail through as "fresh" forever, which is the same
  // silent-staleness failure wearing the opposite sign.
  const skewMs = nowMs - writtenMs;
  if (skewMs < -STATUS_CLOCK_SKEW_TOLERANCE_MS) {
    return { status: 'error', message: 'PR supervisor: its status file is dated in the future, so it cannot be trusted — the clock or the file is wrong.' };
  }
  if (skewMs > STATUS_STALE_AFTER_MS) {
    const ageH = Math.round(skewMs / 3600000);
    return {
      status: 'error',
      message: `PR supervisor: last checked ${ageH}h ago, so this is not current — finished pull requests could be waiting with nothing watching them.`,
    };
  }
  if (!payload.alarm) {
    // A partial run that found nothing proves nothing about the PRs it skipped.
    if (payload.scoped) return { status: 'unknown', message: null };
    return { status: 'ok', message: null };
  }
  if (typeof payload.alarm !== 'string') {
    return { status: 'error', message: 'PR supervisor: its status file is malformed, so nobody is checking whether finished work is piling up.' };
  }
  const scopeNote = payload.scoped ? ' (partial check — not every open PR was looked at)' : '';
  return { status: 'warn', message: `PR supervisor: ${payload.alarm}${scopeNote}.` };
}

module.exports = {
  VERDICT_SEVERITY,
  ADDITIVE_REGISTRY_FILES,
  isAdditiveEdit,
  rollupCheckState,
  OK_CONCLUSIONS,
  DEFAULT_STRONG_REVIEWERS,
  GREEN_CHECK_STATES,
  buildCollisionIndex,
  evidenceForSha,
  assessPullRequests,
  renderSupervisorDigest,
  buildStatusPayload,
  assessSupervisorStatus,
  listPrs,
  MAX_LISTED_PRS,
  STATUS_STALE_AFTER_MS,
  STATUS_CLOCK_SKEW_TOLERANCE_MS,
  phrase,
};
