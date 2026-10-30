'use strict';
/**
 * Opening-night lane, SHADOW mode (BRO-5201; postmortem of Billy Crystal 860, Oct 21 2026). The lane's real discovery,
 * fetch and ensemble scoring run for a night beside the regular pipeline, but the lane takes no night lease and
 * publishes nothing: the poller, gather and rebuild keep the show, exactly as on any other night. A recorder polls the
 * live show JSON on the same cadence, so the report answers one question per review: when would the lane have had it,
 * and when did the site actually show it.
 *
 * Lives outside scripts/lib/opening-night-lane/ on purpose: rehearsal.laneCodeHash() hashes that folder and what it
 * requires, so code here cannot disarm the production lane.
 *
 * Everything the report needs is appended to JSONL files as it happens (live first-seen, lane scores), so a job killed
 * mid-night still leaves a complete record; the site keeps no history to rebuild it from.
 *
 * Pure parts only; scripts/opening-night-lane-shadow.js wires the real ports.
 */
const fs = require('fs');
const path = require('path');
const { canonicalUrl } = require('./opening-night-lane/discovery');
const ledger = require('./opening-night-lane/ledger');

// The real night job (opening-night-lane-live.yml, mode=night) runs the lane for 270 minutes; a shadow review scored
// later than that is reported but would not have been the lane's on a real night.
const REAL_NIGHT_WINDOW_MIN = 270;

const appendJsonl = (file, obj) => { if (file) fs.appendFileSync(file, `${JSON.stringify(obj)}\n`); };

/**
 * Publish ports for runLaneNight with dryRun=true that write nothing anywhere. updateReviews runs the real merge
 * (mergeShowRows, so the lane's row checks still apply) on an empty document, hands the rows to onRows, and reports
 * none as applied: nothing is awaited live, so the batch returns at once and no rebuilt/deployed/verified-live event is
 * written for a publish that did not happen.
 */
function createShadowPublishPorts({ onRows, now = Date.now } = {}) {
  if (typeof onRows !== 'function') throw new Error('shadow: onRows is required');
  return {
    async updateReviews(fn) {
      const out = fn({ reviews: [] });
      onRows(out.applied || [], now());
      return { doc: out.doc, added: 0, replaced: 0, kept: 0, applied: [] };
    },
    async regenShow() { return { missing: [] }; },
    async deploy() {},
    async fetchLiveShow() { return { rv: [] }; },
  };
}

/**
 * Lane scores as they happen, independent of the merge: one row the merge refuses sends its whole batch back to the
 * queue (lane-runner.js publishBatch), and every later batch with it, so onRows alone can go quiet for the night.
 * Wrap scoreReview, and record rows that arrive with a fallback score through onRow.
 */
function createScoreRecorder({ logFile = null, now = Date.now } = {}) {
  const scores = new Map();
  // The text the score came from (its length and tier), so a lane/site score gap can be traced to a truncated or excerpt
  // copy on either side without re-fetching (BRO-6066: the 10-29 shadow could not say what the lane had scored).
  const record = (row, score, textInfo = {}) => {
    const key = canonicalUrl(row && row.url);
    if (!key || score == null || scores.has(key)) return;
    const e = {
      key, score, outletId: row.outletId || null, outlet: row.outlet || null, critic: row.criticName || null, at: now(),
      textChars: textInfo.chars != null ? textInfo.chars : String((row && row.fullText) || '').length,
      contentTier: textInfo.tier || (row && row.contentTier) || null,
    };
    scores.set(key, e);
    appendJsonl(logFile, e);
  };
  return {
    wrapScore: (scoreReview) => async (row, fetched) => {
      const out = await scoreReview(row, fetched);
      const extra = (out && typeof out === 'object' && out.extra) || {};
      record(row, out && typeof out === 'object' ? out.score : out, {
        chars: typeof extra.fullText === 'string' ? extra.fullText.length : undefined,
        tier: extra.contentTier || (fetched && fetched.contentTier) || 'complete',
      });
      return out;
    },
    onRow: (row) => record(row, row && row.assignedScore),
    snapshot: () => [...scores.values()],
  };
}

