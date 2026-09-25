/**
 * Page-worthy allowlist — the ONLY conditionKeys owner-alert-router.js will
 * actually email the owner for directly (disposition: 'human'). Everything
 * else requesting disposition: 'human' is downgraded to 'digest' at the
 * router level, regardless of what the caller asked for.
 *
 * Owner mandate 2026-07-28 (card #611), the owner's ~8th email-noise
 * escalation: per-sender demotions (#352/#409/#475/#514/#515/#531) each fixed
 * a named sender, but a new one always reappeared, because disposition:
 * 'human' was still an open door — any script could ask for it and get an
 * immediate email. This file closes that door structurally: the door only
 * opens for conditionKeys listed here. Add/remove entries directly; this
 * file IS the config the owner reads to see what's allowed to page them.
 *
 * Owner-approved categories (2026-07-28):
 *   1. Production site down
 *   2. Opening-night pipeline dead ON an opening night
 *   3. Data-loss in progress
 *   + Meta: the alert/dispatch pipeline's own self-tests. These must always
 *     page on failure — if THEY were gated by this same allowlist and lost,
 *     a broken alert pipeline would have no way to ever tell anyone it's
 *     broken (health-check.js's 7-day deadman check, the e2e canary).
 *
 * No sender currently emits a dedicated "production site down" or
 * "data-loss in progress" conditionKey (deploy failures fold into the
 * morning digest's health section per #608/#610) — those two categories
 * have no entries below yet. Add one here the day a sender for either
 * exists; do not pre-populate with a key nothing emits.
 *
 * BRO-1699: opening-night-poller.js and .github/workflows/opening-night-
 * broadcast.yml used to bypass routeAlert() entirely (direct sendAlert()
 * calls), on the theory that they must keep paging even if the router itself
 * is broken. That theory turned out to be the noise-regression bug, not a
 * safety feature — see the card for the two live bypasses it caught. Both
 * now call routeAlert(disposition:'human') like every other page candidate;
 * opening-night-broadcast.yml's overdue-broadcast alert IS Category 2 (below),
 * and opening-night-poller.js's SERP-burst-tripwire condition is a deliberate
 * carve-out below it (not one of the 3 categories, but preserving its
 * pre-migration real-time-page behavior — see that entry's comment).
 */
'use strict';

// Category 2: opening-night pipeline dead ON an opening night. All four are
// prefixes because the real conditionKey carries a per-night/per-show
// suffix (date or show-window key).
const PAGE_WORTHY_PREFIXES = [
  'on-monitor-launch-failed-', // opening-night-monitor-launch.js: the launcher could not start a monitor session tonight
  'on-monitor-auth-failed-', // opening-night-monitor-launch.js: claude auth preflight failed — zero coverage tonight
  'on-monitor-attempts-exhausted-', // opening-night-monitor-launch.js: 3 launch attempts died tonight, falling back to the standing pipeline
  'broadcast:draft-creation-failed:', // send-opening-night-broadcast.js: the time-sensitive opening-night email draft failed to create
  // BRO-886: the draft itself was created and tracked fine — only the
  // "hey, go review this in Resend" notification email failed. Without an
  // immediate page here, the owner has no other heads-up that a time-
  // sensitive opening-night draft is sitting unsent, and would only find out
  // via the next morning's digest — same urgency class as
  // 'broadcast:draft-creation-failed:' above, just a different failure point.
  'broadcast:owner-notification-failed:',
  'broadcast:overdue:', // opening-night-broadcast.yml: broadcast hasn't sent 6+h after a show's opening — the pipeline (gather/rebuild/score) may be stuck
  // check-missed-broadcasts.js: a show opened, qualified on scored reviews, and
  // then left the 2-day broadcast window without an email ever going out. This
  // is the TERMINAL form of the line above: 'broadcast:overdue:' can only fire
  // while the show is still in the window, so a show blocked for longer than
  // that used to exit the pipeline in total silence (Electra / Persona, The
  // Story and Abigail's Party all did, 2026-08/09 — found only because the
  // owner noticed one show's email arriving and another's never had). Nothing
  // retries these automatically, so the page IS the recovery mechanism.
  'broadcast:never-sent:',
  // 'opening-night-drift:' was listed here 2026-09 and REMOVED 2026-09-23
  // (owner email-noise complaint): it emailed once per show every 6h for the
  // whole ±7-day opening window, ~40 emails in one week across 5 shows. A
  // review-count mismatch between review-texts, reviews.json and live prod is
  // a data-reconciliation gap, not "the pipeline is dead tonight" — the
  // opening-night pipeline's real dead-man signals are the on-monitor-* and
  // broadcast:* keys above. check-opening-night-drift.yml still routes it
  // (downgraded to the morning digest by the router), so nothing goes silent.
];

