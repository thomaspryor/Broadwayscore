'use strict';
/**
 * BRO-6687: "listed but not live" for the slow markets (off-Broadway, West End,
 * off-West End). Their reviews trickle in for two weeks and no aggregator roundup
 * resolves them, so the 3-day Broadway roundup-gap alert never reached them: on
 * Martin Guerre 2026 a review a West End roundup source cited sat uncollected
 * for 11 days while only a digest line fired.
 *
 * Counts only rows a source actually cited (never SERP-census hits, which are
 * unverified search results) and only automated exclusions a current round-up
 * lists (reverify), so census junk and settled exclusions cannot hold the
 * alert open. Shared by audit-show-review-gap.js (alert) and slow-market-grade.js.
 */
const { currentRunOnly } = require('./prior-production-citations');

const SLOW_MARKETS = new Set(['off-broadway', 'west-end', 'off-west-end']);
const SLOW_MARKET_ALERT_DAYS = 21; // the audit's own opening window (audit-show-review-gap.js --window default)

/**
 * @param {object} r - one show-review-gap.json result row
 * @returns {{residual:number, failedIngest:number, capped:number, uningested:number, flaggedOut:number, conflictIngest:number, rows:object[]}}
 *   rows = the cited missing rows + reverify rows still not live, for the alert body
 */
function slowMarketListedGap(r) {
  const landed = new Set((r.ingestResults || []).filter(x => x && x.ok).map(x => x.url));
  const tried = new Set((r.ingestResults || []).map(x => x && x.url));
  const capped = new Set((r.ingestSkippedByCap || []).map(x => x && x.url));
  const cited = currentRunOnly(r.missing).filter(m => m && !m.serpCensus && !landed.has(m.url));
  const reverify = currentRunOnly(r.flaggedMisses).filter(m => m && m.reverify === true && !m.serpCensus);
  const counts = {
    failedIngest: cited.filter(m => tried.has(m.url)).length,
    capped: cited.filter(m => capped.has(m.url)).length,
    uningested: cited.filter(m => !tried.has(m.url) && !capped.has(m.url)).length,
    flaggedOut: reverify.length,
    conflictIngest: 0,
  };
  return { residual: cited.length + reverify.length, ...counts, rows: [...cited, ...reverify] };
}

/** True when the show is a slow-market opening inside the alert window. */
function inSlowMarketWindow(r, now = Date.now()) {
  if (!r || !SLOW_MARKETS.has(r.category)) return false;
  const opened = r.openingDate ? Date.parse(r.openingDate) : NaN;
  return Number.isFinite(opened) && opened <= now && now - opened <= SLOW_MARKET_ALERT_DAYS * 86400000;
}

module.exports = { slowMarketListedGap, inSlowMarketWindow, SLOW_MARKETS, SLOW_MARKET_ALERT_DAYS };
