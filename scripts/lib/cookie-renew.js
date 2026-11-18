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
const { tryAcquireFileLock } = require('./file-lock');

const LOGIN_COOLDOWN_MS = 20 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGINS_PER_WINDOW = 2;

const KEYCHAIN_SERVICE = 'broadwayscorecard-cookie-renew';

// One entry per outlet. Fields:
//   fileKey       data/cookies/<fileKey>.json (and the extractor's group name)
//   profile       persistent Chrome profile name (default: the outlet key);
//                 shared with browser-outlet-adapters.js and the login scripts
//   cookieDomains cookies kept from the profile (substring match)
//   loginUrl      where a human (--manual) or the adapter logs in
//   login         login adapter kind, see LOGIN_ADAPTERS / loginAdapterFor()
//   authCookies   cookies whose expiry schedules a renewal (planRenewal);
//                 each measured, see the comment on the entry
//   ciConfirm     CI's check-cookie-health Layer 3 can actually see this
//                 outlet's login, so a push is confirmed there
//   localOnly     cookies serve the local browser driver only; never pushed
// The Stage was the first outlet (BRO-4183); BRO-7705 added the other six.
const RENEW_OUTLETS = {
  thestage: {
    fileKey: 'thestage',
    cookieDomains: ['thestage.co.uk'],
    loginUrl: 'https://www.thestage.co.uk/login',
    login: 'stage-form',
    authCookies: ['USERSECURE', 'USER'],
    ciConfirm: true,
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
  // NYT: email one-time code via Gmail (flow from nyt-otp-login.js). NYT-S is
  // the ~1y subscriber cookie (363.9d left on 2026-11-17).
  nytimes: {
    fileKey: 'nytimes',
    profile: 'nyt',
    cookieDomains: ['nytimes.com'],
    loginUrl: 'https://myaccount.nytimes.com/auth/login',
    login: 'nyt-otp',
    authCookies: ['NYT-S'],
    ciConfirm: true,
  },
  // New Yorker (Condé Nast ID): email one-time code (newyorker-otp-login.js).
  // CN_access ~2 months. Paywall is client-side, so the probe is in-browser.
  newyorker: {
    fileKey: 'newyorker',
    cookieDomains: ['newyorker.com', 'condenast.com'],
    loginUrl: 'https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB',
    login: 'newyorker-otp',
    authCookies: ['CN_access'],
    ciConfirm: false,
  },
  // WaPo: email -> Next -> password (wapo-login.js). wp_ak_signinv2 is NOT
  // the session: on 2026-11-17 it had expired 0.7d earlier and the walled
  // probe still read 6589 chars (anon 309). The *_login_id cookies (~1y)
  // carry it, so those schedule renewal.
  wapo: {
    fileKey: 'wapo',
    cookieDomains: ['washingtonpost.com'],
    loginUrl: 'https://www.washingtonpost.com/subscribe/signin/',
    login: 'two-step-password',
    authCookies: ['wapo_secure_login_id', 'wapo_login_id'],
    ciConfirm: true,
  },
  // The Times: single-step email + password on login.thetimes.com (Auth0,
  // thetimes-login.js). authId ~weeks (10.4d left on 2026-11-17). Plain fetch
  // gets "Verifying Device", so the probe runs in the profile.
  thetimes: {
    fileKey: 'thetimes',
    cookieDomains: ['thetimes.co.uk', 'thetimes.com'],
    loginUrl: 'https://login.thetimes.com/?gotoUrl=https://www.thetimes.com/',
    login: 'one-step-password',
    authCookies: ['authId'],
    ciConfirm: false,
  },
  // FT: accounts.ft.com email -> Next -> password (probed 2026-11-17; the
  // page also carries a hidden decoy password input "_notUsed", so only
  // visible fields are filled). FTSession_s ~2 months.
  ft: {
    fileKey: 'ft',
    cookieDomains: ['ft.com'],
    loginUrl: 'https://accounts.ft.com/login?location=https%3A%2F%2Fwww.ft.com%2F',
    login: 'two-step-password',
    authCookies: ['FTSession_s'],
    ciConfirm: false,
  },
  // Telegraph: re-subscribed 2026-11-11 (owner keeps it). Email -> Continue
  // -> password, with invisible reCAPTCHA Enterprise on the page (probed
  // 2026-11-17): a challenge is a needs-human stop like any other. Until
  // Keychain items exist the owner logs in once with --manual. localOnly:
  // CI can't get past Akamai, so the cookies serve the local gap driver.
  // tmg_session / tmg_refresh carry the session (400d, measured 2026-11-17
  // from the logged-in profile).
  telegraph: {
    fileKey: 'telegraph',
    cookieDomains: ['telegraph.co.uk'],
    loginUrl: 'https://secure.telegraph.co.uk/customer/secure/login/?redirectTo=https%3A%2F%2Fwww.telegraph.co.uk%2Ftheatre%2Fwhat-to-see%2Fromeo-and-juliet-review-sadie-sink-noah-jupe%2F',
    login: 'two-step-password',
    authCookies: ['tmg_session', 'tmg_refresh'],
    ciConfirm: false,
    localOnly: true,
  },
};

/**
 * Login adapter kinds. `credentials` is what must be in the Keychain
 * (service KEYCHAIN_SERVICE, account <outlet>-<credential>). The browser
 * steps live in lib/cookie-login-adapters.js, keyed by the same kind.
 */
const LOGIN_ADAPTERS = {
  'stage-form': { credentials: ['email', 'password'] },
  'one-step-password': { credentials: ['email', 'password'] },
  'two-step-password': { credentials: ['email', 'password'] },
  'nyt-otp': { credentials: ['email'], otp: { fromFilter: 'nytimes.com', codePattern: /code[^\d]{0,10}(\d{6})/i } },
  'newyorker-otp': { credentials: ['email'], otp: { fromFilter: 'condenast.com', codePattern: /code is[^\d]{0,5}(\d{6})/i } },
};

/**
 * @param {string} outlet RENEW_OUTLETS key
 * @returns {{outlet:string, kind:string, credentials:string[], otp?:object, profile:string}|null}
 *   null for an unknown outlet or an outlet without an automatic login
 */
function loginAdapterFor(outlet) {
  const cfg = RENEW_OUTLETS[outlet];
  if (!cfg || !cfg.login || !LOGIN_ADAPTERS[cfg.login]) return null;
  return { outlet, kind: cfg.login, profile: cfg.profile || outlet, ...LOGIN_ADAPTERS[cfg.login] };
}

/** Cookie belongs to one of the outlet's domains (suffix match: ft.com must not take microsoft.com). */
function cookieInDomains(cookie, domains) {
  const d = String((cookie && cookie.domain) || '').replace(/^\./, '').toLowerCase();
  return (domains || []).some((x) => d === x || d.endsWith(`.${x}`));
}

/** Persistent-profile name for an outlet (nytimes -> nyt). */
function profileNameFor(outlet) {
  return (RENEW_OUTLETS[outlet] && RENEW_OUTLETS[outlet].profile) || outlet;
}

/**
 * Which credentials an adapter needs that the Keychain lookup did not return.
 * @param {{credentials:string[]}} adapter
 * @param {Record<string,string|null>} creds
 * @returns {string[]} missing Keychain account suffixes ([] = ready)
 */
function missingCredentials(adapter, creds) {
  return (adapter ? adapter.credentials : []).filter((k) => !(creds && creds[k]));
}

/**
 * Keychain check before a login (BRO-7705). Missing items are a sticky
 * needs-human stop that alerts ONCE ('stop-new'); later runs stay stopped
 * silently ('stop-sticky'). Unlike the other stops it clears itself the
 * first run after the owner adds the items, so they never also need --reset.
 * @param {object} state  per-outlet state
 * @param {object|null} adapter  loginAdapterFor(outlet)
 * @param {Record<string,string|null>} creds
 * @param {string} nowIso
 * @returns {{action:'proceed'|'stop-new'|'stop-sticky', state:object, missing:string[], note?:string}}
 */
/** A missing-Keychain stop (or one recorded before codes existed, BRO-4183). */
function isCredsMissingStop(needsHuman) {
  return !!needsHuman && (needsHuman.code === 'creds-missing' || (!needsHuman.code && /Keychain credentials missing/i.test(needsHuman.reason || '')));
}

function credentialGate(state, adapter, creds, nowIso) {
  const s = { ...emptyOutletState(), ...(state || {}) };
  const missing = adapter ? missingCredentials(adapter, creds) : ['login adapter'];
  if (!missing.length) {
    if (isCredsMissingStop(s.needsHuman)) {
      return { action: 'proceed', missing, state: { ...s, needsHuman: null }, note: 'Keychain items now present; cleared the missing-credentials stop' };
    }
    return { action: 'proceed', missing, state: s };
  }
  if (s.needsHuman) return { action: 'stop-sticky', missing, state: s };
  return { action: 'stop-new', missing, state: { ...s, needsHuman: { at: nowIso, reason: `Keychain credentials missing: ${missing.join(', ')}`, code: 'creds-missing' } } };
}

/** Any of the outlet's auth cookies present (an empty list = not checked). */
function hasAuthCookie(cookies, authCookies) {
  if (!authCookies || !authCookies.length) return true;
  const names = new Set(authCookies);
  return (cookies || []).some((c) => c && names.has(c.name) && c.value);
}

const UNCERTAIN_ALERT_MS = 12 * 60 * 60 * 1000; // launchd runs every 6h: ~2 consecutive uncertain runs (was 24h, BRO-7765)
/**
 * Exit code 1 (probe uncertain/error) never logs in. Track how long an
 * outlet has been stuck there and ask for ONE digest alert after 12h.
 * @returns {{state:object, alert:boolean}}
 */
function trackUncertain(state, code, nowMs) {
  const s = { ...emptyOutletState(), ...(state || {}) };
  if (code !== 1) return { state: { ...s, uncertainSince: null, uncertainAlerted: false }, alert: false };
  const since = s.uncertainSince || new Date(nowMs).toISOString();
  const due = !s.uncertainAlerted && nowMs - Date.parse(since) >= UNCERTAIN_ALERT_MS;
  return { state: { ...s, uncertainSince: since, uncertainAlerted: s.uncertainAlerted || due }, alert: due };
}

/** Exit code for a multi-outlet run: the worst one (4 > 3 > 2 > 1 > 0). */
function worstExitCode(codes) {
  return (codes || []).reduce((a, b) => Math.max(a, Number(b) || 0), 0);
}

// --- Expiry-aware scheduling (BRO-7705) --------------------------------------

// launchd runs every 6h; a 3-day lead gives a dozen chances to refresh before
// the soonest auth cookie lapses while the 20h login cooldown still allows at
// most a few logins inside it.
const RENEW_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Soonest expiry among the outlet's auth cookies. Session cookies (no
 * expiry) and cookies not in the list are ignored.
 * @param {Array<{name:string, expires?:number}>} cookies  expires in epoch seconds
 * @param {string[]} authCookies
 * @returns {{name:string, expiresMs:number}|null}
 */
