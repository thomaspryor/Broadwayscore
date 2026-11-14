'use strict';

const { sbHostVerdict, normalizeSbHost, readLedgerTail } = require('./reddit-dispatch-cooldown');

// BRO-5917: shared by fetchPage, fetchJSON and the review-text collector.
// Refresh at most once a minute; live outcomes immediately re-arm failed probes.
function createSbHostCooldown({ readRows = readLedgerTail, now = Date.now, env = process.env } = {}) {
  let loadedAt = -Infinity;
  let ledgerPath;
  let rows = [];
  const pendingProbes = new Set();

  function hostOf(url) {
    try {
      const target = new URL(url);
      return ['http:', 'https:'].includes(target.protocol) ? normalizeSbHost(target.hostname) : null;
    } catch { return null; }
  }

  function consult(url) {
    const host = hostOf(url);
    // Null-host 400s are invalid requests, not evidence about every other host.
    // Validation stays on even when the cooldown kill switch is set.
    if (!host) return { allowed: false, probe: false, reason: 'invalid SB target URL' };
    if (env.SB_HOST_COOLDOWN_DISABLED === '1' ||
        (host === 'reddit.com' && env.REDDIT_SB_COOLDOWN_DISABLED === '1')) {
      return { allowed: true, probe: false, reason: 'SB host cooldown disabled' };
    }
    const nowMs = now();
    if (nowMs - loadedAt >= 60e3 || ledgerPath !== env.SCRAPER_SPEND_LEDGER_PATH) {
      rows = readRows().slice();
      loadedAt = nowMs;
      ledgerPath = env.SCRAPER_SPEND_LEDGER_PATH;
    }
    if (pendingProbes.has(host)) return { allowed: false, probe: false, reason: 'SB host probe already in flight' };
    const verdict = sbHostVerdict(rows, { host, nowMs });
    if (verdict.probe) pendingProbes.add(host);
    return verdict;
  }

  function record(url, success) {
    const host = hostOf(url);
    pendingProbes.delete(host);
    if (host) rows.push({ provider: 'scrapingbee', host, ts: new Date(now()).toISOString(), success });
  }

  return { consult, record };
}

const sbHostCooldown = createSbHostCooldown();
module.exports = { createSbHostCooldown, sbHostCooldown };