const PAGE_WORTHY_CONDITION_KEYS = new Set([
  // Meta: alert-pipeline self-tests — must always page (see file header).
  'alert-router:deadman', // health-check.js: disposition='auto' has been silently failing for 7 days
  'e2e-canary:chain-broken', // e2e-canary-alert-chain.js: the real (unmocked) alert→card→dispatch chain is broken
  'alert-router:usage-limit-exceeded', // BRO-281: dispatchCard() hit Linear's USAGE_LIMIT_EXCEEDED — every 'auto' alert fails the same way until the workspace is archived/upgraded

  // Category (owner-approved 2026-08-03, affiliate hardening session — "it's
  // our only revenue stream, I do want it really strong"): affiliate revenue
  // pipeline BROKEN. Only the checks that mean money is actively being lost
  // page; softer anomalies (bot divergence, payout drift, collapses) stay
  // digest-tier. check-affiliate-health.js additionally runs a 14-day shadow
  // burn-in during which even these route to the digest.
  'affiliate:dead-man', // both click signals near-zero — shared-fate tracking/site breakage
  'affiliate:zero-conversions', // 0 conversions for 7 straight days, beyond any observed variance
  'affiliate:conversions-flatline', // conversions silent beyond own baseline WHILE clicks flow
  'affiliate:handoff-break', // site clicks flowing but Impact stopped recording them
  'affiliate:provider-auth:impact', // Impact API/credentials failing — monitor is blind
  'affiliate:provider-auth:posthog', // PostHog API/credentials failing — monitor is blind

  // Category 2: opening-night-sla-dispatch.js only runs against the active
  // opening-night checklist window (activeShowIds) — reviews stuck ≥60min
  // during a live opening-night operation IS the pipeline stalling on an
  // opening night (see card #406's "real pipeline stall?" P0). Also avoids a
  // regression: dispatchSlaAlerts() only advances its own re-notify "peak"
  // on disposition==='human' (scripts/lib/opening-night-sla.js) — downgrading
  // this key would silently stop future re-notifies once one incident queued.
  'opening-night-sla:pages-stuck',

  // Category 2 (task #1076): a revoked/unusable local Claude OAuth token
  // disables cmux-launch.js's launch gate entirely — not just tonight's
  // monitor — so this pages immediately rather than waiting in the digest
  // for the owner to discover it by accident on the next launch attempt (as
  // happened 2026-08-05, five shows before opening). Emitted by
  // check-claude-auth-health.js (launchd, runs on the Mac — the token never
  // reaches CI).
  'claude-auth:revoked',
  // 'claude-spawn-starved' / 'claude-spawn-error' (BRO-2971) were listed here
  // and REMOVED 2026-09-25 (BRO-4141, owner: "confusing and un-actionable").
  // They mean the Mac is overloaded or the claude binary is missing, not that
  // the owner must do something: re-login is 'claude-auth:revoked' above.
  // The owner received "[CRITICAL] Claude spawn failing from resource
  // starvation" twice in two days with nothing they could do. They still
  // route (downgraded to the morning digest), so nothing goes silent.

  // Not one of the 3 owner-approved categories above, but a deliberate
  // carve-out (BRO-1699 ship-check finding): this was a direct sendAlert()
  // real-time email BEFORE the routeAlert() migration, specifically because
  // its own severity comment argues the 24h-late digest is inadequate for a
  // same-day 60-100K ScrapingBee-credit runaway (feedback_sb_serp_invisible_
  // burn). Downgrading it to disposition:'human'-requested-but-actually-
  // digest would have silently regressed real-time paging while the code's
  // own rationale still claimed same-day urgency — leaving it off this list
  // was the ship-check-caught bug, not a deliberate policy choice. The hard
  // daily cap (scripts/lib/serp-burst-caps.js) still auto-stops the runaway
  // regardless of whether this page fires.
  'serp-burst:tripwire', // opening-night-poller.js: WE SERP burst cascade tripwire, one page per UTC day
  // Category 3 (BRO-545, pipeline self-healing): a hard-blocking rebuild
  // guard that has fired 2+ consecutive times means reviews.json — the
  // site's single source of truth for scores — has stopped advancing. This
  // is the "data-loss in progress" category the file header notes had no
  // entries yet; scripts/check-rebuild-staleness.js (via
  // scripts/lib/guard-escalation.js's shouldEscalate) is the first sender.
  'guard-escalation:stale-checkout-staleness',

  // Category 3 (BRO-2423, port of BRO-545's guard-escalation auto-recovery
  // to llm-ensemble-score.yml + check-review-count-drift.yml, found during
  // BRO-545's own /what-else pass): each of these three means the daily
  // LLM-scoring pipeline — reviews never getting a score is the same
  // "site's single source of truth has stopped advancing" class BRO-545
  // covers for rebuild-reviews.yml — or the review-count-drift safety net
  // that catches silently-suppressed opening-night reviews, has stopped
  // working for 2+ consecutive daily runs.
  'guard-escalation:scoring-queue-scan-failed', // scripts/check-scoring-queue-guard.js: count-scoring-queue.js can't trust the corpus scan (broken checkout) — the scoring cascade can't see its own queue depth
  'guard-escalation:ensemble-scoring-pipeline-crashed', // scripts/run-ensemble-scoring-guard.js: scripts/llm-scoring/index.ts itself is crashing — new reviews stop getting scored
  'guard-escalation:review-count-drift-strict-breach', // scripts/check-review-count-drift-guard.js: check-review-count-drift.yml's daily --strict run keeps blocking (stale reviews.json or opening-window reviews silently missing)

  // 'test-yml:main-streak-escalation' was listed below and REMOVED 2026-09-25
  // (BRO-4141). The history is kept for context. Its "24h cooldown caps this
  // to one email per day" claim was false in practice: test.yml's "Resolve
  // escalation alert on failing-job-set change" step resolves the condition
  // whenever the red job set flickers (e.g. "Lint Workflows, Unit Tests" ->
  // "Unit Tests"), so each flicker re-paged. The ledger shows notifyCount 102;
  // the owner got it at 22:46 and 22:52 on 2026-09-24. A red trunk is for the
  // automated fixers (the 2-failure 'auto' tier files the card), not the
  // non-technical owner; it still reaches the digest's "trunk: RED" line.
  //
  // (was) Category 3 carve-out (BRO-1333): main's Test Suite went undetected-red for
  // ~2 days (2026-06-13 → 06-15) because the only signal was a daily digest
  // line nobody read in time — direct pushes to main are not gated by
  // required checks (memory/feedback_branch_protection_direct_push.md), so
  // broken code keeps landing the whole time it stays red. This is the
  // "escalation" tier of that same detector (test.yml's own "Route alert —
  // main test.yml red on consecutive pushes" step, disposition:'human' at 4+
  // consecutive failures) — the 2-failure 'auto' tier still just files a
  // Linear card. Verified still live and needed on 2026-09-16: with this key
  // NOT yet on the allowlist, the 4+ tier had silently fired 73 times over
  // three weeks with zero real pages, its ledger entry pointing at BRO-3030
  // (an unrelated noise-audit issue matched by Linear's own substring search
  // finding the conditionKey quoted in that issue's body, not a dedicated
  // fix-main tracker) — i.e. the exact "digest line nobody reads" failure
  // mode this card exists to close. 24h cooldown (routeAlert call site) caps
  // this to at most one email per day while main stays red.
  // 'test-yml:main-streak' (health-check.js's "no confirmed-green run in Nh"
  // backstop) was listed here by BRO-3865 and REMOVED 2026-09-23 (owner
  // email-noise complaint). It paged the SAME condition as
  // 'test-yml:main-streak-escalation' above under a second conditionKey with
  // its own cooldown, so a red trunk produced two independent email streams.
  // The escalation tier stays the one email; this backstop now lands in the
  // morning digest's "trunk: RED" line (router downgrade human -> digest).
]);

function isPageWorthy(conditionKey) {
  if (!conditionKey) return false;
  if (PAGE_WORTHY_CONDITION_KEYS.has(conditionKey)) return true;
  return PAGE_WORTHY_PREFIXES.some((prefix) => conditionKey.startsWith(prefix));
}

module.exports = { PAGE_WORTHY_CONDITION_KEYS, PAGE_WORTHY_PREFIXES, isPageWorthy };
