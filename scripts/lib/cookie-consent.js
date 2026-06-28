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
 * Strategy: best-effort. Try a prioritized list of accept-button selectors
 * (common consent platforms: OneTrust, Quantcast/Sourcepoint, Didomi, TrustArc,
 * plus generic "Accept all" text). Click the first that's visible, with short
 * timeouts. NEVER throw — a missing banner or a click failure must not break the
 * fetch; we just proceed with whatever rendered.
 *
 * The selector LIST is exported so it can be unit-tested without a browser.
 */

// Ordered most-specific → most-generic. Text matches are case-insensitive via
// Playwright's :has-text. Kept tight to avoid clicking "Accept terms" on a
// signup form etc. — these are all consent-platform-specific or the canonical
// "Accept all cookies" phrasings.
const CONSENT_ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler',                         // OneTrust
  'button#onetrust-accept-btn-handler',
  '.qc-cmp2-summary-buttons button[mode="primary"]',      // Quantcast Choice
  'button[title="Accept all"]',
  'button[aria-label="Accept all"]',
  'button[aria-label="Agree and close"]',                 // Sourcepoint
  '.message-component.message-button[title*="Accept" i]', // Sourcepoint generic
  '#didomi-notice-agree-button',                          // Didomi
  'button#truste-consent-button',                         // TrustArc
  'button:has-text("Accept all cookies")',
  'button:has-text("Accept All Cookies")',
  'button:has-text("Accept all")',
  'button:has-text("I Accept")',
  'button:has-text("Agree and continue")',
  'button:has-text("Yes, I agree")',
];

/**
 * Best-effort: dismiss a consent banner in the given Playwright page.
 * @param {object} page  Playwright Page
 * @param {object} [opts]
 * @param {number} [opts.perSelectorTimeout=1200]  ms to wait for each selector
 * @param {Console} [opts.log=console]
 * @returns {Promise<string|null>}  the selector that was clicked, or null
 */
async function dismissConsent(page, opts = {}) {
  const timeout = opts.perSelectorTimeout || 1200;
  for (const sel of CONSENT_ACCEPT_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout })) {
        await loc.click({ timeout });
        // Let the overlay tear down and the article re-flow.
        try { await page.waitForTimeout(400); } catch (_) {}
        return sel;
      }
    } catch (_) {
      // Selector not present / not clickable / frame detached — try the next.
    }
  }
  return null;
}

module.exports = { dismissConsent, CONSENT_ACCEPT_SELECTORS };
