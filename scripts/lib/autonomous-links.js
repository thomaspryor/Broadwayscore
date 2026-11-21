// Signed approve/reject/revert links for the autonomous nightly loop.
//
// The HMAC message format here MUST match the verification in
// src/app/api/autonomous-action/route.ts — change them together.

const crypto = require('crypto');

/**
 * Build the HMAC-SHA256 hex signature for an autonomous-action link.
 * Message: `auto:${action}:${cardId}:${branch}:${exp}`
 * (must match src/app/api/autonomous-action/route.ts)
 */
function buildSignature({ action, cardId, branch, exp, secret }) {
  return crypto
    .createHmac('sha256', secret)
    .update(`auto:${action}:${cardId}:${branch}:${exp}`)
    .digest('hex');
}

/**
 * Build a full signed URL for the autonomous-action endpoint.
 * exp is a unix timestamp in SECONDS (integer).
 */
function buildActionUrl({ action, cardId, branch, exp, secret, baseUrl }) {
  const sig = buildSignature({ action, cardId, branch, exp, secret });
  const params = new URLSearchParams({
    card: String(cardId),
    branch: String(branch),
    action: String(action),
    exp: String(exp),
    sig,
  });
  return `${baseUrl}/api/autonomous-action?${params.toString()}`;
}

/**
 * Verify a signature. Returns boolean; never throws on junk input
 * (bad hex, wrong length, empty string).
 */
function verifySignature({ action, cardId, branch, exp, secret, sig }) {
  if (!sig || typeof sig !== 'string') return false;
  // Require exactly 64 lowercase hex chars up front: Buffer.from(_, 'hex')
  // silently truncates at the first non-hex char, so "<validsig>JUNK" would
  // otherwise decode back to the valid signature and pass.
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = buildSignature({ action, cardId, branch, exp, secret });
  const expectedBuf = Buffer.from(expected, 'hex');
  const sigBuf = Buffer.from(sig, 'hex');
  if (sigBuf.length !== expectedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}

module.exports = { buildSignature, buildActionUrl, verifySignature };