/** First time each review URL appeared on the live site, with the score and outlet it showed. */
function createLiveRecorder({ fetchLiveShow, showId, now = Date.now, logFile = null }) {
  const firstLive = new Map();
  let polls = 0; let failures = 0; let lastCount = null;
  return {
    async poll() {
      polls++;
      let live;
      try { live = await fetchLiveShow(showId); } catch { failures++; return null; }
      const rv = (live && Array.isArray(live.rv)) ? live.rv : [];
      const at = now();
      for (const r of rv) {
        const u = canonicalUrl(r && r.u);
        if (!u || firstLive.has(u)) continue;
        const e = { at, score: r.s == null ? null : r.s, outlet: r.o || null, url: r.u };
        firstLive.set(u, e);
        appendJsonl(logFile, { key: u, ...e });
      }
      lastCount = rv.length;
      return rv.length;
    },
    snapshot() { return { polls, failures, lastCount, firstLive: new Map(firstLive) }; },
  };
}

// The ledger stores ISO strings; the recorders store epoch ms.
const toMs = (t) => (t == null ? null : typeof t === 'number' ? t : (Number.isFinite(Date.parse(t)) ? Date.parse(t) : null));
const iso = (t) => { const ms = toMs(t); return ms == null ? null : new Date(ms).toISOString(); };
const minutesBetween = (a, b) => { const x = toMs(a); const y = toMs(b); return x == null || y == null ? null : Math.round((y - x) / 60000); };

function outletOf(url, outletId) {
  if (outletId) return outletId;
  try { return (require('./review-normalization').resolveOutletFromUrl(url) || {}).outletId || null; } catch { return null; }
}

/**
 * Join the lane's ledger (discovered/fetched/scored per review), its scores, and the live site's first appearances.
 * Joined by canonical URL; a lane review and a site review left unmatched are then paired when they are the only two
 * of their outlet (the regular pipeline can store a different URL for the same review).
 *
 * scoredLeadMin = site live minus lane scored, positive when the lane was earlier. It is an UPPER BOUND on the lane's
 * real lead: a real lane still merges, pushes and deploys after scoring.
 */
