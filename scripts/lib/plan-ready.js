// Decides whether a just-completed Action Queue card should be auto-escalated
// so its finished plan actually gets implemented (bug class: homepage-pills
// card 3a4637c5 sat planned-but-unbuilt for 10 days because a Plan-only action
// left it at "Not started" with no priority — invisible to every dispatch path).
//
// Only Fix and Start implement code; everything else ends with words on a card.

const PLAN_ONLY_ACTIONS = new Set(['Investigate', 'Plan', 'Review', 'Plan+Review']);

// Only cards nobody is working escalate. In progress = someone owns it;
// Done/Paused = owner deliberately closed or parked it.
const ESCALATABLE_STATUSES = new Set(['Not started']);

/**
 * @param {{action: string, priority: ?string, status: string}} card
 * @returns {boolean} true when the card holds a finished plan but has no
 *   priority and sits at Not started — i.e. nothing will ever dispatch it
 *   unless we escalate.
 */
function shouldMarkPlanReady(card) {
  return PLAN_ONLY_ACTIONS.has(card.action) &&
    !card.priority &&
    ESCALATABLE_STATUSES.has(card.status);
}

// ── Investigate → Fix escalation (card #1073) ───────────────────────────
// The opening-night "babysitter" (audit-t1-silent-gaps.js) files Notion Action
// Queue cards for T1/T2 review gaps via owner-alert-router.js's routeAlert(),
// disposition:'auto'. Before #1073 those cards dispatched as bare
// 'Investigate' — which, per notion-action-poll.js's own prompt contract,
// makes NO code/data change. The finding lands in Outcome and Action clears;
// nothing ever implements the fix unless a human notices and re-sets Action.
// This is intentionally NOT a new module (a design reviewer rejected a
// parallel action-escalation.js as split-brain with this file) — it's the
// same "is a just-finished stage actually going anywhere" question
// shouldMarkPlanReady already answers, generalized one step further: instead
// of just flagging the card (P1 Next), escalate it all the way to Action='Fix'
// when it is safe to do so unattended.

// dispatchCard() in owner-alert-router.js unconditionally prepends this tag
// to every card it creates (`['alert-router', ...(tags || [])]`) — the one
// durable, already-existing marker for "no human authored this card." Keying
// off it (rather than adding a new marker) means every alert-router card,
// past and future, is automatically covered with zero additional plumbing.
const AUTO_ROUTER_TAG = 'alert-router';

// Owner priority floor for unattended escalation — P2/P3 backlog items never
// auto-escalate, matching the P0/P1-only auto-dispatch rule elsewhere in this
// codebase (see CLAUDE.md "P0/P1 = dispatch at creation").
const ESCALATABLE_PRIORITIES = new Set(['P0 Now', 'P1 Next']);

// Prefixes of the conditionKey values used by audit-t1-silent-gaps.js's two
// routeAlert() calls: `gap:${showId}/${file}` (silent gap on a near-opening
// show, ~line 500) and `backstop:${showId}/${file}` (T1/T2 review stuck >24h,
// ~line 601). Deliberately an ALLOWLIST, not "every alert-router card": these
// two conditions are pure DATA-RECOVERY fixes (re-fetch / re-score / clear-a-
// stale-flag — one-command, no code edited), never a code change. Adversarial
// review flagged that these dispatcher sessions run headless with
// --dangerously-skip-permissions and no human in the loop — auto-pointing one
// at an arbitrary code change with zero oversight is unacceptable. Extend
// this list only after the same review process approves a new condition
// family as safe.
const ESCALATABLE_CONDITIONS = ['gap:', 'backstop:'];

// owner-alert-router.js's buildCardNotes() always embeds the conditionKey in
// every auto-created card's Notes: `Condition "${conditionKey}" no longer
// fires on the next check.` This is the only place the conditionKey survives
// once the card exists in Notion (getActionableCards() doesn't read a
// dedicated property for it) — extract it from there. Returns null for any
// card whose notes don't carry the marker (hand-written cards, or cards
// created by a path other than dispatchCard()).
function extractConditionKey(notes) {
  const m = /Condition "([^"]+)" no longer fires/.exec(notes || '');
  return m ? m[1] : null;
}

