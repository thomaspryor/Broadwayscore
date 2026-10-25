'use strict';

/**
 * cookie-consent.js — dismiss GDPR/consent banners in a Playwright page so the
 * scraper reads the actual article instead of the consent wall.
 *
 * Why this exists: consent-walled sites (whatsonstage.com is the repeat
 * offender — Sinatra 2026-06-25, Much Ado + Misanthrope 2026-06-28) render a
 * cookie/consent overlay whose text is all the scraper sees. The content
 * verifier then correctly calls that "not a review" and the REAL review gets
 * flagged wrongShow/not_a_review and dropped. fetchWithPlaywright had no consent
 * handling, so the same false-positive recurred every opening for these outlets.
 *
 * SAFETY (ship-check, Codex 2026-06-28): this runs on EVERY Playwright fetch
 * corpus-wide, so a WRONG click (a newsletter / "terms update" modal that
 * happens to say "Accept") would navigate away and make us scrape the wrong
 * page — worse than the consent wall it fixes. Two guards:
 *   1. Selectors are CONSENT-SPECIFIC only: known consent-platform IDs, or text
 *      containing the word "cookie(s)" (newsletter/terms modals don't). The bare
 *      "I Accept" / "Agree and continue" / "Yes, I agree" matches were removed.
 *   2. Navigation guard: record the URL before clicking; if the click navigated
 *      off the page, log a warning and return navigatedAway=true so the caller
 *      treats it as a FAILED dismissal, not silent success.
 *
 * Also: locator.isVisible({timeout}) returns IMMEDIATELY (does not wait), so
 * late-rendered CMPs were being missed. waitForBanner() polls until a consent
 * selector mounts (short cap) before the click.
 *
 * The selector LIST is exported so it can be unit-tested without a browser.
 */

// Consent-platform-specific selectors + text that explicitly says "cookie(s)".
// Deliberately NOT bare "Accept"/"Agree"/"I Accept" — those can match a
// newsletter or terms modal on a review page (Codex finding).
const CONSENT_ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler',                          // OneTrust
  'button#onetrust-accept-btn-handler',
  '.qc-cmp2-summary-buttons button[mode="primary"]',       // Quantcast Choice
  '#didomi-notice-agree-button',                           // Didomi
  'button#truste-consent-button',                          // TrustArc
  'button[aria-label="Agree and close"]',                  // Sourcepoint consent frame
  // Sourcepoint CMP message component — container-scoped to .message-component
  // (a consent-platform class), so the "Accept" title is safe (not a bare global
  // Accept). This is the selector that dismisses whatsonstage.com's banner.
  '.message-component.message-button[title*="Accept" i]',
  'button[aria-label*="accept all cookies" i]',
  'button[title*="accept all cookies" i]',
  'button:has-text("Accept all cookies")',
  'button:has-text("Accept All Cookies")',
  'button:has-text("Accept Cookies")',
  'button:has-text("Allow all cookies")',
];

/**
 * Wait briefly for ANY consent selector to mount (CMPs often render a few
 * hundred ms after goto). Returns the first selector that became visible, or
 * null after the cap. Never throws. isVisible() returns immediately, hence the
 * poll loop rather than a single timed isVisible.
 * @param {object} page
 * @param {number} [capMs=2500]
 * @returns {Promise<string|null>}
 */
async function waitForBanner(page, capMs = 2500) {
  const deadline = Date.now() + capMs;
  // Always do at least one pass even if capMs is 0 (tests).
  do {
    for (const sel of CONSENT_ACCEPT_SELECTORS) {
      try {
        if (await page.locator(sel).first().isVisible()) return sel;
      } catch (_) { /* frame churn — keep polling */ }
    }
    if (Date.now() >= deadline) break;
    try { await page.waitForTimeout(150); } catch (_) { break; }
  } while (Date.now() < deadline);
  return null;
}

/**
 * Best-effort: dismiss a consent banner in the given Playwright page.
 * @param {object} page  Playwright Page
 * @param {object} [opts]
 * @param {number} [opts.waitMs=2500]  cap for waiting for a banner to appear
 * @param {Console} [opts.log=console]
 * @returns {Promise<{clicked:string|null, navigatedAway:boolean}>}
 */
async function dismissConsent(page, opts = {}) {
  const log = opts.log || console;
  const sel = await waitForBanner(page, opts.waitMs);
  if (!sel) return { clicked: null, navigatedAway: false };

  let urlBefore = null;
  try { urlBefore = page.url(); } catch (_) {}

  try {
    await page.locator(sel).first().click({ timeout: 2000 });
  } catch (_) {
    return { clicked: null, navigatedAway: false };
  }

  // Let the overlay tear down / article re-flow.
  try { await page.waitForTimeout(500); } catch (_) {}

  // Navigation guard: a consent-accept must NOT change the page. If it did, we
  // likely clicked the wrong control — flag it so the caller doesn't trust the
  // resulting (possibly unrelated) content.
  let urlAfter = null;
  try { urlAfter = page.url(); } catch (_) {}
  const navigatedAway = !!(urlBefore && urlAfter && stripHash(urlAfter) !== stripHash(urlBefore));
  if (navigatedAway) {
    if (log && typeof log.warn === 'function') {
      log.warn(`  ⚠️  consent click navigated away (${urlBefore} → ${urlAfter}) — treating as failed dismissal`);
    }
    return { clicked: sel, navigatedAway: true };
  }
  return { clicked: sel, navigatedAway: false };
}

function stripHash(u) {
  try { const x = new URL(u); x.hash = ''; return x.toString(); } catch { return u; }
}

module.exports = { dismissConsent, waitForBanner, CONSENT_ACCEPT_SELECTORS };