function soonestAuthExpiry(cookies, authCookies) {
  const names = new Set(authCookies || []);
  let best = null;
  for (const c of cookies || []) {
    if (!c || !names.has(c.name) || !(Number(c.expires) > 0)) continue;
    const ms = Number(c.expires) * 1000;
    if (!best || ms < best.expiresMs) best = { name: c.name, expiresMs: ms };
  }
  return best;
}

/**
 * What a run should do for one outlet.
 *   'none'    : logged in and no auth cookie lapses within leadMs
 *   'refresh' : open the persistent profile, take its (possibly rolled)
 *               cookies; only if the profile is logged out too may a gated
 *               login follow
 *   'stop'    : the probe could not tell (error/vacuous); never log in on it
 * @param {object} p
 * @param {'logged-in'|'logged-out'|'vacuous'|'error'|'unknown'} p.probeStatus
 *   'unknown' = browser-probed outlet, the profile session decides
 * @param {Array} p.cookies   local cookie file
 * @param {string[]} p.authCookies
 * @param {number} p.nowMs
 * @param {number} [p.leadMs]
 * @returns {{action:'none'|'refresh'|'stop', reason:string, soonest:{name:string, expiresMs:number}|null}}
 */
function planRenewal({ probeStatus, cookies, authCookies, nowMs, leadMs = RENEW_LEAD_MS }) {
  const soonest = soonestAuthExpiry(cookies, authCookies);
  const left = soonest ? `${soonest.name} ${((soonest.expiresMs - nowMs) / 86400000).toFixed(1)}d left` : 'no dated auth cookie';
  if (probeStatus === 'error' || probeStatus === 'vacuous') return { action: 'stop', reason: `probe ${probeStatus}`, soonest };
  if (probeStatus === 'logged-out') return { action: 'refresh', reason: 'probe logged out', soonest };
  if (probeStatus === 'unknown') return { action: 'refresh', reason: `in-profile probe (${left})`, soonest };
  if (soonest && soonest.expiresMs - nowMs < leadMs) return { action: 'refresh', reason: `expiring: ${left}`, soonest };
  return { action: 'none', reason: `logged in (${left})`, soonest };
}