/**
 * shouldEscalateToFix(card, ctx) — true only when a just-completed, standalone
 * 'Investigate' stage should be auto-escalated to Action='Fix' instead of
 * having Action cleared. Pure function: no fs/env access, every input comes
 * through card/ctx so it's cheaply unit-testable and the canary
 * (scripts/dispatcher-canary.js) can drive it without touching Notion.
 *
 * Every guard defaults CLOSED on ambiguous/missing input — a missed
 * escalation just reproduces the pre-#1073 behavior (card sits with Action
 * cleared, needs a human to re-trigger it), never a new failure mode.
 *
 * @param {{tags?: string[], priority?: ?string, notes?: string, conditionKey?: string}} card
 *   The Notion card as read by notion-action-poll.js's getActionableCards()
 *   (tags/priority/notes already in that shape). `conditionKey` may be passed
 *   pre-extracted by the caller; otherwise it's derived from `notes`.
 * @param {{hadChanges: boolean, alreadyEscalated: boolean, escalatedThisCycle: number, killSwitch: boolean}} ctx
 *   Dispatcher-supplied run context — see notion-action-poll.js's call site
 *   for exactly how each field is computed.
 * @returns {boolean}
 */
function shouldEscalateToFix(card, ctx) {
  if (!card || !ctx) return false;

  // (a) only cards the alert-router itself created — never an owner-authored
  // card that happens to reuse P0/P1 + Investigate for unrelated work.
  const tags = (card.tags || []).map(t => String(t).toLowerCase());
  if (!tags.includes(AUTO_ROUTER_TAG)) return false;

  // (b) priority floor — P2 Later / P3 Backlog (or no priority at all) never
  // auto-escalate.
  if (!ESCALATABLE_PRIORITIES.has(card.priority)) return false;

  // (c) the just-completed stage must have been a bare Investigate that made
  // ZERO durable change — a Fix/Plan+Review pipeline stage, or an Investigate
  // that (contract violation or not) actually produced something, must not
  // auto-escalate; that needs a human look, not more unattended automation.
  if (ctx.hadChanges !== false) return false;

  // (d) allowlisted condition families only — see ESCALATABLE_CONDITIONS above.
  const conditionKey = card.conditionKey || extractConditionKey(card.notes);
  if (!conditionKey || !ESCALATABLE_CONDITIONS.some(prefix => conditionKey.startsWith(prefix))) {
    return false;
  }

  // (e) once per card — if the owner later parks a previously-escalated card
  // (clears Action/Priority again), a subsequent Investigate on it must never
  // re-propose the same escalation.
  if (ctx.alreadyEscalated !== false) return false;

  // (f) per-poll-cycle rate limit (review-mandated storm guard): one bad audit
  // run filing several gap cards in the same cycle must not silently spawn
  // more than 2 unattended Fix pipelines at once.
  if (!(ctx.escalatedThisCycle < 2)) return false;

  // (g) kill switch — `touch ~/.claude-action-dispatcher/escalation-off`
  // disables all auto-escalation instantly, no code change or deploy needed.
  if (ctx.killSwitch !== false) return false;

  return true;
}

// Extracts the trailing structured verification line the HEADLESS CONTRACT
// (notion-action-poll.js buildPrompt()) requires every dispatched stage to
// end its output with: `VERIFIED: <exact command> — <one-line result>` or
// `UNVERIFIED: <why>`. Tolerant by design: scans the last 20 non-empty lines
// (not just the literal final line), since a session can trail a stray blank
// line, a closing code fence, or other markdown noise after the marker.
//
// @param {string} text — a stage's result text (run.result)
// @returns {{status: 'VERIFIED'|'UNVERIFIED', detail: string} | null} null
//   when no marker line is found at all — callers treat a missing line the
//   same as UNVERIFIED (see notion-action-poll.js).
function parseVerifiedOutcomeLine(text) {
  if (!text) return null;
  const lines = String(text).split('\n').filter(l => l.trim()).slice(-20);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const verified = /^VERIFIED:\s*(.+)$/i.exec(line);
    if (verified) return { status: 'VERIFIED', detail: verified[1].trim() };
    const unverified = /^UNVERIFIED:\s*(.+)$/i.exec(line);
    if (unverified) return { status: 'UNVERIFIED', detail: unverified[1].trim() };
  }
  return null;
}

module.exports = {
  PLAN_ONLY_ACTIONS,
  ESCALATABLE_STATUSES,
  shouldMarkPlanReady,
  AUTO_ROUTER_TAG,
  ESCALATABLE_PRIORITIES,
  ESCALATABLE_CONDITIONS,
  extractConditionKey,
  shouldEscalateToFix,
  parseVerifiedOutcomeLine,
};
