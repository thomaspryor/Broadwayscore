'use strict';
/**
 * digest-answer-buttons.js (BRO-6715): the signed answer buttons the morning digest shows under
 * every card that waits on the owner, one per option plus "Reply in my own words". Each button
 * opens the confirm page behind /api/owner-decision (nothing is saved until Confirm, because mail
 * scanners open every link), then recordAnswer writes the answer and puts the card back on the
 * board. Before this the digest only linked to the Linear card, and a card with both a DECISION
 * NEEDED block and the awaiting-owner label (every visual-approval ask) never got buttons at all.
 *
 * Pure apart from the signing secret: no network. A digest dry run sets DIGEST_NO_LIST_TOKEN so a
 * tracked preview file never embeds a live token (same rule as the list-page link).
 */

const link = require('../../src/lib/owner-decision-link.js');
const { answerUrl, BASE_URL } = require('./owner-decision-email.js');

/**
 * @param {object} issue Linear issue with identifier, title, description, labels
 * @returns {Array<{key:string,label:string,url:string}>|null} null when the card cannot be answered by link
 */
function answerButtonsFor(issue, { secret = process.env.APPROVAL_HMAC_SECRET, now = Date.now(), baseUrl = BASE_URL } = {}) {
  if (!secret || process.env.DIGEST_NO_LIST_TOKEN || !issue || !issue.identifier) return null;
  // A row whose description never loaded (the enrich step is fail-soft) would look label-only and be signed
  // against the title hash; the answer page matches the real question and would say "Nothing to answer".
  if (typeof issue.description !== 'string') return null;
  let open;
  try { [open] = link.listOpenDecisions([{ ...issue, description: issue.description || '' }]); } catch { return null; }
  if (!open || !open.choices || !open.choices.length) return null;
  const token = link.signToken({ id: open.identifier, hash: open.hash, secret, now });
  const buttons = open.choices.map((c) => ({ key: c.key, label: c.label, url: answerUrl(token, c.key, baseUrl) }));
  buttons.push({ key: 'own', label: 'Reply in my own words', url: answerUrl(token, 'own', baseUrl) });
  return buttons;
}

module.exports = { answerButtonsFor };