/**
 * BRO-7716: where the logged-in probe runs. HTTP-probed outlets (nytimes,
 * wapo, thestage) whose plain-fetch probe reads 'error' (bot challenge, e.g.
 * NYT 403 from a residential IP) fall back to the in-browser profile probe,
 * as browserOnly outlets use. Only a bot-wall 'error' falls back: 'vacuous'
 * stays a stop (probe URL is stale), and every login guard (confirmWall,
 * anonymous control, credentialGate) still applies downstream.
 * @returns {{inBrowser:boolean, probeStatus:string, fellBack:boolean}}
 */
function resolveProbeMode({ browserOnly, probeStatus }) {
  if (browserOnly) return { inBrowser: true, probeStatus, fellBack: false };
  if (probeStatus === 'error') return { inBrowser: true, probeStatus: 'unknown', fellBack: true };
  return { inBrowser: false, probeStatus, fellBack: false };
}

/**
 * The cookie-less control was answered with a bot challenge. Tolerated only
 * for probes that declare controlBlockedIsWalled; otherwise fail closed.
 * Precondition: the in-profile probe already read 'logged-in' (body >= minBody
 * plus auth cookie). Residual risk: a free probe url is undetectable for such
 * outlets; the auth-cookie check is then the only guard (BRO-7765).
 * @returns {'walled'|'unverified'}
 */
