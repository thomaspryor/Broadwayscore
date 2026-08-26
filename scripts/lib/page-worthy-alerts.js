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
  'broadcast:overdue:', // opening-night-broadcast.yml: broadcast hasn't sent 6+h after a show's opening — the pipeline (gather/rebuild/score) may be stuck
];

const PAGE_WORTHY_CONDITION_KEYS = new Set([
  // Meta: alert-pipeline self-tests — must always page (see file header).
  'alert-router:deadman', // health-check.js: disposition='auto' has been silently failing for 7 days
  'e2e-canary:chain-broken', // e2e-canary-alert-chain.js: the real (unmocked) alert→card→dispatch chain is broken

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
]);

function isPageWorthy(conditionKey) {
  if (!conditionKey) return false;
  if (PAGE_WORTHY_CONDITION_KEYS.has(conditionKey)) return true;
  return PAGE_WORTHY_PREFIXES.some((prefix) => conditionKey.startsWith(prefix));
}

module.exports = { PAGE_WORTHY_CONDITION_KEYS, PAGE_WORTHY_PREFIXES, isPageWorthy };
