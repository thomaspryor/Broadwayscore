#!/usr/bin/env node
'use strict';
/**
 * BRO-7167 step 3: the free method check. Replays a recorded opening night (the lane-recordings archive layout, plaintext
 * pages) through the current lane discovery wiring, offline and read-only, and reports per review: would it be found,
 * by which pass and virtual minute, with what card metadata (outlet display name, critic, date, pull quote), and when
 * the site's coverage rule would be met. Review ARTICLES are not in a recording, so scoring is not replayed: the
 * coverage rule is counted from admitted outlets, which is an upper bound on what scoring could publish.
 *
 *   node scripts/wanted-method-check.js --archive DIR [--show=wanted-2022] [--night=2026-11-08] [--step-min=2] [--out=FILE]
 *
 * --archive is the lane-recordings root (private clone's lane-recordings). Output names urls, outlets and counts only,
 * never page text beyond the short pull-quote the aggregator itself listed.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (require.main === module && hasHelpFlag(process.argv.slice(2))) {
  console.log(fs.readFileSync(__filename, 'utf8').split('/**')[1].split('*/')[0].replace(/^ \* ?/gm, '').trim());
  process.exit(0);
}

const MIN = 60000;
const SHOWS = {
  'wanted-2022': { id: 'wanted-2022', title: 'Wanted', venue: 'James Earl Jones Theatre', openingDate: '2026-11-08', category: 'broadway', market: 'broadway' },
};

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};

/**
 * Replay discovery over `recording` every `stepMin` virtual minutes. Pure given its inputs (no network: every fetch is
 * served from the recording; a URL it never recorded is a 404).
 * @returns {Promise<{passes: number, spanMin: number, found: object[], unrecorded: string[], errors: object[]}>}
 */
async function replayDiscovery(recording, { show, night, stepMin = 2, adapters = null, startedAtMs = null } = {}) {
  const d = require('./lib/opening-night-lane/discovery');
  const { laneAdapters } = require('./lib/opening-night-lane/adapters');
  const { replayFetchFrom } = require('./lib/lane-recorded-nights/recording-night');
  const { resolveOutletFromUrl } = require('./lib/review-normalization');
  const first = recording.entries.reduce((m, e) => (m === null || e.t < m.t ? e : m), null);
  if (!first) return { passes: 0, spanMin: 0, found: [], unrecorded: [], errors: [] };
  const originMs = Date.parse(first.at) - first.t; // wall clock at recording offset 0
  const start = startedAtMs == null ? originMs : startedAtMs;
  let clock = 0; // ms since offset 0 of the recording
  const now = () => originMs + clock;
  const recorded = new Set(recording.entries.map((e) => e.url));
  const unrecorded = new Set();
  const replay = replayFetchFrom(recording, { now: () => clock, startMs: 0 });
  const fetchText = d.fetchTextFrom(async (url, opts) => { if (!recorded.has(url)) unrecorded.add(url); return replay(url, opts); });
  const list = adapters || laneAdapters({ showScoreGuards: { urlMap: {}, allShows: [show] }, adaptersConfig: {}, search: async () => [], decodeImpl: null, now, ledgerDir: null });
  const seen = new Set();
  const memo = { rejected: {} };
  const foundAt = new Map();
  const errors = [];
  let passes = 0;
  for (clock = 0; clock <= recording.spanMs + stepMin * MIN; clock += stepMin * MIN) {
    passes++;
    const pass = await d.runDiscoveryPass({
      show, night, now: now(), startedAt: start, fetchText, adapters: list, seen, memo, timeZone: 'America/New_York',
      missingOutlets: d.laneMissingOutlets({ show, seen, adaptersConfig: {} }), deadlineMs: 60e3,
    });
    for (const e of pass.errors || []) if (!errors.some((x) => x.adapter === e.adapter && x.error === e.error)) errors.push(e);
    for (const c of pass.admitted || []) {
      if (foundAt.has(c.key)) continue;
      const o = resolveOutletFromUrl(c.key) || resolveOutletFromUrl(c.url) || {};
      foundAt.set(c.key, {
        url: c.key, adapter: c.adapter, pass: passes, minute: Math.round(clock / MIN), at: new Date(now()).toISOString(),
        outletId: c.outletId || o.outletId || null, outlet: c.outlet || o.outlet || o.name || null,
        criticName: c.criticName || c.critic || null, publishDate: c.publishDate || null,
        pullQuote: (c.excerpts && Object.values(c.excerpts)[0]) || c.excerpt || null, aggregatorCited: !!c.aggregatorCited,
      });
      seen.add(c.key);
    }
  }
  return { passes, spanMin: Math.round(recording.spanMs / MIN), found: [...foundAt.values()], unrecorded: [...unrecorded], errors };
}

/** Card completeness and the coverage rule over what was found. */
function summarize(found, { market = 'broadway' } = {}) {
  const { getOutletTier } = require('./lib/review-normalization');
  const { getMarketMinReviews } = require('./lib/min-reviews');
  const min = getMarketMinReviews(market);
  const gaps = { outlet: [], critic: [], date: [], pullQuote: [] };
  for (const f of found) {
    if (!f.outlet) gaps.outlet.push(f.url);
    if (!f.criticName) gaps.critic.push(f.url);
    if (!f.publishDate) gaps.date.push(f.url);
    if (!f.pullQuote) gaps.pullQuote.push(f.url);
  }
  const ordered = [...found].sort((a, b) => a.minute - b.minute);
  const outlets = new Set();
  let coverageMinute = null;
  for (const f of ordered) {
    outlets.add(f.outletId || f.url);
    if (coverageMinute === null && outlets.size >= min) coverageMinute = f.minute;
  }
  const tiers = {};
  for (const f of found) { const t = f.outletId ? getOutletTier(f.outletId) : null; tiers[t || 'unknown'] = (tiers[t || 'unknown'] || 0) + 1; }
  return { foundCount: found.length, distinctOutlets: outlets.size, minReviewsRule: min, coverageMinute, tiers, gaps: Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, v.length])), gapUrls: gaps };
}

async function main() {
  const archive = arg('archive');
  const showId = arg('show', 'wanted-2022');
  const night = arg('night', '2026-11-08');
  const show = SHOWS[showId];
  if (!archive || !show) { console.error('--archive and a known --show are required'); return 1; }
  const { loadRecording } = require('./lib/lane-recorded-nights/recording-night');
  const dir = path.join(archive, showId, night, 'recording');
  const rec = loadRecording(dir, { key: process.env.LANE_RECORDING_KEY || null });
  const r = await replayDiscovery(rec, { show, night, stepMin: Number(arg('step-min', 2)) });
  const out = { show: showId, night, recordingFetches: rec.entries.length, ...r, summary: summarize(r.found, { market: show.market }) };
  const file = arg('out');
  if (file) fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ ...out, found: out.found.map((f) => ({ ...f, pullQuote: f.pullQuote ? String(f.pullQuote).slice(0, 80) : null })) }, null, 1));
  return 0;
}

module.exports = { replayDiscovery, summarize, SHOWS };

if (require.main === module) {
  Promise.resolve().then(main).then((c) => { process.exitCode = c; }, (e) => { console.error(`::error::${String((e && e.message) || e).slice(0, 300)}`); process.exitCode = 1; });
}