function decideControlBlocked(probe) {
  return probe && probe.controlBlockedIsWalled ? 'walled' : 'unverified';
}

/**
 * BRO-7716: what to do with the anonymous control result. Only fallback
 * outlets (fetch probe bot-walled) may tolerate an unreadable control, and
 * only for a read-only probe: with vacuity unverified a real run must not
 * write/push cookies or stamp the outlet healthy.
 * @returns {'proceed'|'fail'|'probe-only-ok'}
 */
function decideControlUnverified({ fellBack, probeOnly }) {
  if (!fellBack) return 'fail';
  return probeOnly ? 'probe-only-ok' : 'fail';
}

/**
 * Did the profile hand us a session different from the saved file? Compares
 * the auth cookies' values and expiries (never printed) so a logged-in
 * profile whose session matches the file does not re-push the bundles every
 * run. With no auth cookies configured, any change in the outlet's cookie
 * names/values counts.
 */
function authCookiesChanged(oldCookies, newCookies, authCookies) {
  const names = authCookies && authCookies.length ? new Set(authCookies) : null;
  const key = (list) => (list || [])
    .filter((c) => c && (!names || names.has(c.name)))
    // Expiry to the day: a cookie whose expiry slides a few seconds per
    // visit must not re-push the bundles every run.
    .map((c) => `${c.domain}|${c.name}|${c.value}|${names ? Math.round((Number(c.expires) || 0) / 86400) : ''}`)
    .sort().join('\n');
  return key(oldCookies) !== key(newCookies);
}

function profileDir(outlet) {
  // COOKIE_RENEW_PROFILE_ROOT: supervised dry runs / tests only (an empty
  // root makes every outlet look logged out without touching real profiles).
  if (process.env.COOKIE_RENEW_PROFILE_ROOT) return path.join(process.env.COOKIE_RENEW_PROFILE_ROOT, outlet);
  return path.join(os.homedir(), 'Library', 'Application Support', 'BroadwayScorecard', 'browser-profiles', outlet);
}

/**
 * The one renew/profile lock: the main checkout's data/cookies/_renew.lock
 * (worktrees have no cookie jar of their own). renew-cookies.js, the gap
 * driver's browser sessions and every login/recover script hold it while
 * Chrome has the outlet's profile open (Chrome refuses a profile directory
 * another Chrome holds).
 */
function renewLockPath() {
  if (process.env.COOKIE_RENEW_LOCK_PATH) return process.env.COOKIE_RENEW_LOCK_PATH; // tests
  let root = null;
  try { root = require('./review-texts-dir').mainWorktreeOf(path.join(__dirname, '..', '..')); } catch { /* fall back */ }
  root = root || path.join(os.homedir(), 'Broadwayscore');
  return path.join(root, 'data', 'cookies', '_renew.lock');
}

/**
 * Plan item 8 (BRO-7171): one persistent Chrome profile per outlet outside
 * /tmp, shared by renew-cookies.js, the gap driver and the standalone
 * login/recover scripts, so a login made by one is the session the others
 * use (and survives a reboot; macOS clears /tmp). Takes the renew lock for the
 * rest of the process. The first claim copies the newest legacy /tmp profile
 * in, so an existing login is not lost to the move.
 * @param {string} outlet  profile name (browser-outlet-adapters / RENEW_OUTLETS key)
 * @param {{legacy?: string[]}} [opts] old /tmp profile dirs (the newest by mtime is copied)
 * @returns {{dir: string, release: Function}}  throws code EPROFILEBUSY when another run holds it
 */
