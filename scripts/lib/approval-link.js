/**
 * Signed Approve/Reject links for remediation-plan emails
 * (scripts/generate-remediation-plan.js). The HMAC message must match
 * src/app/api/approve-fix/route.ts validateLink: change them together.
 * tests/unit/api-approve-fix.test.mjs exercises the route with this signer.
 */
'use strict';

const crypto = require('crypto');

function generateApprovalUrl(action, issueNumber, secret, planId, { now = Date.now(), baseUrl = 'https://broadwayscorecard.com' } = {}) {
  // 7-day expiry. planId binds the link to THIS generated plan: a rerun for
  // the same issue overwrites {issue}.json, and without the binding an
  // unexpired link for plan A would silently execute plan B. The executor
  // refuses on planId mismatch.
  const expires = Math.floor(now / 1000) + (7 * 24 * 60 * 60);
  const token = crypto
    .createHmac('sha256', secret)
    .update(`${action}:${issueNumber}:${expires}:${planId}`)
    .digest('hex');
  return `${baseUrl}/api/approve-fix?issue=${issueNumber}&token=${token}&expires=${expires}&action=${action}&plan=${planId}`;
}

module.exports = { generateApprovalUrl };
