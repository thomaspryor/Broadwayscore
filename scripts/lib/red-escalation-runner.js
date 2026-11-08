'use strict';
/**
 * BRO-7102 / BRO-7130: put a long-open alert condition's card in front (High,
 * Todo, fresh START-NOW) so the cloud board worker takes it even when the Mac
 * is off. Extracted from route-main-streak-signatures.js so the Data
 * Validation per-step alerts (data-validation-routing.js) use the same loop.
 *
 * Best-effort: a Linear hiccup logs and moves on, never fails the calling job.
 * Kill switch: RED_ESCALATION_DISABLED=true (decideRedEscalation).
 */
const {
  decideRedEscalation, escalationUpdate, ESCALATION_COMMENT_PREFIX, NO_STAMP_HISTORY_REASONS,
  ESCALATION_HOURS, DEFAULT_SUBJECT,
} = require('./red-escalation.js');
const { loadLedger, patchCondition } = require('./owner-alert-router.js');

/**
 * @param {string[]} conditionKeys alert-ledger keys that are failing right now
 * @param {{thresholdHours?: number, subject?: string, logTag?: string}} [opts]
 *   subject: words for the START-NOW line and comment, e.g. "main has been red on this signature"
 */
async function escalateLongRedConditions(conditionKeys, opts = {}) {
  const thresholdHours = opts.thresholdHours || ESCALATION_HOURS;
  const subject = opts.subject || DEFAULT_SUBJECT;
  const tag = `[${opts.logTag || 'red-escalation'}]`;
  if (!conditionKeys || !conditionKeys.length) return;
  if (!process.env.LINEAR_API_KEY) {
    console.log(`${tag} escalation skipped: LINEAR_API_KEY not set`);
    return;
  }
  const linear = require('./linear-client.js');
  const { startNowUnpickableReason, historySkipReason } = require('./cloud-worker-pick.js');
  const conditions = loadLedger().conditions || {};
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let todoStateId;
  for (const key of conditionKeys) {
    const condition = conditions[key];
    if (!condition || !condition.linearIdentifier) continue;
    try {
      // Cheap ledger-only checks first, so a young incident costs no Linear call.
      const pre = decideRedEscalation({ condition, card: { state: { type: 'unstarted' } }, nowMs, thresholdHours });
      if (!pre.escalate) continue;
      const data = await linear.graphql(`query($id: String!) { issue(id: $id) {
        id identifier title description priority updatedAt state { id name type }
        comments(first: 50, orderBy: createdAt) { nodes { body createdAt } } } }`, { id: condition.linearIdentifier });
      const card = data && data.issue;
      const comments = (card && card.comments && card.comments.nodes) || [];
      const historyReason = card ? historySkipReason(card, comments, nowMs, { cloudLane: true }) : null;
      const decision = decideRedEscalation({ condition, card, nowMs, thresholdHours, historyReason, comments });
      if (!decision.escalate) {
        console.log(`${tag} escalation: ${key} (${condition.linearIdentifier}) red ${decision.ageHours == null ? '?' : decision.ageHours.toFixed(1)}h, not escalated: ${decision.reason}`);
        continue;
      }
      if (todoStateId === undefined) {
        const team = await linear.getTeam();
        const todo = (team.states.nodes || []).find((st) => st.type === 'unstarted' && st.name === 'Todo') || (team.states.nodes || []).find((st) => st.type === 'unstarted');
        todoStateId = todo ? todo.id : null;
      }
      const stamped = escalationUpdate({ card, ageHours: decision.ageHours, nowIso, todoStateId, pickable: true, subject }).input.description;
      // A card paused MAX_PAUSES times, or one the cloud lane reported it cannot work,
      // keeps its priority bump but no START-NOW: another cloud attempt would hit the same wall.
      const unpickable = NO_STAMP_HISTORY_REASONS.has(historyReason)
        ? { reason: historyReason, hint: 'a person should read its pause reports' }
        : startNowUnpickableReason({ title: card.title, description: stamped, priority: 2, mode: 'dispatch' });
      const { input, changes } = escalationUpdate({ card, ageHours: decision.ageHours, nowIso, todoStateId, pickable: !unpickable, subject });
      if (Object.keys(input).length) await linear.updateIssue(card.id, input);
      // Stamp the ledger as soon as the card changed, so a failed comment below
      // cannot make every later red run re-stamp START-NOW-SINCE.
      patchCondition(key, { escalatedAt: nowIso, escalationLane: unpickable ? `mac:${unpickable.reason}` : 'cloud-start-now' });
      const lane = unpickable
        ? `The cloud worker cannot take it (${unpickable.reason}: ${unpickable.hint}), so it stays with the Mac red-first pass.`
        : 'The cloud board worker takes it on its next firing (START-NOW).';
      await linear.createComment(card.id, `${ESCALATION_COMMENT_PREFIX} ${subject} for ${decision.ageHours.toFixed(1)}h. ${changes.length ? `Changed: ${changes.join('; ')}.` : 'No field changes needed.'} ${lane}`);
      console.log(`${tag} escalated ${key} -> ${card.identifier}: ${changes.join('; ') || 'no changes'}${unpickable ? ` (cloud-unpickable: ${unpickable.reason})` : ''}`);
    } catch (e) {
      console.error(`::warning::${tag} escalation failed for ${key}: ${e.message}`);
    }
  }
}

module.exports = { escalateLongRedConditions };
