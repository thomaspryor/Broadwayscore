/**
 * Decision logic for scripts/renew-cookies.js (BRO-4183).
 *
 * History that shapes every guard here: email/password login was removed on
 * 2026-03-30 because each CI runner logged in separately and The Stage
 * flagged the subscription for exceeding its 2-device limit. Renewal is
 * allowed back ONLY under these rules:
 *   - one machine (the Mac Studio), one persistent browser profile, so the
 *     outlet always sees the same "device";
 *   - a login is attempted only after the walled probe says the current
 *     cookies are logged out;
 *   - at most one login per outlet per LOGIN_COOLDOWN_MS, and a sticky
 *     needs-human stop after MAX_LOGINS_PER_WINDOW logins in LOGIN_WINDOW_MS
 *     (something keeps evicting the session: a phone login, the device
 *     limit, a password change; a machine retrying makes that worse);
 *   - any CAPTCHA, emailed code, rejected password or unrecognised page is a
 *     sticky needs-human stop. Never retried; cleared only by --reset.
 *
 * Pure functions + tiny fs helpers only, so tests can require() them
 * (CLAUDE.md §15).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { pidAlive, readLockPid } = require('./file-lock');

const LOGIN_COOLDOWN_MS = 20 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGINS_PER_WINDOW = 2;

const KEYCHAIN_SERVICE = 'broadwayscorecard-cookie-renew';

// One entry per outlet, added one at a time after the previous one has had a
// supervised live run. Order planned in BRO-4183: thestage, then ft,
// standard, timeout, newyorker (telegraph subscription was cancelled
// 2026-07-21, see cloud-memory/reference_paywall_subscriptions_status.md),
// then nytimes/wsj/wapo which may need manual steps.
const RENEW_OUTLETS = {
  thestage: {
    fileKey: 'thestage',
    cookieDomain: 'thestage.co.uk',
    loginUrl: 'https://www.thestage.co.uk/login',
    // The page renders a hidden duplicate form (#Email3786); bare name=
    // selectors grab it and hang, so target the visible fields. Never touch
    // the per-day "Age_M_D_YYYY" honeypot input.
    selectors: {
      consentReject: /reject additional cookies/i,
      email: 'input[name="email"]:visible',
      password: 'input[name="password"]:visible',
      submit: /^login$/i,
    },
  },
};

function profileDir(outlet) {
  return path.join(os.homedir(), 'Library', 'Application Support', 'BroadwayScorecard', 'browser-profiles', outlet);
}

// --- Login gate ------------------------------------------------------------

function emptyOutletState() {
  return { logins: [], needsHuman: null, pendingPush: false, lastSuccessAt: null };
}

/**
 * @param {object} state - per-outlet state (see emptyOutletState)
 * @param {number} nowMs
 * @returns {{allowed: boolean, reason: string, escalate: boolean}}
 *   escalate=true means the caller must record a needs-human stop.
 */
function decideLogin(state, nowMs) {
  const s = { ...emptyOutletState(), ...(state || {}) };
  if (s.needsHuman) {
    return { allowed: false, escalate: false, reason: `needs-human since ${s.needsHuman.at}: ${s.needsHuman.reason} (clear with --reset after fixing)` };
  }
  const times = s.logins.map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => b - a);
  if (times.length && nowMs - times[0] < LOGIN_COOLDOWN_MS) {
    const hrs = ((nowMs - times[0]) / 3600000).toFixed(1);
    return { allowed: false, escalate: false, reason: `cooldown: last login ${hrs}h ago (min ${LOGIN_COOLDOWN_MS / 3600000}h)` };
  }
  const inWindow = times.filter((t) => nowMs - t < LOGIN_WINDOW_MS).length;
  if (inWindow >= MAX_LOGINS_PER_WINDOW) {
    return { allowed: false, escalate: true, reason: `${inWindow} logins in the last ${LOGIN_WINDOW_MS / 86400000}d; something keeps ending the session (another device? device limit?)` };
  }
  return { allowed: true, escalate: false, reason: 'ok' };
}

/**
 * Why did a submitted login not produce a logged-in session? Only used to
 * word the alert; every outcome is a needs-human stop.
 */
function classifyLoginFailure({ url, html }) {
  const h = html || '';
  if (/recaptcha|hcaptcha|cf-turnstile|captcha/i.test(h)) return 'captcha';
  if (/autocomplete=["']one-time-code["']|verification code|one[- ]time (?:pass)?code|enter the code|we(?:'ve| have) sent (?:you )?(?:a|an) (?:code|email)/i.test(h)) return 'code';
  if (/\/login/i.test(url || '') && /incorrect|invalid|not recogni[sz]ed|try again|does not match/i.test(h)) return 'rejected';
  return 'unknown';
}

// --- State file + lock -----------------------------------------------------

function loadState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, statePath);
}

// A renew run takes minutes (login + up to ~40 min waiting on CI). A lock
// older than this is from a hung run or a PID reused after a reboot.
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Fail-CLOSED exclusive lock. scripts/lib/file-lock.js's withFileLock is
 * deliberately fail-open (runs the work after a timeout), which is right for
 * merging audit files and wrong for a login: two concurrent runs would be
 * two sessions. A lock held by a live PID means "skip this run". A lock left
 * by a dead PID (crash, reboot) or older than LOCK_STALE_MS is removed and
 * retaken once.
 *
 * @returns {Function|null} release function, or null if another run holds it
 */
function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      return () => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; }
      if (pidAlive(readLockPid(lockPath)) && ageMs < LOCK_STALE_MS) return null;
      // One launchd job on one machine is the only contender, so the
      // unlink-then-wx window is not the multi-waiter race file-lock.js #1024
      // guards against; wx still guarantees a single winner.
      try { fs.unlinkSync(lockPath); } catch { /* raced; retry decides */ }
    }
  }
  return null;
}

// --- Keychain ----------------------------------------------------------------

/**
 * Read a generic-password item from the login Keychain. Credentials live
 * only here, never in .env, GitHub secrets or the repo. Create with:
 *   security add-generic-password -s broadwayscorecard-cookie-renew -a thestage-email -w 'you@example.com'
 *   security add-generic-password -s broadwayscorecard-cookie-renew -a thestage-password -w
 */
function readKeychain(account, { exec = execFileSync } = {}) {
  try {
    return exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

module.exports = {
  RENEW_OUTLETS,
  KEYCHAIN_SERVICE,
  LOGIN_COOLDOWN_MS,
  LOGIN_WINDOW_MS,
  MAX_LOGINS_PER_WINDOW,
  LOCK_STALE_MS,
  profileDir,
  emptyOutletState,
  decideLogin,
  classifyLoginFailure,
  loadState,
  saveState,
  acquireLock,
  readKeychain,
};
