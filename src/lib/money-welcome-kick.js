'use strict';
/**
 * money-welcome-kick.js (BRO-7704): pure helpers for src/app/api/money-welcome-kick/route.ts.
 * A Supabase pg_net trigger on insert into money_scorecard_signups POSTs that route with a shared
 * secret, so the welcome run starts even when the visitor's browser never makes the wake call.
 */
const crypto = require('crypto');

/** Constant-time check of the shared secret. An unset or empty expected secret never authorizes. */
function isAuthorized(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isAuthorized };