function buildShadowReport({ show, night, ledgerDir, scores = [], rows = [], live, startedAt, endedAt, result }) {
  const t0 = toMs(startedAt);
  const lane = new Map();
  for (const s of ledger.reviewStates(ledger.readLedger(ledgerDir, show.id, night).events)) {
    lane.set(s.reviewKey, { key: s.reviewKey, url: s.reviewKey, discoveredAt: toMs(s.firstAt.discovered), scoredAt: toMs(s.firstAt.scored) });
  }
  const laneEntry = (key) => { if (!lane.has(key)) lane.set(key, { key, url: key }); return lane.get(key); };
  for (const s of scores) Object.assign(laneEntry(s.key), { laneScore: s.score, outletId: s.outletId, outlet: s.outlet, critic: s.critic, scoredAt: laneEntry(s.key).scoredAt ?? s.at, laneTextChars: s.textChars ?? null, laneContentTier: s.contentTier ?? null });
  for (const { row, at } of rows) {
    const k = canonicalUrl(row.url); if (!k) continue;
    const e = laneEntry(k);
    if (e.laneScore == null) e.laneScore = row.assignedScore;
    e.outletId = e.outletId || row.outletId || null; e.outlet = e.outlet || row.outlet || null; e.critic = e.critic || row.criticName || null;
    if (e.scoredAt == null) e.scoredAt = at;
  }
  // Syndicated copies the lane dropped (lane-runner skipped): a copy pulled from the queue was scored, but the lane would
  // never have published it, so it is not a lane score.
  const skippedKeys = new Set(((result && result.skipped) || []).map((x) => x.key));
  for (const k of skippedKeys) lane.delete(k);
  const site = new Map([...live.firstLive].map(([k, l]) => [k, { key: k, ...l }]));

  const pairs = [];
  for (const [k, e] of lane) if (site.has(k)) { pairs.push([e, site.get(k), 'url']); site.delete(k); lane.delete(k); }
  // Outlet fallback: only an unambiguous one-to-one pairing.
  const groupBy = (m, fn) => { const g = new Map(); for (const v of m.values()) { const o = fn(v); if (!o) continue; if (!g.has(o)) g.set(o, []); g.get(o).push(v); } return g; };
  const laneByOutlet = groupBy(lane, (e) => outletOf(e.url, e.outletId));
  const siteByOutlet = groupBy(site, (l) => outletOf(l.url || l.key));
  for (const [o, ls] of laneByOutlet) {
    const ss = siteByOutlet.get(o);
    if (ls.length !== 1 || !ss || ss.length !== 1) continue;
    pairs.push([ls[0], ss[0], 'outlet']); lane.delete(ls[0].key); site.delete(ss[0].key);
  }

  const entry = (e, l, joinedBy) => {
    const scoredAt = e ? e.scoredAt : null; const liveAt = l ? l.at : null;
    return {
      url: (e && e.url) || (l && (l.url || l.key)), outlet: (e && (e.outlet || e.outletId)) || (l && l.outlet) || null, critic: (e && e.critic) || null,
      laneDiscoveredAt: iso(e && e.discoveredAt), laneScoredAt: iso(scoredAt), siteLiveAt: iso(liveAt),
      laneScore: e && e.laneScore != null ? e.laneScore : null, siteScore: l && l.score != null ? l.score : null,
      laneTextChars: e && e.laneTextChars != null ? e.laneTextChars : null, laneContentTier: (e && e.laneContentTier) || null,
      scoredLeadMin: scoredAt != null && liveAt != null ? minutesBetween(scoredAt, liveAt) : null,
      // Already on the site at the first poll: the regular pipeline had it before the shadow started.
      liveAtStart: liveAt != null && t0 != null && liveAt <= t0,
      afterNightWindow: scoredAt != null && t0 != null && scoredAt - t0 > REAL_NIGHT_WINDOW_MIN * 60000,
      joinedBy: joinedBy || null,
      side: e && scoredAt != null && l ? 'both' : e && scoredAt != null ? 'lane-only' : l ? 'site-only' : 'lane-unscored',
    };
  };
  const reviews = [
    ...pairs.map(([e, l, by]) => entry(e, l, by)),
    ...[...lane.values()].map((e) => entry(e, null)),
    ...[...site.values()].map((l) => entry(null, l)),
  ].sort((a, b) => String(a.laneScoredAt || a.siteLiveAt || '').localeCompare(String(b.laneScoredAt || b.siteLiveAt || '')));

  const count = (side) => reviews.filter((r) => r.side === side).length;
  const firstOf = (field) => reviews.map((r) => r[field]).filter(Boolean).sort()[0] || null;
  const both = reviews.filter((r) => r.side === 'both');
  const scoreDiffs = both.filter((r) => r.laneScore != null && r.siteScore != null).map((r) => Math.abs(r.laneScore - r.siteScore));
  return {
    show: show.id, night, startedAt: iso(startedAt), endedAt: iso(endedAt),
    passes: result ? result.passes : null,
    laneErrors: result ? (result.errors || []).length : null,
    laneErrorsByAdapter: errorsByAdapter(result ? result.errors : []),
    laneFailed: result ? (result.failed || []).map((f) => f.key || f) : [],
    laneSkipped: result ? (result.skipped || []) : [],
    livePolls: live.polls, livePollFailures: live.failures,
    totals: { laneScored: count('both') + count('lane-only'), siteLive: count('both') + count('site-only'), both: count('both'), laneOnly: count('lane-only'), siteOnly: count('site-only') },
    firstLaneScoredAt: firstOf('laneScoredAt'), firstSiteLiveAt: firstOf('siteLiveAt'),
    medianScoredLeadMin: median(both.filter((r) => !r.liveAtStart).map((r) => r.scoredLeadMin)),
    meanAbsScoreDiff: scoreDiffs.length ? Math.round((scoreDiffs.reduce((a, b) => a + b, 0) / scoreDiffs.length) * 10) / 10 : null,
    reviews,
  };
}

