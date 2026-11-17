#!/usr/bin/env node

/**
 * Times UK scripted login via email + password (task #919, closes task #876
 * follow-up — credentials were missing from .env until the owner supplied
 * THETIMES_EMAIL/THETIMES_PASSWORD on 2026-08-03).
 *
 * account.thetimes.co.uk's login page (probed live 2026-08-03 via
 * https://login.thetimes.com/?gotoUrl=... -> Auth0 /login redirect) is a
 * single-step email+password form (input[name="email"] /
 * input[name="password"]) with an Apple/Google SSO option but no OTP or 2FA
 * step. No honeypot field was found (unlike thestage.co.uk).
 *
 * Writes data/cookies/thetimes.json in the same schema
 * extract-safari-cookies.py produces, so every downstream consumer
 * (cookie-loader.js, recover-thetimes-browser.js, check-cookie-health.js)
 * needs no changes.
 *
 * Usage:
 *   node scripts/thetimes-login.js
 *
 * Requires: THETIMES_EMAIL and THETIMES_PASSWORD in the shell env.
 * Local only — do not run in CI (needs a real subscriber login).
 */

const args = process.argv.slice(2);
if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) {
  console.log('Usage: node scripts/thetimes-login.js');
  console.log('');
  console.log('Logs into thetimes.co.uk via email + password and writes fresh cookies');
  console.log('to data/cookies/thetimes.json. Requires THETIMES_EMAIL and');
  console.log('THETIMES_PASSWORD in the environment.');
  process.exit(0);
}

// BRO-7705: the login steps live in lib/cookie-login-adapters.js, shared
// with renew-cookies.js (which runs them with Keychain credentials inside the
// same persistent profile, once, behind the device-limit guards). This
// script is the manual entry point with env credentials.
const { standaloneLogin } = require('./lib/cookie-login-adapters');

standaloneLogin('thetimes', { email: process.env.THETIMES_EMAIL, password: process.env.THETIMES_PASSWORD }, {
  legacy: ['/tmp/thetimes-login-browser-profile', '/tmp/thetimes-recovery-browser-profile'],
  method: 'password-login',
})
  .then(() => console.log('Done.'))
  .catch((err) => {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  });
