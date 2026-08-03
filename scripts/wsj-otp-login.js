#!/usr/bin/env node

/**
 * WSJ scripted login via email one-time-passcode.
 *
 * Root cause chain (task #779): macOS Tahoe no longer persists httpOnly
 * cookies to Safari's Cookies.binarycookies, so extract-safari-cookies.py
 * can never recover djcs_session/djcs_auto for WSJ. Fully scripted
 * password-based login (local Playwright AND Browserbase with
 * solveCaptchas) is separately blocked: Dow Jones SSO's anti-bot layer
 * either stalls at a DataDome challenge page or accepts the CAPTCHA and
 * then fake-rejects the correct password with "login details incorrect"
 * (reproduced live 2026-08-02, matches the documented note in
 * collect-review-texts.js knownBlockedSites). The email-OTP flow has no
 * password-based check to fake-reject — request a code, read it from
 * Gmail, submit it. Verified working end-to-end 2026-08-02.
 *
 * Writes data/cookies/wsj.json in the same schema extract-safari-cookies.py
 * produces, so every downstream consumer (cookie-loader.js,
 * recover-wsj-subscriber.js, check-cookie-health.js) needs no changes.
 *
 * Usage:
 *   node scripts/wsj-otp-login.js
 *   node scripts/wsj-otp-login.js --push   # also push cookies to the
 *                                           # WSJ_COOKIES GitHub secret so
 *                                           # CI workflows pick them up
 *                                           # (task #845 — the local file
 *                                           # never reaches CI otherwise)
 *
 * Requires: WSJ_USER (or WSJ_EMAIL) in the shell env, and
 * ~/.claude/bin/gmail on PATH (read-only IMAP helper) to fetch the code.
 * Local only — do not run in CI (WSJ blocks CI IPs; this also needs a
 * live inbox to poll). --push requires `gh` CLI authenticated against
 * thomaspryor/Broadwayscore.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) {
  console.log('Usage: node scripts/wsj-otp-login.js [--push]');
  console.log('');
  console.log('Logs into WSJ via email one-time-passcode (bypasses the Dow Jones SSO');
  console.log('anti-bot check that fake-rejects passwords from automated browsers) and');
  console.log('writes fresh cookies to data/cookies/wsj.json.');
  console.log('');
  console.log('Requires WSJ_USER or WSJ_EMAIL in the environment, and a working');
  console.log('~/.claude/bin/gmail (read-only IMAP) to retrieve the passcode email.');
  console.log('');
  console.log('--push   Also push the fresh cookies to the WSJ_COOKIES GitHub secret');
  console.log('         (requires authenticated `gh` CLI) so CI workflows that read');
  console.log('         cookies via cookie-loader.js pick up the fresh session.');
  process.exit(0);
}

const shouldPush = args.includes('--push');

const PROJECT_ROOT = path.join(__dirname, '..');
const COOKIE_DIR = path.join(PROJECT_ROOT, 'data', 'cookies');
const COOKIE_PATH = path.join(COOKIE_DIR, 'wsj.json');
const META_PATH = path.join(COOKIE_DIR, '_extracted-at.json');

const PROFILE_DIR = '/tmp/wsj-otp-browser-profile';

// Reuses the shared ~/.claude/bin/gmail helper (read-only IMAP wrapper around
// the email worker's GMAIL_ADDRESS/GMAIL_APP_PASSWORD in
// ~/.claude-email-worker/.env) rather than hand-rolling IMAP — same infra
// every other session uses to read the owner's inbox.
//
// `after:<epochSeconds>` is a real Gmail search operator (X-GM-RAW), applied
// server-side by Gmail itself — not a client-side filter — so a stale email
// from an earlier login attempt can never be returned. Without this, a
// request that reuses WSJ's own OTP (observed live 2026-08-02: a second
// login shortly after a manual one got back the IDENTICAL 8-digit code —
// some OTP backends resend rather than reissue within the validity window)
// would be indistinguishable from a genuinely fresh unread one, and the
// script would falsely "succeed" without proving the read-the-email step
// actually works end to end.
function getOtpCode(sinceEpochSeconds) {
  const searchOut = execSync(
    `${process.env.HOME}/.claude/bin/gmail search "from:(dowjones.com) after:${sinceEpochSeconds}" --days 1 --limit 3 --folder INBOX`,
    { encoding: 'utf8' }
  );
  const uidMatch = searchOut.match(/uid=(\d+)/);
  if (!uidMatch) return null;

  const body = execSync(`${process.env.HOME}/.claude/bin/gmail read ${uidMatch[1]}`, { encoding: 'utf8' });
  const codeMatch = body.match(/>\s*(\d{6,8})\s*<\/h2>/) || body.match(/passcode is:[\s\S]{0,100}?(\d{6,8})/i);
  return codeMatch ? codeMatch[1] : null;
}

async function main() {
  const email = process.env.WSJ_USER || process.env.WSJ_EMAIL;
  if (!email) {
    console.error('ERROR: WSJ_USER or WSJ_EMAIL not set in environment.');
    process.exit(1);
  }

  console.log(`Logging into WSJ as ${email} via one-time passcode...`);

  let pushFailed = false;

  const { chromium } = require('playwright');
  const launchOpts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, { ...launchOpts, channel: 'chrome' });
    console.log('  -> using installed Google Chrome (channel: chrome)');
  } catch (err) {
    console.log(`  -> real Chrome unavailable (${err.message.split('\n')[0]}); falling back to bundled chromium`);
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  }

  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log('Navigating to WSJ login...');
    await page.goto('https://accounts.wsj.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const emailField = await page.getByRole('textbox', { name: /email or username/i });
    await emailField.fill(email);

    const otpButton = page.getByRole('button', { name: /send one-time passcode/i });
    if (!(await otpButton.count())) {
      throw new Error('Send One-Time Passcode button not found — WSJ login page layout may have changed, or a CAPTCHA is blocking the form');
    }
    // Cutoff captured BEFORE the click — every downstream Gmail search is
    // anchored to this instant, so it is structurally impossible to pick up
    // an email that predates this specific OTP request.
    const requestedAtEpochSec = Math.floor(Date.now() / 1000) - 30; // small backdate to absorb clock skew, never enough to reach a prior code's email
    await otpButton.click();

    console.log(`OTP requested at epoch ${requestedAtEpochSec}. Polling Gmail for a NEWER code (up to 90s)...`);
    let code = null;
    for (let attempt = 0; attempt < 18 && !code; attempt++) {
      await page.waitForTimeout(5000);
      try {
        code = getOtpCode(requestedAtEpochSec);
      } catch (e) {
        // gmail helper transient error (e.g. pool saturated) — keep polling
      }
      if (!code) console.log(`  ...no code yet (attempt ${attempt + 1}/18)`);
    }
    if (!code) throw new Error('Could not retrieve a fresh WSJ OTP code from Gmail after 90s');
    console.log(`Got OTP code: ${code}`);

    const otpField = page.getByRole('textbox', { name: /one time passcode/i });
    await otpField.fill(code);

    const submitButton = page.getByRole('button', { name: /submit/i });
    if (await submitButton.count()) {
      await submitButton.click();
    } else {
      await otpField.press('Enter');
    }

    await page.waitForFunction(
      () => !window.location.hostname.includes('dowjones.com'),
      { timeout: 20000 }
    );
    console.log(`Login complete. Landed on: ${page.url()}`);

    const allCookies = await context.cookies();
    const wsjCookies = allCookies.filter(
      c => c.domain.includes('wsj.com') || c.domain.includes('dowjones.com')
    );

    if (wsjCookies.length === 0) {
      throw new Error('No wsj.com/dowjones.com cookies found after login — something went wrong');
    }

    const httpOnlyCount = wsjCookies.filter(c => c.httpOnly).length;
    console.log(`Captured ${wsjCookies.length} cookies (${httpOnlyCount} httpOnly).`);
    if (httpOnlyCount === 0) {
      console.log('WARNING: zero httpOnly cookies captured — login likely did not fully complete.');
    }

    fs.mkdirSync(COOKIE_DIR, { recursive: true });
    fs.writeFileSync(COOKIE_PATH, JSON.stringify(wsjCookies, null, 2) + '\n');

    const nowIso = new Date().toISOString();
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    } catch {}
    meta.wsj = {
      extractedAt: nowIso,
      extractedAtUnix: Math.floor(Date.now() / 1000),
      method: 'otp-login',
    };
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');

    console.log(`Wrote ${wsjCookies.length} cookies to ${COOKIE_PATH}`);

    if (shouldPush && !pushCookiesToGitHubSecret(wsjCookies, meta.wsj)) {
      // Login + local write already succeeded above — a push failure here
      // is a distinct, secondary problem (network/gh-auth), not a login
      // failure. Don't throw: that would make main()'s catch print "FATAL"
      // and exit 1, masking a successful cookie refresh behind what reads
      // as a total failure (the on-call/launchd-log confusion extract-
      // safari-cookies.py avoids by catching per-secret push errors too).
      pushFailed = true;
    }
  } finally {
    await context.close();
  }

  return pushFailed;
}

// Mirrors extract-safari-cookies.py's --push pattern (base64-encoded JSON
// piped into `gh secret set`) but for the single WSJ_COOKIES secret that
// cookie-loader.js's tier-2 individual-env-var fallback already reads —
// bundling WSJ into a COOKIES_BUNDLE_* slot isn't a fit here since those
// bundles are rebuilt from ALL outlets at once by extract-safari-cookies.py,
// not incrementally by a single-outlet script. Returns false (not throw) on
// failure so a push hiccup can't masquerade as a login failure — see caller.
//
// Also pushes a companion WSJ_COOKIES_META secret (base64 JSON
// {extractedAt, extractedAtUnix}) — without it cookie-loader.js's
// selectFresherCookieTier() has no way to know this secret is newer than a
// stale COOKIES_BUNDLE_* wsj entry, and the bundle silently wins forever
// (task #881).
function pushCookiesToGitHubSecret(cookies, meta) {
  console.log('Pushing cookies to GitHub secret WSJ_COOKIES...');
  const base64Val = Buffer.from(JSON.stringify(cookies)).toString('base64');
  try {
    execSync('gh secret set WSJ_COOKIES --repo thomaspryor/Broadwayscore', {
      input: base64Val,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log('Pushed WSJ_COOKIES to GitHub secrets.');
  } catch (err) {
    console.error(`WARNING: failed to push WSJ_COOKIES secret: ${err.message}`);
    console.error('WARNING: local cookie refresh succeeded but CI will keep using the previous secret until this is retried.');
    return false;
  }

  if (meta) {
    const metaBase64 = Buffer.from(JSON.stringify(meta)).toString('base64');
    try {
      execSync('gh secret set WSJ_COOKIES_META --repo thomaspryor/Broadwayscore', {
        input: metaBase64,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      console.log('Pushed WSJ_COOKIES_META to GitHub secrets.');
    } catch (err) {
      console.error(`WARNING: failed to push WSJ_COOKIES_META secret: ${err.message}`);
      console.error('WARNING: WSJ_COOKIES was pushed but freshness comparison against COOKIES_BUNDLE_* will fall back to bundle-wins until this is retried.');
      // Not fatal to the overall push: WSJ_COOKIES itself landed, this only
      // affects tier-selection freshness — same reasoning as the cookie push above.
    }
  }

  return true;
}

main()
  .then(pushFailed => {
    console.log('Done.');
    if (pushFailed) process.exit(2); // login+local write OK, secret push failed — distinct from FATAL
  })
  .catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
