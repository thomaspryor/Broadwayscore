/**
 * owner-approval-channel.js — pure decision logic for BRO-282: "no channel
 * tells the owner that something is waiting on their approval."
 *
 * Linear's built-in "In Review" state is already the generic signal every
 * dispatched session lands on when it finishes (linear-dispatch.js's own
 * seed prompt tells every session to set "In Review" on completion) — reusing
 * it for "blocked on an owner decision specifically" would conflate the two
 * and make the digest noisy with ordinary finished work. So this uses a
 * dedicated label (AWAITING_OWNER_LABEL) instead: one issue can be "In
 * Review" (session done, reviewable) AND separately "awaiting-owner"
 * (actively blocked — cannot ship without a plain-language yes from the
 * owner, e.g. the /visual-qa pre-push gate).
 *
 * No I/O here — scripts/lib/linear-client.js talks to the Linear API,
 * scripts/send-morning-digest.js and scripts/linear-attach-approval.js call
 * into this file for the pure filtering/shaping (CLAUDE.md rule 15).
 */
'use strict';

const { issueLabelNames } = require('./linear-dispatch.js');

const AWAITING_OWNER_LABEL = 'awaiting-owner';

function isAwaitingOwner(issue) {
  return issueLabelNames(issue).includes(AWAITING_OWNER_LABEL);
}

// {identifier, title, url}[] shaped issues -> renderNamedDigestBlock's
// {title, detail, url} item shape (autonomous-email-render.js) — same
// contract needs-you-snapshot.js already produces for the cmux-tab-based
// "Needs your decision" row, so this rides the same rendering rail rather
// than inventing a second item shape.
function buildAwaitingOwnerRows(issues) {
  return (issues || [])
    .filter(isAwaitingOwner)
    .map((issue) => ({
      title: `${issue.identifier}: ${issue.title}`,
      detail: 'Waiting on your approval',
      url: issue.url,
    }));
}

// Digest-shaped snapshot: {generatedAt, bannerText, items}. Returns null when
// nothing is waiting so the digest omits the block entirely — a standing
// zero-row trains the eye to skip it, which is the exact failure mode BRO-282
// exists to fix.
function buildAwaitingOwnerSection(issues, { now = new Date() } = {}) {
  const items = buildAwaitingOwnerRows(issues);
  if (!items.length) return null;
  return {
    generatedAt: now.toISOString(),
    bannerText: `${items.length} item${items.length === 1 ? '' : 's'} waiting on your approval`,
    items,
  };
}

module.exports = {
  AWAITING_OWNER_LABEL,
  isAwaitingOwner,
  buildAwaitingOwnerRows,
  buildAwaitingOwnerSection,
};
