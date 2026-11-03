'use strict';
/**
 * scraper-usage-parse.js — pure parser for [SD Call] / [BD Call] / [SB Call]
 * telemetry lines, extracted from measure-scraper-usage.js (BRO-6898) so it is
 * unit-testable.
 *
 * run-memo-skip rows (scraper.js _recordRunMemo) are bookkeeping, not provider
 * calls: zero credits, success:false. Counting them as requests inflated call
 * counts and deflated success rates (the 2026-11-03 cost monitor blamed them
 * for ScrapingBee's low success rate; the ledger showed they were 0.4% of rows,
 * but they still must not be counted as calls). They are tallied in `skips`.
 */

const TAGS = { '[SD Call]': 'scrapingdog', '[BD Call]': 'brightdata', '[SB Call]': 'scrapingbee' };

function isMemoSkip(rec) {
  // A skip row that carries credits is billing activity, not bookkeeping: keep it
  // counted so a future bug that logs spend under this sentinel cannot hide.
  return !!rec && (rec.fn === 'run-memo-skip' || rec.status === 'run-memo-skip') && !(rec.credits > 0);
}

function parse(lines) {
  const prov = {
    scrapingdog: { reqs: 0, ok: 0, credits: 0, skips: 0, hosts: {} },
    brightdata: { reqs: 0, ok: 0, credits: 0, skips: 0, hosts: {} },
    scrapingbee: { reqs: 0, ok: 0, credits: 0, skips: 0, hosts: {} },
  };
  for (const line of lines) {
    const t = Object.keys(TAGS).find(k => line.includes(k));
    if (!t) continue;
    const m = line.slice(line.indexOf(t) + t.length).trim();
    let rec; try { rec = JSON.parse(m); } catch { continue; }
    const p = prov[TAGS[t]];
    if (isMemoSkip(rec)) { p.skips++; continue; }
    p.reqs++;
    if (rec.success) p.ok++;
    if (rec.credits) p.credits += rec.credits;
    const h = rec.host || 'unknown';
    p.hosts[h] = p.hosts[h] || { reqs: 0, credits: 0 };
    p.hosts[h].reqs++; p.hosts[h].credits += rec.credits || 0;
  }
  return prov;
}

module.exports = { parse, isMemoSkip };
