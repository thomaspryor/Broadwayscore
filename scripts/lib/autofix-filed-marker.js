/**
 * autofix-filed-marker.js — the one definition of "this Linear issue was
 * filed BY the digest-autofix pipeline, which dispatches it itself".
 *
 * BRO-2499 (sibling of BRO-2488): the dispatch funnel has always been
 * DOCUMENTED as "Backlog/Todo, not `· Marketing`, not BSC Daily/CANARY"
 * (crown-loop handoff notes, ~/Documents/claude-outputs/p1-dispatcher-
 * handoff-2026-08-26-v20.md:167). BRO-2488 ported the `· Marketing` half
 * into linear-dispatch.js's marketingProjectGuard. This module is the other
 * half's signal.
 *
 * WHAT THE EXCLUSION ACTUALLY MEANS — this is NOT "never dispatch these".
 * scripts/lib/digest-autofix.js files issues titled `BSC Daily: <row>` and
 * scripts/lib/autofix-canary.js files `CANARY: touch <marker>`, and BOTH
 * then dispatch their own issue through the real pipeline
 * (`node scripts/linear-next.js --id BRO-N --headless`, digest-autofix.js's
 * dispatchDetached). A blanket refusal on these titles would disable the
 * daily autofix drain AND the daily end-to-end canary — the only live proof
 * that dispatch still works. The documented exclusion is about CANDIDATE
 * SELECTION: a crown-loop / human sweep of the backlog must not pick one of
 * these up, because the pipeline that filed it already owns it. So the guard
 * (linear-dispatch.js's autofixFiledIssueGuard) refuses by default and the
 * two owning pipelines pass an explicit opt-in flag.
 *
 * TWO SIGNALS, deliberately:
 *
 *  1. PROVENANCE (primary). Every one of these issues is created through
 *     digest-autofix.js's fileCard(), which shells out to linear-brain.js
 *     with `--park "<AUTOFIX_FILED_MARKER>; ..."`, and
 *     scripts/lib/linear-issue-create.js:141 prepends that reason to the
 *     issue DESCRIPTION as `PARKED: <reason>`. Structural and set at
 *     creation — the same reason marketingProjectGuard prefers the Linear
 *     project relation over description prose. Distinct from
 *     scripts/lib/linear-drain-parked.js's own AUTO_FILED_MARKER
 *     ("Auto-filed by owner-alert-router"), which is a different PARKED
 *     marker — but see the title note below: the two populations are NOT
 *     disjoint by title.
 *  2. TITLE (fallback). The historical convention the handoff line names.
 *     Covers an issue whose description was hand-edited after filing — and,
 *     more importantly, a SECOND producer: scripts/health-check.js:3951
 *     routes actionable health rows through owner-alert-router with
 *     `title: "BSC Daily: <row>"`, so an alert-filed tracker wears the same
 *     title convention with the owner-alert-router PARKED marker instead.
 *     Those are equally machine-owned (scripts/linear-drain-parked.js
 *     dispatches them), so refusing them at a human/crown-loop `--id` is
 *     correct — but that drain must pass the waiver too, and does
 *     (linear-drain-parked.js's dispatchFn call). Found by the BRO-2499
 *     ship-check: without that waiver this title check silently refused
 *     every dispatch that drain made.
 *
 * The title patterns are declared HERE rather than imported from
 * scripts/lib/task-store-archive.js:69, which has its own BSC_DAILY_TITLE_RE.
 * That one is an ARCHIVE RETENTION CLOCK over the frozen Notion task mirror
 * (task-store-archive.js:141 — "BSC Daily rows expire after 7 days, not 30").
 * Sharing one constant between a retention window and a live dispatch
 * refusal would mean a retention tweak silently changes what the dispatcher
 * refuses. Two purposes, two homes, on purpose.
 *
 * Leaf module, no imports — same shape as no-dispatch-marker.js and
 * owner-judgment-marker.js: every layer that needs to recognise this
 * provenance requires it directly instead of restating the strings.
 */

'use strict';

// The literal digest-autofix.js writes into its `--park` reason (and which
// linear-issue-create.js therefore prepends to the description). Defined
// here, USED there, so the recogniser and the writer can never drift.
const AUTOFIX_FILED_MARKER = 'Auto-filed by digest-autofix';

// Historical title conventions for the same population:
//   "BSC Daily: <health row>"       — digest-autofix.js:186
//   "Fix: BSC Daily: <health row>"  — the pre-BRO-286 email-worker button
//   "CANARY: touch <marker path>"   — autofix-canary.js's canaryCardTitle
const AUTOFIX_TITLE_PATTERNS = [
  /^(?:Fix:\s*)?BSC Daily:/,
  /^CANARY: touch\b/,
];

/**
 * Does this issue description carry digest-autofix's filing provenance?
 * @param {string|null|undefined} description
 * @returns {boolean}
 */
function hasAutofixFiledMarker(description) {
  return String(description || '').includes(AUTOFIX_FILED_MARKER);
}

/**
 * Does this issue title match the auto-filed digest/canary convention?
 * @param {string|null|undefined} title
 * @returns {boolean}
 */
function isAutofixFiledTitle(title) {
  const t = String(title || '').trim();
  return AUTOFIX_TITLE_PATTERNS.some((re) => re.test(t));
}

/**
 * Is this Linear issue one the digest-autofix / canary pipeline filed and
 * dispatches itself? Either signal is enough.
 * @param {{title?: string, description?: string}|null|undefined} issue
 * @returns {boolean}
 */
function isAutofixFiledIssue(issue) {
  if (!issue) return false;
  return isAutofixFiledTitle(issue.title) || hasAutofixFiledMarker(issue.description);
}

module.exports = {
  AUTOFIX_FILED_MARKER,
  AUTOFIX_TITLE_PATTERNS,
  hasAutofixFiledMarker,
  isAutofixFiledTitle,
  isAutofixFiledIssue,
};
