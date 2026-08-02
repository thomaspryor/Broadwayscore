/**
 * Shared pieces for scripted email-OTP login (task #831, generalizing #779's
 * WSJ implementation to NYT + New Yorker).
 *
 * Root cause (task #779): macOS Tahoe stopped persisting httpOnly cookies to
 * Safari's Cookies.binarycookies, so extract-safari-cookies.py can never
 * recover subscriber session cookies for ANY outlet on this machine — not
 * just WSJ (confirmed via --dry-run: 0 httpOnly cookies across all
 * DOMAIN_GROUPS). Email OTP sidesteps Safari entirely: a real Chrome browser
 * requests a one-time code, this process reads it from Gmail, submits it,
 * and captures the resulting session cookies directly from Playwright's
 * cookie jar (never touching Safari's cookie store).
 *
 * Extracted from scripts/wsj-otp-login.js rather than copy-pasted so a
 * fourth outlet is a config object, not a file diff.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const COOKIE_DIR = path.join(PROJECT_ROOT, 'data', 'cookies');

/**
 * Launch a persistent-profile browser for OTP login. Real installed Chrome
 * (channel: 'chrome') is required, not the bundled Chrome-for-Testing build —
 * WSJ's DataDome challenge and Condé Nast's bot checks both fingerprint the
 * for-testing binary (see recover-wsj-browser.js header). Falls back to
 * bundled chromium only if real Chrome isn't installed.
 */
async function launchOtpBrowser(profileDir) {
  const { chromium } = require('playwright');
  const launchOpts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };
  try {
    const context = await chromium.launchPersistentContext(profileDir, { ...launchOpts, channel: 'chrome' });
    console.log('  -> using installed Google Chrome (channel: chrome)');
    return context;
  } catch (err) {
    console.log(`  -> real Chrome unavailable (${err.message.split('\n')[0]}); falling back to bundled chromium`);
    return chromium.launchPersistentContext(profileDir, launchOpts);
  }
}

/**
 * Poll Gmail for a fresh OTP code sent after `sinceEpochSeconds`. The
 * server-side `after:` operator (X-GM-RAW, applied by Gmail itself) makes it
 * structurally impossible to pick up a code from an earlier login attempt —
 * critical because some OTP backends resend the SAME code on a second
 * request within the validity window rather than issuing a new one
 * (observed live for WSJ, task #779).
 *
 * @param {object} opts
 * @param {string} opts.fromFilter - Gmail `from:` search term (e.g. "nytimes.com")
 * @param {number} opts.sinceEpochSeconds - cutoff, captured BEFORE the OTP request
 * @param {RegExp} opts.codePattern - pattern with one capture group for the code,
 *   tested against the message SUBJECT first (NYT and New Yorker both put the
 *   code directly in the subject line), then the body as a fallback.
 * @param {number} [opts.maxAttempts=18]
 * @param {number} [opts.intervalMs=5000]
 * @returns {Promise<string|null>}
 */
async function pollGmailForOtpCode({ fromFilter, sinceEpochSeconds, codePattern, maxAttempts = 18, intervalMs = 5000 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const searchOut = execSync(
        `${process.env.HOME}/.claude/bin/gmail search "from:(${fromFilter}) after:${sinceEpochSeconds}" --days 1 --limit 3 --folder INBOX`,
        { encoding: 'utf8' }
      );
      const subjectMatch = searchOut.match(codePattern);
      if (subjectMatch) return subjectMatch[1];

      const uidMatch = searchOut.match(/uid=(\d+)/);
      if (uidMatch) {
        const body = execSync(`${process.env.HOME}/.claude/bin/gmail read ${uidMatch[1]}`, { encoding: 'utf8' });
        const bodyMatch = body.match(codePattern);
        if (bodyMatch) return bodyMatch[1];
      }
    } catch {
      // gmail helper transient error (e.g. pool saturated) — keep polling
    }
    console.log(`  ...no code yet (attempt ${attempt + 1}/${maxAttempts})`);
  }
  return null;
}

/**
 * Write captured cookies to data/cookies/{fileKey}.json in the same schema
 * extract-safari-cookies.py produces, so downstream consumers (cookie-loader.js,
 * recover-*-browser.js, check-cookie-health.js) need no changes. Also stamps
 * _extracted-at.json so freshness monitoring (task #830) sees the new method.
 */
function writeOtpCookies(fileKey, cookies) {
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  const cookiePath = path.join(COOKIE_DIR, `${fileKey}.json`);
  fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2) + '\n');

  const metaPath = path.join(COOKIE_DIR, '_extracted-at.json');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {}
  meta[fileKey] = {
    extractedAt: new Date().toISOString(),
    extractedAtUnix: Math.floor(Date.now() / 1000),
    method: 'otp-login',
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

  return cookiePath;
}

module.exports = { launchOtpBrowser, pollGmailForOtpCode, writeOtpCookies, COOKIE_DIR };
