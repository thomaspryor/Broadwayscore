'use strict';

const cheerio = require('cheerio');

const surname = (n) => n.trim().split(/\s+/).pop().toLowerCase();

/**
 * Long-runners' Playbill 'Cast Current' tab lists everyone alphabetically by
 * surname, not in billing order (hamilton-2015, book-of-mormon-2011, ...; BRO-6746).
 * Four or more names already sorted by surname are treated as unbilled so a
 * Reddit post never names an alphabetical "first four".
 */
function isAlphabeticalBySurname(names) {
  if (!Array.isArray(names) || names.length < 4) return false;
  const keys = names.map(surname);
  return keys.every((k, i) => i === 0 || keys[i - 1].localeCompare(k, 'en') <= 0);
}

/**
 * Preserve Playbill's displayed current-cast order. Opening-night cast,
 * production credits, related articles and headshot links are separate lists.
 * Fail closed on missing/changed markup instead of treating all person links
 * on the page as billed performers. Names come from visible text, never URLs.
 */
function extractPlaybillCastBilling(html) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const $ = cheerio.load(html);
  const currentCast = $('[data-nav-title]').filter((_, el) => {
    const label = cheerio.load($(el).attr('data-nav-title')).text();
    return /^Cast\s+Current$/i.test(label.trim());
  }).first();
  const names = [];
  const seen = new Set();
  currentCast.find('.bsp-list-promo-title a').each((_, el) => {
    const name = $(el).text().replace(/\s+/g, ' ').trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  });
  return isAlphabeticalBySurname(names) ? [] : names;
}

/**
 * Apply a production page only when its canonical URL matches the
 * existing data/playbill-urls.json entry. This compares source identity; it
 * does not infer any production metadata from a URL. The current tab must
 * never supply the cast of a closed/historical production.
 * Returns whether the record changed, so billing-only updates get persisted.
 */
function enrichCastBilling(show, html, playbillUrl, { force = false } = {}) {
  if (!['open', 'previews'].includes(show.status)) return false;
  if (show.castBilling?.length && !force) return false;
  if (typeof html !== 'string' || !html.trim() || !playbillUrl) return false;
  const $ = cheerio.load(html);
  if ($('link[rel="canonical"]').attr('href') !== playbillUrl) return false;
  const names = extractPlaybillCastBilling(html);
  return enrichCastBillingFromSnapshot(show, { names, sourceUrl: playbillUrl }, playbillUrl, { force });
}

/**
 * The scheduled cast scraper persists validated billing in cast-changes.json.
 * Rebuild enrichment copies it into shows.json through shows-write-guard.
 * Recheck status and source identity here because either can change between runs.
 *
 * Copied billing is stamped with `castBillingSource` (the Playbill URL it came
 * from). A non-forced run refreshes billing it copied itself when the snapshot
 * changes (a cast replacement), but never overwrites billing without that stamp
 * (hand-entered) or stamped with another source. Billing copied before the
 * stamp existed is adopted only when it still equals the current snapshot, so
 * the next change after that refreshes it (BRO-6678).
 */
function billingHash(names) {
  return require('crypto').createHash('sha1').update(JSON.stringify(names)).digest('hex').slice(0, 12);
}

function enrichCastBillingFromSnapshot(show, snapshot, playbillUrl, { force = false } = {}) {
  if (!['open', 'previews'].includes(show.status)) return false;
  if (!playbillUrl || snapshot?.sourceUrl !== playbillUrl) return false;
  const names = snapshot.names;
  if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !name.trim())) return false;
  if (isAlphabeticalBySurname(names)) {
    // Self-heal billing this pipeline copied before the guard existed (stamped
    // with this Playbill URL); never touch hand-entered billing.
    if (show.castBillingSource === playbillUrl && isAlphabeticalBySurname(show.castBilling)) {
      delete show.castBilling;
      delete show.castBillingSource;
      delete show.castBillingHash;
      return true;
    }
    return false;
  }
  const hasBilling = Array.isArray(show.castBilling) && show.castBilling.length > 0;
  const same = JSON.stringify(names) === JSON.stringify(show.castBilling);
  const fromThisSnapshot = show.castBillingSource === playbillUrl;
  if (hasBilling && !force && !fromThisSnapshot) {
    // Legacy unstamped copy that still matches: adopt it so later changes refresh.
    if (same && show.castBillingSource === undefined) {
      show.castBillingSource = playbillUrl;
      show.castBillingHash = billingHash(names);
      return true;
    }
    return false;
  }
  if (same && fromThisSnapshot) {
    if (show.castBillingHash === undefined) show.castBillingHash = billingHash(names);
    return false;
  }
  if (!force && hasBilling && fromThisSnapshot) {
    // Hand correction of stamped billing: the fingerprint no longer matches, keep it.
    if (show.castBillingHash !== undefined && show.castBillingHash !== billingHash(show.castBilling)) return false;
    // Implausible shrink (markup change, partial page): needs --force.
    if (names.length < 2 || names.length < show.castBilling.length / 2) return false;
  }
  show.castBilling = [...names];
  show.castBillingSource = playbillUrl;
  show.castBillingHash = billingHash(names);
  return true;
}

module.exports = { isAlphabeticalBySurname, extractPlaybillCastBilling, enrichCastBilling, enrichCastBillingFromSnapshot };
