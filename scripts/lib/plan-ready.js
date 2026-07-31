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

module.exports = { PLAN_ONLY_ACTIONS, ESCALATABLE_STATUSES, shouldMarkPlanReady };
