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
 * Two permanent exceptions live OUTSIDE this file and outside routeAlert()
 * entirely: opening-night-poller.js and .github/workflows/opening-night-
 * broadcast.yml call sendAlert() directly (never through routeAlert), by
 * deliberate design (CLAUDE.md rule 14) — they must keep working even if
 * the router itself is broken. They're tracked/reviewed via
 * scripts/.alert-sender-baseline.json, not here.
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
];

const PAGE_WORTHY_CONDITION_KEYS = new Set([
  // Meta: alert-pipeline self-tests — must always page (see file header).
  'alert-router:deadman', // health-check.js: disposition='auto' has been silently failing for 7 days
  'e2e-canary:chain-broken', // e2e-canary-alert-chain.js: the real (unmocked) alert→card→dispatch chain is broken

  // Category 2: opening-night-sla-dispatch.js only runs against the active
  // opening-night checklist window (activeShowIds) — reviews stuck ≥60min
  // during a live opening-night operation IS the pipeline stalling on an
  // opening night (see card #406's "real pipeline stall?" P0). Also avoids a
  // regression: dispatchSlaAlerts() only advances its own re-notify "peak"
  // on disposition==='human' (scripts/lib/opening-night-sla.js) — downgrading
  // this key would silently stop future re-notifies once one incident queued.
  'opening-night-sla:pages-stuck',
]);

function isPageWorthy(conditionKey) {
  if (!conditionKey) return false;
  if (PAGE_WORTHY_CONDITION_KEYS.has(conditionKey)) return true;
  return PAGE_WORTHY_PREFIXES.some((prefix) => conditionKey.startsWith(prefix));
}

module.exports = { PAGE_WORTHY_CONDITION_KEYS, PAGE_WORTHY_PREFIXES, isPageWorthy };