const _claimed = new Map(); // outlet -> claim, so a second launch site in one run reuses it
function claimOutletProfile(outlet, { legacy = [] } = {}) {
  if (_claimed.has(outlet)) return _claimed.get(outlet);
  const release = acquireLock(renewLockPath());
  if (!release) {
    const err = new Error(`another browser run holds the ${outlet} profile (lock ${renewLockPath()}); try again when it finishes`);
    err.code = 'EPROFILEBUSY';
    throw err;
  }
  // The lock is held for the whole run, and acquireLock treats a lock older
  // than LOCK_STALE_MS (2h) as abandoned. A live long run (gap driver,
  // recovery batch) keeps its mtime fresh so a second run cannot claim it and
  // open Chrome on the same profile. Touches only while the body is still ours.
  const lp = renewLockPath();
  let ownBody = null;
  try { ownBody = fs.readFileSync(lp, 'utf8'); } catch { /* touched below only if readable */ }
  const beat = setInterval(() => {
    try { if (ownBody !== null && fs.readFileSync(lp, 'utf8') === ownBody) { const t = new Date(); fs.utimesSync(lp, t, t); } } catch { /* lock gone */ }
  }, Number(process.env.COOKIE_RENEW_HEARTBEAT_MS) || 10 * 60 * 1000);
  beat.unref();
  const stop = () => { clearInterval(beat); release(); };
  process.once('exit', stop);
  const dir = profileDir(outlet);
  try {
    const empty = !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
    // The most recently used legacy profile (login and recover scripts each had their own).
    const from = empty && legacy
      .map((d) => { try { return fs.readdirSync(d).length > 0 ? { d, m: fs.statSync(d).mtimeMs } : null; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.m - a.m).map((x) => x.d)[0];
    if (from) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      // Chrome's Singleton* files point at the old process; never copy them.
      fs.cpSync(from, dir, { recursive: true, filter: (src) => !/[\\/]Singleton(Lock|Socket|Cookie)$/.test(src) });
      console.log(`[profile] ${outlet}: migrated legacy profile ${from} -> ${dir}`);
    }
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn(`[profile] ${outlet}: legacy profile copy failed (${e.message}); starting a fresh profile`);
    fs.mkdirSync(dir, { recursive: true });
  }
  const claim = { dir, release: () => { _claimed.delete(outlet); stop(); } };
  _claimed.set(outlet, claim);
  return claim;
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
    const how = isCredsMissingStop(s.needsHuman) ? 'clears itself once the Keychain items exist' : 'clear with --reset after fixing';
    return { allowed: false, escalate: false, reason: `needs-human since ${s.needsHuman.at}: ${s.needsHuman.reason} (${how})` };
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
  if (require('./cookie-probes').isBotChallenge(h)) return 'bot-challenge';
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
  // In-place claim under file-lock's steal gate (BRO-7171): the old
  // unlink-then-wx let two waiters that both saw a dead holder both win once
  // browser recovery and login scripts started sharing this lock (race test:
  // 5 of 10 racers inside at once). Release removes only this call's body.
  return tryAcquireFileLock(lockPath, { staleMs: 0, abandonedMs: LOCK_STALE_MS });
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
  LOGIN_ADAPTERS,
  RENEW_LEAD_MS,
  loginAdapterFor,
  profileNameFor,
  missingCredentials,
  soonestAuthExpiry,
  planRenewal,
  resolveProbeMode,
  decideControlUnverified,
  decideControlBlocked,
  authCookiesChanged,
  credentialGate,
  isCredsMissingStop,
  cookieInDomains,
  worstExitCode,
  hasAuthCookie,
  trackUncertain,
  UNCERTAIN_ALERT_MS,
  KEYCHAIN_SERVICE,
  LOGIN_COOLDOWN_MS,
  LOGIN_WINDOW_MS,
  MAX_LOGINS_PER_WINDOW,
  LOCK_STALE_MS,
  profileDir,
  renewLockPath,
  claimOutletProfile,
  emptyOutletState,
  decideLogin,
  classifyLoginFailure,
  loadState,
  saveState,
  acquireLock,
  readKeychain,
};
