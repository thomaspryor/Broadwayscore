/**
 * linear-pr-evidence.js — parse a hand-recorded "PR-EVIDENCE:" marker off a
 * Linear issue's text into the {merged, deployed, checked} shape
 * done-semantics-gate.js's evaluateDoneTransition() expects as `prRef`
 * (BRO-457).
 *
 * WHY A HAND-WRITTEN MARKER, NOT LINEAR'S NATIVE GITHUB ATTACHMENTS. BRO-457
 * named three options for sourcing PR evidence on an issue: (a) a marker
 * convention, (b) Linear's GitHub integration attachments, (c) cross-checking
 * scripts/check-prod-deploy.js against a PR number named on the issue.
 * Queried live before choosing: this workspace DOES have a `github`
 * integration connected (`integrations { nodes { service } }` returns it),
 * but issue.attachments came back empty on every sampled issue, including a
 * closed one (BRO-379, state "In Review", zero attachments) — the app isn't
 * auto-linking PRs to issues here, so (b) would silently block every close
 * regardless of real evidence. (c) needs a PR-number-on-the-issue convention
 * anyway, plus a live check-prod-deploy.js run inside a gate a person is
 * synchronously blocked on. (a) needs no new Linear schema, costs one line on
 * the issue, and reuses the exact "backticked/line-marker in free text" shape
 * this repo already established for VERIFY: lines (owner-judgment-marker.js,
 * autonomous-verify-cmd.js's VERIFY_LINE_RE) — so a closer types one more line
 * next to the one they're already used to writing, instead of learning a
 * second sourcing mechanism. If Linear's GitHub integration later starts
 * populating attachments for this team, that becomes a second, additive
 * source — this file only owns the marker half.
 *
 * Leaf module (no requires), same reasoning as owner-judgment-marker.js: kept
 * dependency-free so nothing that requires this can end up in a require
 * cycle.
 */

'use strict';

// Same shape as autonomous-verify-cmd.js's VERIFY_LINE_RE: an optional
// list-bullet and bold-markdown wrapper, then the marker, then free text.
// Global+multiline so a later marker in the same text (e.g. a corrected
// re-post) overrides an earlier one — last one wins, mirroring how a human
// reads the issue top-to-bottom and takes the most recent statement as true.
const PR_EVIDENCE_LINE_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?PR-EVIDENCE(?:\*\*)?:\s*(.+)$/gim;

/**
 * @param {string} text - issue description and/or comment text to scan
 * @returns {{merged:boolean, deployed:boolean, checked:boolean, url:string|null}|null}
 *   null when no PR-EVIDENCE: line is present at all. When present, each of
 *   merged/deployed/checked is true only if that exact word appears on the
 *   line — a line that only says "PR-EVIDENCE: merged" records
 *   deployed:false, checked:false, same as done-semantics-gate.js expects for
 *   a genuinely partial claim (it must not silently upgrade to `true`).
 */
function extractPrRef(text) {
  const s = String(text == null ? '' : text);
  let lastBody = null;
  for (const m of s.matchAll(PR_EVIDENCE_LINE_RE)) lastBody = m[1];
  if (lastBody == null) return null;

  const body = lastBody.trim();
  const urlMatch = body.match(/https?:\/\/\S+/);
  return {
    merged: /\bmerged\b/i.test(body),
    deployed: /\bdeployed\b/i.test(body),
    checked: /\bchecked\b/i.test(body),
    url: urlMatch ? urlMatch[0] : null,
  };
}

module.exports = { extractPrRef, PR_EVIDENCE_LINE_RE };
