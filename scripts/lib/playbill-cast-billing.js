'use strict';

const cheerio = require('cheerio');

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
  return names;
}

/**
 * Apply a saved production page only when its canonical URL matches the
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
  if (!names.length || JSON.stringify(names) === JSON.stringify(show.castBilling)) return false;
  show.castBilling = names;
  return true;
}

module.exports = { extractPlaybillCastBilling, enrichCastBilling };
