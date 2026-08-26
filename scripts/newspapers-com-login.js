#!/usr/bin/env node

/**
 * Time-boxed experiment (Linear BRO-137, access lapses 2026-08-27): does a
 * real authenticated Playwright browser session beat newspapers.com's
 * viewer, the way task #779's WSJ OTP breakthrough beat WSJ's paywall?
 *
 * newspapers.com was previously written off as "unautomatable" (see
 * memory/reference_paywall_subscriptions_status.md) on the assumption that
 * the page-image *viewer* blocks all tiers regardless of login state. That
 * assumption predates the OTP-login infra this task is reusing
 * (scripts/lib/otp-login-helpers.js, scripts/wsj-otp-login.js), so it was
 * worth re-testing with a real logged-in session instead of a bare fetch.
 *
 * Recon done 2026-08-26 WITHOUT credentials (none exist in .env, and no
 * password is recoverable from Gmail) already narrows the question:
 *   - https://www.newspapers.com/signin/ loads fine headless (200, real
 *     email+password fields) — no anti-bot wall at the login form itself.
 *   - A logged-OUT search (e.g. "A Chorus Line" 1975, NY) reports a match
 *     count (243) but renders a `MarketingResults_*` free-trial upsell page
 *     with ZERO page-image or clipping links — the entire results list is
 *     paywalled, not just the viewer.
 * So the open question this script answers is narrower than "can we OCR
 * the viewer" — it's "does AUTHENTICATION unlock real result links at all,
 * and if so, does the viewer then render an image (screenshot-able) or a
 * further-gated preview." That can only be tested with real credentials,
 * which this session (headless, no owner in the loop) does not have.
 *
 * This script implements the login + extraction pipeline so a session WITH
 * credentials (owner runs this locally, or pastes NEWSPAPERS_COM_PASSWORD
 * into the env before dispatching) can complete the experiment before the
 * 2026-08-27 cutoff. It is not expected to succeed unattended.
 *
 * Flow:
 *   1. Real Chrome (via launchOtpBrowser, headed) logs in with
 *      NEWSPAPERS_COM_EMAIL/NEWSPAPERS_COM_PASSWORD.
 *   2. Loads each target page URL (a specific newspaper page, not a search
 *      results page — search itself is paywalled per the recon above).
 *   3. Checks the DOM for a real embedded text layer (some viewers ship
 *      OCR'd text hidden behind the image for copy/search) before falling
 *      back to a screenshot.
 *   4. Screenshots the viewer canvas/image and runs it through tesseract
 *      (macOS `tesseract` CLI, confirmed installed) for a same-machine OCR
 *      quality baseline — no macOS Vision/Shortcuts dependency, which
 *      would not be scriptable headless anyway.
 *   5. Writes one JSON verdict file per page (image URL/text-layer presence/
 *      OCR text length/output path) to data/newspapers-com-test/ for manual
 *      quality grading against the acceptance criteria in BRO-137.
 *
 * Usage:
 *   NEWSPAPERS_COM_EMAIL=... NEWSPAPERS_COM_PASSWORD=... \
 *     node scripts/newspapers-com-login.js [pageUrl1] [pageUrl2] [pageUrl3]
 *
 * With no URLs given, uses TARGET_PAGES below — placeholders, since finding
 * the real /image/ URLs for specific 1970s-80s Broadway reviews itself
 * requires being logged in (see recon note above) and could not be done in
 * this unattended run.
 *
 * Requires: NEWSPAPERS_COM_EMAIL (or OWNER_EMAIL) + NEWSPAPERS_COM_PASSWORD
 * in the shell env. Local/headed only — do not run in CI.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchOtpBrowser } = require('./lib/otp-login-helpers');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'data', 'newspapers-com-test');
const PROFILE_DIR = '/tmp/newspapers-com-login-browser-profile';

// Placeholder targets — replace with real /image/NNNNNNNN/ URLs found via a
// logged-in search once credentials are available (logged-out search is
// paywalled, see header note).
const TARGET_PAGES = [];

function log(msg) {
  console.log(`[newspapers-com-login] ${msg}`);
}

async function login(page, email, password) {
  log('Navigating to sign-in page...');
  await page.goto('https://www.newspapers.com/signin/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  const emailField = page.locator('input[type="email"], input[name*="email" i], input[name*="username" i]').first();
  const passField = page.locator('input[type="password"]').first();

  if (!(await emailField.count()) || !(await passField.count())) {
    throw new Error('Sign-in form fields not found — page layout may have changed, or an anti-bot wall replaced the form');
  }

  await emailField.fill(email);
  await passField.fill(password);

  const submitButton = page.locator('button[type="submit"], button:has-text("Sign in")').first();
  if (await submitButton.count()) {
    await submitButton.click();
  } else {
    await passField.press('Enter');
  }

  await page.waitForTimeout(5000);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/incorrect|invalid (email|password)|captcha|verify you.re human/i.test(bodyText)) {
    throw new Error(`Login appears to have failed — page text matched a failure pattern: "${bodyText.slice(0, 200)}"`);
  }

  const cookies = await page.context().cookies();
  const authCookies = cookies.filter(c => c.domain.includes('newspapers.com') && c.httpOnly);
  log(`Post-login: ${cookies.length} total cookies, ${authCookies.length} httpOnly newspapers.com cookies.`);
  if (authCookies.length === 0) {
    throw new Error('No httpOnly newspapers.com auth cookies after login — login likely did not complete');
  }
  return authCookies;
}

async function extractPage(page, url, index) {
  log(`Loading page ${index + 1}: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2000);

  const result = { url, hasTextLayer: false, textLayerSample: null, screenshotPath: null, ocrTextLength: 0, ocrTextPath: null, error: null };

  try {
    // Some page-image viewers ship a hidden OCR'd text layer for copy/search.
    const textLayer = await page.locator('[class*="text-layer" i], [class*="ocr" i], .textLayer').allInnerTexts().catch(() => []);
    const joined = textLayer.join(' ').trim();
    if (joined.length > 40) {
      result.hasTextLayer = true;
      result.textLayerSample = joined.slice(0, 300);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const screenshotPath = path.join(OUT_DIR, `page-${index + 1}.png`);
    const viewerImage = page.locator('canvas, [class*="viewer" i] img, [class*="page-image" i]').first();
    if (await viewerImage.count()) {
      await viewerImage.screenshot({ path: screenshotPath });
    } else {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }
    result.screenshotPath = screenshotPath;

    const ocrOutBase = path.join(OUT_DIR, `page-${index + 1}-ocr`);
    execFileSync('tesseract', [screenshotPath, ocrOutBase], { stdio: 'pipe' });
    const ocrText = fs.readFileSync(`${ocrOutBase}.txt`, 'utf8');
    result.ocrTextLength = ocrText.trim().length;
    result.ocrTextPath = `${ocrOutBase}.txt`;
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

async function main() {
  const email = process.env.NEWSPAPERS_COM_EMAIL || process.env.OWNER_EMAIL;
  const password = process.env.NEWSPAPERS_COM_PASSWORD;
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : TARGET_PAGES;

  if (!email) {
    console.error('ERROR: NEWSPAPERS_COM_EMAIL (or OWNER_EMAIL) not set in environment.');
    process.exit(1);
  }
  if (!password) {
    console.error('ERROR: NEWSPAPERS_COM_PASSWORD not set in environment.');
    console.error('No password is recoverable from .env or Gmail — this must be supplied by the owner.');
    console.error('Recon already done without login (see script header): the sign-in form is reachable');
    console.error('and un-walled, but logged-out search results are a paywalled marketing page with no');
    console.error('page-image links, so the viewer itself cannot be reached or graded without real creds.');
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error('ERROR: no target page URLs given (TARGET_PAGES is empty and none passed as argv).');
    console.error('Real /image/ URLs for specific historical reviews require a logged-in search to find —');
    console.error('pass them as CLI args once found: node scripts/newspapers-com-login.js <url1> <url2> <url3>');
    process.exit(1);
  }

  log(`Logging into newspapers.com as ${email}...`);
  const context = await launchOtpBrowser(PROFILE_DIR);
  const page = context.pages()[0] || (await context.newPage());

  const results = [];
  try {
    await login(page, email, password);
    log('Login succeeded.');

    for (let i = 0; i < targets.length; i++) {
      const result = await extractPage(page, targets[i], i);
      results.push(result);
      log(`Page ${i + 1}: textLayer=${result.hasTextLayer} ocrChars=${result.ocrTextLength} error=${result.error || 'none'}`);
    }
  } finally {
    await context.close();
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const verdictPath = path.join(OUT_DIR, 'verdict.json');
  fs.writeFileSync(verdictPath, JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2) + '\n');
  log(`Wrote ${verdictPath}`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
