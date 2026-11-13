/**
 * Kick the Browserbase Talkin' Broadway collector when a TB review is stuck (BRO-7442).
 *
 * talkinbroadway.com sits behind a Cloudflare managed challenge that Bright Data,
 * ScrapingBee and Playwright mostly fail. A TB review found by google-news-rss has no
 * byline, so it lands in _pending/ and only the byline replay (which uses those same
 * blocked tiers) could promote it. The Kings Critique (2026-11-12): stub created 10:25pm
 * ET, every replay fetch failed, a lucky Bright Data hit promoted it at 1:01am, live
 * 1:54am. collect-talkinbroadway-index.js reads TB through Browserbase and ingests the
 * review, but ran once a day (15:17 UTC). The poller now dispatches it as soon as a TB
 * stub is stuck, bounded so it cannot eat the Browserbase allowance (8/day).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const COLLECTOR_WORKFLOW = 'collect-talkinbroadway-index.yml';
const DEFAULTS = Object.freeze({ maxAgeHours: 12, minGapMin: 15, dailyCap: 6 });

/** Pure: is this _pending record a Talkin' Broadway review we have no text for? */
function isStuckTbStub(data, nowMs, maxAgeHours = DEFAULTS.maxAgeHours) {
  if (!data || typeof data !== 'object') return false;
  if (data.outletId !== 'talkinbroadway' && !/talkinbroadway\.com/i.test(String(data.url || ''))) return false;
  if (typeof data.fullText === 'string' && data.fullText.trim()) return false; // has a body
  if (data.rssIdentityRejected || data.promoteSkippedReason) return false;      // judged not a review
  const seen = Date.parse(data.firstSeenAt || '');
  if (!Number.isFinite(seen) || nowMs - seen > maxAgeHours * 3600e3) return false; // old or undated: the daily run owns it (bounds Browserbase spend)
  return true;
}

/** Stuck TB stubs under root/_pending/{showId} for the given shows. */
function findStuckTbStubs(root, showIds, { now = new Date(), maxAgeHours = DEFAULTS.maxAgeHours } = {}) {
  const out = [];
  for (const showId of showIds) {
    const dir = path.join(root, '_pending', showId);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.startsWith('talkinbroadway--') && f.endsWith('.json')); } catch { continue; }
    for (const file of files) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (isStuckTbStub(data, now.getTime(), maxAgeHours)) out.push({ showId, file, url: data.url || null });
    }
  }
  return out;
}

/**
 * Pure: dispatch the collector? `runs` = recent collector runs [{status, createdAt}].
 * Never while one is queued/running (the workflow's concurrency group would just queue it),
 * not within minGapMin of the last, and not past dailyCap runs in 24h (Browserbase allowance).
 */
function decideKick({ stuck, runs, now = new Date(), minGapMin = DEFAULTS.minGapMin, dailyCap = DEFAULTS.dailyCap }) {
  if (!stuck || stuck.length === 0) return { kick: false, reason: 'no stuck Talkin Broadway stub' };
  const list = Array.isArray(runs) ? runs : [];
  if (list.some((r) => r.status === 'queued' || r.status === 'in_progress' || r.status === 'waiting' || r.status === 'pending')) {
    return { kick: false, reason: 'collector already queued or running' };
  }
  const nowMs = now.getTime();
  const times = list.map((r) => Date.parse(r.createdAt)).filter(Number.isFinite);
  if (times.some((t) => nowMs - t < minGapMin * 60e3)) return { kick: false, reason: `collector ran within ${minGapMin} min` };
  const last24 = times.filter((t) => nowMs - t < 24 * 3600e3).length;
  if (last24 >= dailyCap) return { kick: false, reason: `${last24} collector runs in 24h (cap ${dailyCap}, Browserbase allowance)` };
  return { kick: true, reason: `${stuck.length} stuck Talkin Broadway stub(s)` };
}

module.exports = { COLLECTOR_WORKFLOW, DEFAULTS, isStuckTbStub, findStuckTbStubs, decideKick };