/** {adapter: {count, first}}: a night of 150 passes repeats one failure hundreds of times. */
function errorsByAdapter(errors) {
  const out = {};
  for (const e of errors || []) {
    const k = (e && e.adapter) || 'unknown';
    if (!out[k]) out[k] = { count: 0, first: String((e && e.error) || '').slice(0, 200) };
    out[k].count++;
  }
  return out;
}

function median(xs) {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const na = (v) => (v == null ? 'n/a' : v);
const hhmm = (t) => (t ? `${t.slice(5, 10)} ${t.slice(11, 16)}` : '-');

function reportMarkdown(rep) {
  const t = rep.totals;
  const late = rep.reviews.filter((r) => r.afterNightWindow).length;
  const atStart = rep.reviews.filter((r) => r.liveAtStart).length;
  const lines = [
    `## Opening-night lane shadow: ${rep.show} (${rep.night})`,
    '',
    `Window ${rep.startedAt} to ${rep.endedAt || '(still running)'}, ${na(rep.passes)} discovery passes, ${rep.livePolls} live-page polls (${rep.livePollFailures} failed).`,
    '',
    `- Lane scored ${t.laneScored} reviews; the site showed ${t.siteLive}. Both: ${t.both}, lane only: ${t.laneOnly}, site only: ${t.siteOnly}.`,
    `- First review: lane scored ${rep.firstLaneScoredAt || 'none'}, site live ${rep.firstSiteLiveAt || 'none'}.`,
    `- Median lead, site live minus lane scored (minutes, positive = lane earlier; an upper bound, since a real lane still has to publish): ${na(rep.medianScoredLeadMin)}.`,
    `- Mean absolute score difference on shared reviews: ${na(rep.meanAbsScoreDiff)}.`,
    `- Lane errors: ${na(rep.laneErrors)}; permanently failed: ${rep.laneFailed.length}.`,
    ...Object.entries(rep.laneErrorsByAdapter || {}).map(([a, v]) => `  - ${a}: ${v.count}x, first: ${v.first}`),
    ...(atStart ? [`- ${atStart} reviews were already live when the shadow started (site time = start; left out of the median).`] : []),
    ...(late ? [`- ${late} reviews were scored after minute ${REAL_NIGHT_WINDOW_MIN}, past a real night's window.`] : []),
    '',
    '| Outlet | Lane scored | Site live | Lead (min) | Lane / site score |',
    '|---|---|---|---|---|',
    ...rep.reviews.map((r) => `| ${r.outlet || r.url} | ${hhmm(r.laneScoredAt)} | ${hhmm(r.siteLiveAt)} | ${r.scoredLeadMin == null ? '-' : r.scoredLeadMin} | ${r.laneScore == null ? '-' : r.laneScore} / ${r.siteScore == null ? '-' : r.siteScore} |`),
    '',
    'Times are UTC (MM-DD HH:MM).',
  ];
  return `${lines.join('\n')}\n`;
}

function writeShadowReport(outDir, rep) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'shadow-report.json'), `${JSON.stringify(rep, null, 2)}\n`);
  const md = reportMarkdown(rep);
  fs.writeFileSync(path.join(outDir, 'shadow-report.md'), md);
  return md;
}

module.exports = {
  REAL_NIGHT_WINDOW_MIN, createShadowPublishPorts, createScoreRecorder, createLiveRecorder, buildShadowReport, reportMarkdown, writeShadowReport,
};
