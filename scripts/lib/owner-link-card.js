'use strict';

/**
 * Writes and clears an owner-signed link (owner-signed-link.js) on a Linear
 * card. Shared by gmail-reauth.js (BRO-3712) and mezzanine-token.js (BRO-5235).
 *
 * Errors never echo Linear's message: it could quote the description, which
 * holds the signed link, and Actions logs of this repo are public.
 */

// A link with this much life left is kept: callers re-ask on every failing
// run, and each new link emails the owner again (owner-decision-notify keys on
// the question text).
const KEEP_LINK_DAYS = 7;

async function linearIssue(identifier) {
  const linear = require('./linear-client');
  const data = await linear.graphql('query($id: String!) { issue(id: $id) { id description state { type } } }', { id: identifier });
  if (!data.issue) throw new Error(`Linear issue ${identifier} not found`);
  return { linear, issue: data.issue };
}

// A closed card is not emailed (notify-owner-decisions skips terminal
// states), so a later ask reopens the card to Todo.
async function reopenInput(linear, issue) {
  const { isTerminalStateType } = require('./linear-state-types');
  if (!isTerminalStateType(issue.state && issue.state.type)) return {};
  const todo = (await linear.getTeam()).states.nodes.find((st) => st.type === 'unstarted');
  return todo ? { stateId: todo.id } : {};
}

/** True when the card's current link should stay instead of being re-minted. */
function shouldKeepLink(currentExp, nowMs = Date.now(), keepDays = KEEP_LINK_DAYS) {
  return Boolean(currentExp) && currentExp * 1000 - nowMs > keepDays * 86400 * 1000;
}

/**
 * @param {object} link       a createSignedLink() instance
 * @param {string} block      the DECISION NEEDED lines to write
 * @param {boolean} keepExisting  keep a current link with > KEEP_LINK_DAYS left
 * @returns {Promise<'kept' | 'written'>}
 */
async function writeLinkBlock(identifier, link, block, { keepExisting = true, nowMs = Date.now(), log = console.log } = {}) {
  const { linear, issue } = await linearIssue(identifier);
  const current = link.existingLinkExp(issue.description);
  if (keepExisting && shouldKeepLink(current, nowMs)) {
    log(`${identifier} already has a link valid until ${new Date(current * 1000).toISOString().slice(0, 10)}; kept it`);
    return 'kept';
  }
  const reopen = await reopenInput(linear, issue);
  try {
    await linear.updateIssue(issue.id, { description: link.withDecisionBlock(issue.description, block), ...reopen });
  } catch {
    throw new Error(`Linear update of ${identifier} failed`);
  }
  log(`wrote the DECISION NEEDED link to ${identifier}${reopen.stateId ? ' (reopened)' : ''}`);
  return 'written';
}

async function clearLinkBlock(identifier, link, note, { log = console.log } = {}) {
  const { linear, issue } = await linearIssue(identifier);
  const next = link.stripDecisionBlock(issue.description);
  if (next !== String(issue.description || '')) await linear.updateIssue(issue.id, { description: next });
  if (note) await linear.createComment(issue.id, note);
  log(`cleared the link on ${identifier}`);
}

module.exports = { KEEP_LINK_DAYS, linearIssue, reopenInput, shouldKeepLink, writeLinkBlock, clearLinkBlock };
