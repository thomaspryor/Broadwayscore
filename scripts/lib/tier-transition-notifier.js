/**
 * tier-transition-notifier.js
 *
 * Pure decision logic for BRO-770: email followers when a show's social
 * pulse tier ENTERS 'Buzzing' or 'Troubled' (not on every run while it
 * stays there). Debounce state is the caller's responsibility to persist —
 * this module only computes the next state and which shows just transitioned.
 */

// A single entry into either of these tiers is notify-worthy — 'Rising',
// 'Steady', 'BuildingBaseline' and 'Hidden' are not (see social-pulse-scorer.js
// TIER_RULES for how a show ends up in each bucket).
const NOTIFICATION_TIERS = Object.freeze(['Buzzing', 'Troubled']);

/**
 * @param {Array<{showId: string, tier: string|null|undefined}>} pulseEntries
 *   Current tier per show, e.g. read from data/social-pulse/{id}.json.
 * @param {Object<string, {lastTier: string}>} transitionState
 *   Previous run's state (data/audit/social-tier-transitions.json), keyed by showId.
 * @returns {{
 *   transitions: Array<{showId: string, tier: string, previousTier: string|null}>,
 *   nextState: Object<string, {lastTier: string}>,
 * }}
 */
function detectTierTransitions(pulseEntries, transitionState) {
  const state = transitionState || {};
  const transitions = [];
  // Seed from prior state so a show missing from THIS run's pulse listing
  // (transient scrape gap, slug rename) keeps its debounce memory instead of
  // being treated as never-before-seen — without this, a one-run gap would
  // make its next Buzzing/Troubled sighting look like a fresh entry and
  // duplicate an email for a tier it never actually left.
  const nextState = { ...state };

  for (const entry of pulseEntries || []) {
    const showId = entry?.showId;
    const tier = entry?.tier;
    if (!showId || !tier) continue;

    const previousTier = state[showId]?.lastTier || null;

    // Debounce: only fire when the show is ENTERING a notify tier (the
    // previous run's tier differs from this one). A show that stays
    // Buzzing/Troubled week over week does not re-notify; a show that
    // drops out and later re-enters does.
    if (NOTIFICATION_TIERS.includes(tier) && previousTier !== tier) {
      transitions.push({ showId, tier, previousTier });
    }

    nextState[showId] = { lastTier: tier };
  }

  return { transitions, nextState };
}

/**
 * Builds the change-digest entry for a tier transition, matching the shape
 * detect-show-changes.js already writes into data/audit/show-changes-digest.json
 * ({type, message, ...}) so send-follow-notifications.js's generic email
 * builder can render it without any tier-specific branching.
 */
function buildTierChangeEntry(transition) {
  if (transition.tier === 'Buzzing') {
    return {
      type: 'social-tier-buzzing',
      message: 'Social buzz is picking up — this show just entered the Buzzing tier',
    };
  }
  if (transition.tier === 'Troubled') {
    return {
      type: 'social-tier-troubled',
      message: 'Social sentiment has turned — this show just entered the Troubled tier',
    };
  }
  throw new Error(`buildTierChangeEntry: unexpected tier "${transition.tier}"`);
}

module.exports = { NOTIFICATION_TIERS, detectTierTransitions, buildTierChangeEntry };
