/**
 * WSJ OTP-login cookie-refresh freshness check (task #830, follow-up to #779).
 *
 * scripts/wsj-otp-login.js is run monthly by
 * scripts/launchd/com.broadwayscore.wsj-cookie-refresh.plist and stamps
 * data/cookies/_extracted-at.json's `wsj` entry (with `method: 'otp-login'`)
 * on every successful run. Nothing previously read that timestamp for
 * staleness — a silently dead launchd job (asleep Mac, logged-out Chrome,
 * drifted login-page selectors) would leave data/cookies/wsj.json going
 * stale with zero alert, the same failure shape as #650/#559/#564/#567.
 *
 * WARN_DAYS=40 gives one missed monthly cycle (~30d) plus slack before
 * nagging. FAIL_DAYS=70 means two missed cycles — past that, cookies are
 * essentially certain to be dead regardless of what Layer 1/2 report.
 *
 * The caller MUST gate on the meta being method:'otp-login' — extract-
 * safari-cookies.py's bundle `_meta` carries no `method` field and is a
 * whole-bundle push timestamp, not a per-outlet OTP-refresh timestamp; it
 * must never be mistaken for this signal (would report false freshness, or
 * in CI — where the local file never exists — false staleness twice a week).
 */

const WSJ_OTP_WARN_DAYS = 40;
const WSJ_OTP_FAIL_DAYS = 70;

/**
 * @param {{extractedAtUnix?: number, extractedAt?: string, method?: string}|null} meta - loadCookieMeta('wsj') result
 * @param {number} nowUnix - seconds since epoch (defaults to Date.now())
 */
function checkWsjOtpFreshness(meta, nowUnix = Date.now() / 1000) {
  if (!meta) {
    return {
      status: 'fail',
      message: 'no wsj OTP-refresh record in _extracted-at.json — launchd job may have never run',
      ageDays: null,
    };
  }

  if (meta.method !== 'otp-login') {
    return {
      status: 'warn',
      message: `wsj meta not sourced from OTP-login (method=${meta.method || 'unknown'}) — Safari extraction may have overwritten it; run node scripts/wsj-otp-login.js to confirm freshness`,
      ageDays: null,
    };
  }

  let extractedUnix = Number.isFinite(meta.extractedAtUnix) ? meta.extractedAtUnix : null;
  if (extractedUnix === null && meta.extractedAt) {
    const parsed = Date.parse(meta.extractedAt) / 1000;
    if (Number.isFinite(parsed)) extractedUnix = parsed;
  }

  if (extractedUnix === null) {
    return {
      status: 'fail',
      message: 'wsj OTP meta present but has no valid timestamp (extractedAtUnix/extractedAt both invalid)',
      ageDays: null,
    };
  }

  // Clock-skew / corrupt-meta guard, matches checkStaleness's convention.
  if (extractedUnix > nowUnix + 86400) {
    return {
      status: 'warn',
      message: 'wsj OTP extractedAt is in the future (corrupt meta or clock skew)',
      ageDays: null,
    };
  }

  const ageDays = Math.round((nowUnix - extractedUnix) / 86400 * 10) / 10;

  if (ageDays >= WSJ_OTP_FAIL_DAYS) {
    return {
      status: 'fail',
      message: `wsj OTP refresh ${ageDays}d old (>${WSJ_OTP_FAIL_DAYS}d — 2+ missed monthly cycles) — launchd job likely dead, run: node scripts/wsj-otp-login.js`,
      ageDays,
    };
  }
  if (ageDays >= WSJ_OTP_WARN_DAYS) {
    return {
      status: 'warn',
      message: `wsj OTP refresh ${ageDays}d old (>${WSJ_OTP_WARN_DAYS}d — missed a monthly cycle) — check: launchctl list com.broadwayscore.wsj-cookie-refresh`,
      ageDays,
    };
  }
  return {
    status: 'pass',
    message: `wsj OTP refresh OK (${ageDays}d ago)`,
    ageDays,
  };
}

module.exports = { checkWsjOtpFreshness, WSJ_OTP_WARN_DAYS, WSJ_OTP_FAIL_DAYS };
