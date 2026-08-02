/**
 * WSJ OTP-login cookie-refresh freshness check (task #830, follow-up to #779).
 *
 * scripts/wsj-otp-login.js is run monthly by
 * scripts/launchd/com.broadwayscore.wsj-cookie-refresh.plist and stamps
 * data/cookies/_extracted-at.json's `wsj` entry on every successful run.
 * Nothing previously read that timestamp for staleness — a silently dead
 * launchd job (asleep Mac, logged-out Chrome, drifted login-page selectors)
 * would leave data/cookies/wsj.json going stale with zero alert, the same
 * failure shape as #650/#559/#564/#567 in this repo.
 *
 * WARN_DAYS=40 gives one missed monthly cycle (~30d) plus slack before
 * nagging. FAIL_DAYS=70 means two missed cycles — past that, cookies are
 * essentially certain to be dead regardless of what Layer 1/2 report.
 */

const WSJ_OTP_WARN_DAYS = 40;
const WSJ_OTP_FAIL_DAYS = 70;

/**
 * @param {{extractedAtUnix?: number, extractedAt?: string}|null} meta - loadCookieMeta('wsj') result
 * @param {number} nowUnix - seconds since epoch (defaults to Date.now())
 */
function checkWsjOtpFreshness(meta, nowUnix = Date.now() / 1000) {
  let extractedUnix = meta && meta.extractedAtUnix;
  if (!extractedUnix && meta && meta.extractedAt) {
    const parsed = Date.parse(meta.extractedAt) / 1000;
    if (Number.isFinite(parsed)) extractedUnix = parsed;
  }

  if (!extractedUnix) {
    return {
      status: 'fail',
      message: 'no wsj OTP-refresh record in _extracted-at.json — launchd job may have never run',
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
