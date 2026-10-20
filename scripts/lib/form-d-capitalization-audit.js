/**
 * form-d-capitalization-audit.js (BRO-5732, root cause of BRO-5521/5527/5647/5660)
 *
 * A Form D's totalOfferingAmount is the MOST the LLC may raise; the raise is
 * totalAmountSold (or a clarification such as "Offering capitalized at $X").
 * About nine shows had the maximum stored as their capitalization and were
 * corrected by hand. This is the pure decision the audit script applies to
 * every commercial.json record that cites a Form D.
 *
 * A record is fine when it prints as a ceiling (capitalizationBasis
 * 'maximum', i.e. "up to $X") or when its figure is not the filing's maximum.
 * It is flagged when its capitalization EQUALS a cited filing's maximum, it is
 * not tagged 'maximum', and that filing shows a smaller raise.
 */
'use strict';

const { isMaximumCapitalization } = require('./public-source-text');

const SEC_ARCHIVE_RE = /^https?:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[^\s"')]*\.xml$/i;

/**
 * Form D XML urls a record cites (sources[] and capitalizationSource text).
 * The browser rendering path (xslFormDX01/) is mapped to the raw primary_doc.xml.
 * @param {{sources?: Array<{url?: string}>, capitalizationSource?: string}} entry
 * @returns {string[]}
 */
function formDXmlUrls(entry) {
  const urls = new Set();
  const found = [
    ...((entry && entry.sources) || []).map((s) => s && s.url),
    ...(String((entry && entry.capitalizationSource) || '').match(/https?:\/\/[^\s"')]+/g) || []),
  ];
  for (const raw of found) {
    const url = String(raw || '').replace(/\/xslFormDX\d+\//i, '/').replace(/[.,;]+$/, '');
    if (SEC_ARCHIVE_RE.test(url)) urls.add(url);
  }
  return [...urls];
}

/**
 * @param {{capitalization?: number|null, capitalizationBasis?: string|null, capitalizationSource?: string|null}} entry
 * @param {Array<{totalOfferingAmount: number|null, amountSold: number|null, capitalizedAmount: number|null}>} filings parsed cited filings
 * @returns {{status: 'ok'|'maximum-as-fact', raised?: number, maximum?: number, reason: string}}
 */
function classifyFormDCapitalization(entry, filings) {
  const cap = entry && entry.capitalization;
  if (cap == null) return { status: 'ok', reason: 'no capitalization' };
  if (isMaximumCapitalization(entry)) return { status: 'ok', reason: 'prints as a ceiling' };
  // A trade-press page that states the capitalization is the primary source; the
  // filing only corroborates it (the-bands-visit-2017: $8.75M per Broadway News,
  // Form D filed early with $2.46M sold).
  const cited = String(entry.capitalizationSource || '').match(/https?:\/\/[^\s"')]+/g) || [];
  // applyFigureEvidence writes the source as `host: "quote"` with no URL.
  const hostPrefix = /^\s*(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+):\s*"/i.exec(String(entry.capitalizationSource || ''));
  if (cited.some((u) => !/sec\.gov/i.test(u)) || (hostPrefix && !/sec\.gov$/i.test(hostPrefix[1]))) return { status: 'ok', reason: 'figure is attributed to a non-SEC source' };
  for (const f of filings || []) {
    const max = f && f.totalOfferingAmount;
    if (!max || cap !== max) continue;
    const raised = [f.capitalizedAmount, f.amountSold].find((v) => typeof v === 'number' && v > 0 && v < max);
    if (raised != null) {
      return { status: 'maximum-as-fact', raised, maximum: max, reason: `capitalization equals the Form D maximum $${max.toLocaleString('en-US')} but the filing shows $${raised.toLocaleString('en-US')} raised` };
    }
  }
  return { status: 'ok', reason: 'figure is not a cited filing maximum' };
}

module.exports = { formDXmlUrls, classifyFormDCapitalization };
