'use strict';

// Checks one Deep Research claim against the page it cites (BRO-5647).
// Deep Research reports attach figures to the wrong show: a $2.3M budget from
// a Sea Wall / A Life article came back as Celebrity Autobiography's, and
// Just in Time's $12.5M as Beaches'. A claim counts only when the cited page
// states it next to this show's title, so a figure lifted from a neighbouring
// paragraph or another show's article fails here. The same rules the apply
// path uses decide it: verifyFigure for money, the recoupment production guard
// for outcomes, and the trusted-host list for whether it can land as reported.
const { verifyFigure, pageText } = require('./commercial-source-verify');
const { buildShowTitleVariants, normalizeForMention } = require('./show-title-variants');
const { checkRecoupmentProduction } = require('./recoupment-production-guard');
const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');

const FIELD_KEYS = { capitalization: 'capitalization', 'weekly running cost': 'weeklyRunningCost' };
const OUTCOME_FIELD = 'outcome for investors';
// Reports name fields loosely; a Form D's offering amount is the capitalization.
const FIELD_ALIASES = {
  capitalization: 'capitalization', sec_offering_amount: 'capitalization',
  'weekly running cost': 'weekly running cost', weekly_running_cost: 'weekly running cost', weeklyrunningcost: 'weekly running cost',
  outcome: OUTCOME_FIELD, 'outcome for investors': OUTCOME_FIELD, outcome_for_investors: OUTCOME_FIELD,
};
const HEDGE_RE = /^(?:up to|nearly|about|roughly|approximately|around|almost|just under|just over|a little over|a little under|~)\s*/i;
// A page this short is a paywall, consent wall or error page, never the article. SEC filings are exempt.
const MIN_ARTICLE_CHARS = 600;
const OUTCOME_WINDOW = 400;
const LOSS_RE = /\b(?:not|never|didn'?t|did not|failed to|without)\b[^.]{0,40}\brecoup|\blos(?:t|ing|es)\b[^.]{0,30}\b(?:investment|capitali[sz]ation|money|capital)\b|\b(?:closed|shuttered) at a (?:total )?loss\b/i;

function hostOf(url) {
  try { const u = new URL(url); return u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : null; } catch { return null; }
}
const isSec = (host) => host === 'sec.gov' || (host || '').endsWith('.sec.gov');

/** Whether the page's source counts as reported for the apply path (commercial-source-verify.js). */
function isTrustedHost(url) {
  const host = hostOf(url);
  return !!host && (isSec(host) || TRUSTED_RECOUPMENT_HOSTS.has(host));
}

/** Whether the claim's quote (or an 8-word run of it, since reports re-punctuate) appears on the page. */
function quoteOnPage(quote, text) {
  const q = normalizeForMention(quote || '');
  if (q.length < 20) return false;
  const t = ` ${normalizeForMention(text)} `;
  if (t.includes(` ${q} `)) return true;
  const words = q.split(' ');
  for (let i = 0; i + 8 <= words.length; i++) if (t.includes(` ${words.slice(i, i + 8).join(' ')} `)) return true;
  return false;
}

/** Recoupment language matching the claim within OUTCOME_WINDOW of a title form. */
function outcomeNearTitle(wantsLoss, text, titles) {
  // Title variants are punctuation-free, so match them across any punctuation in the raw text.
  for (const title of titles) {
    const re = new RegExp(title.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+'), 'gi');
    for (const m of text.matchAll(re)) {
      const around = text.slice(Math.max(0, m.index - OUTCOME_WINDOW), m.index + m[0].length + OUTCOME_WINDOW);
      if (wantsLoss ? LOSS_RE.test(around) : (/recoup/i.test(around) && !LOSS_RE.test(around))) return true;
    }
  }
  return false;
}

/** One dollar figure from a report value ("up to 18000000", "$4.75 million"); null for ranges, bounds and prose. */
function parseMoney(value) {
  if (typeof value === 'number') return value;
  const v = String(value ?? '').trim().replace(HEDGE_RE, '');
  const m = v.match(/^\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(million|m|billion|b|k|thousand)?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  return n * (unit === 'million' || unit === 'm' ? 1e6 : unit === 'billion' || unit === 'b' ? 1e9 : unit === 'k' || unit === 'thousand' ? 1e3 : 1);
}

/** The claim with its field name mapped to the checked names, its money value parsed, and one source URL. */
function normalizeClaim(claim) {
  const field = FIELD_ALIASES[String(claim.field || '').trim().toLowerCase()] || claim.field;
  const url = Array.isArray(claim.source_url) ? claim.source_url.find(Boolean) : claim.source_url;
  const value = FIELD_KEYS[field] ? parseMoney(claim.value) : claim.value;
  return { ...claim, field, value, source_url: url || null, reportedValue: claim.value };
}

// A Form D names the issuing company, not the show, so a figure there is matched to the show by hand.
const secIssuer = (text) => (text.match(/Name of Issuer\s+(.{3,100}?)\s+(?:Jurisdiction|Street Address)/) || [])[1] || null;

const headlines = (page) => [...String(page || '').matchAll(/<(title|h1)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => m[2].replace(/<[^>]+>/g, ' ').trim());

/**
 * Pure. claim: {show, field, value, quote, source_url, source_date}; page: fetched HTML/text, or null when the
 * fetch failed; show: the shows.json record or null.
 * Returns {verdict, reason, trustedHost, quoteFound}. Verdicts:
 *   confirmed | sec-issuer | wrong-context | wrong-production | not-on-page | unreadable | no-source | unmatched-show | not-checkable.
 * Field names and hedged values ("up to $18 million") are normalized first (normalizeClaim).
 */
function classifyClaim(rawClaim, page, show) {
  const claim = rawClaim && normalizeClaim(rawClaim);
  if (!claim || !claim.source_url) return { verdict: 'no-source', reason: 'the report cites no page for this claim' };
  const trustedHost = isTrustedHost(claim.source_url);
  if (!show) return { verdict: 'unmatched-show', reason: `no show in shows.json matches "${claim.show}"`, trustedHost };
  const text = pageText(page);
  if (page == null || (text.length < MIN_ARTICLE_CHARS && !isSec(hostOf(claim.source_url)))) {
    return { verdict: 'unreadable', reason: page == null ? 'the page could not be fetched' : `the page returned only ${text.length} characters (paywall or block)`, trustedHost };
  }
  const titles = buildShowTitleVariants(show.title);
  const quoteFound = quoteOnPage(claim.quote, text);
  const base = { trustedHost, quoteFound };
  const field = FIELD_KEYS[claim.field];
  if (field) {
    if (typeof claim.value !== 'number' || !(claim.value > 0)) return { verdict: 'not-checkable', reason: `"${claim.reportedValue}" is not a single dollar figure`, ...base };
    const year = String(show.openingDate || show.previewsStartDate || '').slice(0, 4) || undefined;
    const hit = verifyFigure(claim.value, page, { titles, year, field });
    if (hit.found) return { verdict: 'confirmed', reason: 'figure stated next to the title', quote: hit.quote, ...base };
    // Say why it failed, so a re-ask can name the problem.
    if (verifyFigure(claim.value, page, { titles, field }).found) return { verdict: 'wrong-production', reason: `figure is next to the title but its year is not ${year} (another production?)`, ...base };
    const issuer = isSec(hostOf(claim.source_url)) ? secIssuer(text) : null;
    if (issuer && verifyFigure(claim.value, page, { field }).found) return { verdict: 'sec-issuer', reason: `SEC filing states the figure for "${issuer}"; match that company to the show by hand`, issuer, ...base };
    if (verifyFigure(claim.value, page, { titles }).found) return { verdict: 'wrong-context', reason: `figure is next to the title but is not described as ${claim.field}`, ...base };
    if (verifyFigure(claim.value, page, {}).found) return { verdict: 'wrong-context', reason: 'figure is on the page but not next to this show (likely another show\'s number)', ...base };
    return { verdict: 'not-on-page', reason: 'the page does not state this figure', ...base };
  }
  if (claim.field === OUTCOME_FIELD) {
    const value = String(claim.value || '');
    const wantsLoss = /not|never|loss|lost|fail/i.test(value);
    if (!wantsLoss && !/recoup/i.test(value)) return { verdict: 'not-checkable', reason: `outcome "${value}" is neither recouped nor a loss`, ...base };
    if (!wantsLoss) {
      const dateMatch = value.match(/\b(\d{4}(?:-\d{2})?)\b/);
      const guard = checkRecoupmentProduction({ show, url: claim.source_url, recoupedDate: dateMatch ? dateMatch[1] : undefined, publishedDate: claim.source_date || undefined, headlines: headlines(page) });
      if (!guard.ok) return { verdict: 'wrong-production', reason: guard.reason, ...base };
    }
    if (outcomeNearTitle(wantsLoss, text, titles)) return { verdict: 'confirmed', reason: `${wantsLoss ? 'loss' : 'recoupment'} language next to the title`, ...base };
    return { verdict: quoteFound ? 'wrong-context' : 'not-on-page', reason: `no ${wantsLoss ? 'loss' : 'recoupment'} language next to this show on the page`, ...base };
  }
  return { verdict: 'not-checkable', reason: `field "${claim.field}" has no automatic check`, ...base };
}

module.exports = { classifyClaim, normalizeClaim, parseMoney, quoteOnPage, isTrustedHost, MIN_ARTICLE_CHARS };
