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
 * scripts/opening-night-lane-shadow.js wires the real ports.
 */
const fs = require('fs');
const path = require('path');
const { canonicalUrl } = require('./opening-night-lane/discovery');
const ledger = require('./opening-night-lane/ledger');
const { beginPressNightSpend } = require('./spend-purpose');
const { withSpendShow } = require('./provider-telemetry');

/** The shadow bypasses the live driver's lease, but must share its count-and-warn spend scope. */
async function runShadowNight(options) {
  // A replay passes spendNow (the real clock), never its replay clock: a replay weeks later must not reopen the press-night window, which
  // relaxes the ScrapingDog press-night cap to warn and books real spend to a past night (BRO-6872 review).
  const restoreSpend = beginPressNightSpend(options.show, (options.spendNow || options.now)());
  try {
    return await withSpendShow(options.show.id, () => require('./opening-night-lane/lane-runner').runLaneNight(options));
  } finally {
    restoreSpend();
  }
}

/**
 * The clock a REPLAY of a past night runs on (BRO-6872). trust-model.isLaneReview only takes rows seen between
 * SEEN_BEFORE_DAYS before the night and SEEN_AFTER_DAYS after it, so a night replayed a week later stamped every row
 * with today and the publish merge refused all of them ("not a lane review", 54x per replay). A replay instead runs on
 * a clock that starts at the night's embargo and advances in real time; the trust check itself is unchanged.
 * Returns null when the night is still inside the window (a live shadow keeps the real clock) unless `force`.
 */
function replayClock({ show, night, realNow = Date.now, force = false }) {
  const { SEEN_AFTER_DAYS } = require('./opening-night-lane/trust-model');
  const nightMs = Date.parse(`${night}T00:00:00Z`);
  if (!Number.isFinite(nightMs)) throw new Error(`shadow: bad night ${night}`);
  const startReal = realNow();
  const pastWindow = startReal >= nightMs + (SEEN_AFTER_DAYS + 1) * 24 * 3600 * 1000;
  if (!force && !pastWindow) return null;
  const anchor = Date.parse(require('./press-night-record').defaultEmbargoAt(show));
  if (!Number.isFinite(anchor)) throw new Error(`shadow: no embargo time for ${show && show.id}`);
  return { anchorAt: new Date(anchor).toISOString(), now: () => anchor + (realNow() - startReal) };
}

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
/** The printed rating the scorer was handed (inline-score.js ratingFields) as a short label: '2/5 (regex-stars)'. */
function ratingLabel(r) {
  if (!r || typeof r !== 'object') return null;
  const v = r.originalScore != null && r.originalScore !== '' ? r.originalScore : (r.aggregatorStars != null && r.aggregatorStars !== '' ? r.aggregatorStars : null);
  if (v == null) return null;
  const src = r.originalScoreSource || r.scoreSource || null;
  return `${String(v)}${src ? ` (${src})` : ''}`;
}

function createScoreRecorder({ logFile = null, now = Date.now } = {}) {
  const grader = require('./lane-shadow-grade');
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
      // The hash covers the lane's scoring INPUT (the scorer may add aggregator quotes to a partial copy), and the models'
      // own scores, so a gap against the site can be put down to the text or to the models (BRO-6872).
      ...(textInfo.sha ? { textSha: textInfo.sha } : {}), ...(textInfo.models ? { models: textInfo.models } : {}),
      // A printed rating read off the page anchors every model to its band, so a gap on identical text can be put down to
      // the page's rating, not the models (BRO-6872 p26: Theater Scene 78 then 41 on the same text, all three models).
      ...(textInfo.rating ? { rating: textInfo.rating } : {}), ...(textInfo.scoreSource ? { scoreSource: textInfo.scoreSource } : {}),
    };
    scores.set(key, e);
    appendJsonl(logFile, e);
  };
  return {
    wrapScore: (scoreReview) => async (row, fetched) => {
      const out = await scoreReview(row, fetched);
      const extra = (out && typeof out === 'object' && out.extra) || {};
      // An excerpt score's text is the excerpts the scorer read, not the page text it dropped.
      const excerpts = (fetched && fetched.excerpts) || {};
      const excerptChars = Object.values(excerpts).reduce((n, t) => n + String(t || '').length, 0);
      // The fetch step can pick the excerpt itself (a paywall teaser out of retries): then the scorer's extra has no tier
      // and the excerpt tier is on `fetched`, as lane-runner.js reads it. Missing that logged the excerpt as 0 chars of
      // page text with no hash (BRO-6872 p25: Imaginary Invalid and Other Desert Cities WSJ).
      const tier = extra.contentTier || (fetched && fetched.contentTier) || 'complete';
      const fromExcerpt = tier === 'excerpt';
      // Hash what textChars measures: the excerpts for an excerpt score (its fullText is blanked to ''), else the page text.
      const scored = fromExcerpt ? Object.keys(excerpts).sort().map((k) => String(excerpts[k] || '')).join('\n')
        : (typeof extra.fullText === 'string' && extra.fullText ? extra.fullText : String((row && row.fullText) || ''));
      record(row, out && typeof out === 'object' ? out.score : out, {
        chars: fromExcerpt ? excerptChars : (typeof extra.fullText === 'string' ? extra.fullText.length : undefined),
        tier,
        sha: grader.textSha(scored), models: grader.modelScores(extra.ensembleData),
        // ratingFields routes a value to originalScore, or to aggregatorStars; detectBandFromReviewFile reads both.
        rating: ratingLabel(fetched && fetched.rating),
        scoreSource: typeof extra.scoreSource === 'string' ? extra.scoreSource : null,
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
        const e = { at, score: r.s == null ? null : r.s, outlet: r.o || null, url: r.u, date: typeof r.d === 'string' ? r.d.slice(0, 10) : null };
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
  for (const s of scores) Object.assign(laneEntry(s.key), { laneScore: s.score, outletId: s.outletId, outlet: s.outlet, critic: s.critic, scoredAt: laneEntry(s.key).scoredAt ?? s.at, laneTextChars: s.textChars ?? null, laneContentTier: s.contentTier ?? null, laneTextSha: s.textSha || null, laneModels: s.models || null, laneRating: s.rating || null, laneScoreSource: s.scoreSource || null });
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
      siteDate: (l && l.date) || null,
      siteUrl: l ? (l.url || l.key) : null,
      laneTextChars: e && e.laneTextChars != null ? e.laneTextChars : null, laneContentTier: (e && e.laneContentTier) || null,
      laneTextSha: (e && e.laneTextSha) || null, laneModels: (e && e.laneModels) || null,
      laneRating: (e && e.laneRating) || null, laneScoreSource: (e && e.laneScoreSource) || null,
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

/**
 * Map canonical URL -> {firstSeenAt, source, sources} for a show's review files: the local review-texts checkout when
 * there is one, else the private review-texts repo through the GitHub API (REVIEW_TEXTS_TOKEN). Only those fields
 * are kept; the review text is never stored or logged.
 */
async function loadSiteMeta({ repoDir, showId, token, fetchImpl = globalThis.fetch }) {
  const grader = require('./lane-shadow-grade');
  const local = path.join(repoDir, 'data', 'review-texts', showId);
  if (fs.existsSync(local)) return grader.loadSiteMetaFromDir(local);
  if (!token) throw new Error('no review-texts checkout and no REVIEW_TEXTS_TOKEN');
  const api = 'https://api.github.com/repos/thomaspryor/broadway-review-texts/contents';
  const get = async (url, accept) => {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept, 'User-Agent': 'opening-night-lane-shadow' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url.replace(api, '')}`);
    return res.json();
  };
  const listing = await get(`${api}/${encodeURIComponent(showId)}`, 'application/vnd.github+json');
  const files = [];
  for (const f of (Array.isArray(listing) ? listing : []).filter((x) => x.type === 'file' && /\.json$/.test(x.name))) {
    try {
      const j = await get(`${api}/${encodeURIComponent(showId)}/${encodeURIComponent(f.name)}`, 'application/vnd.github.raw+json');
      // fullText goes to the loader only to be measured and hashed; the returned meta never holds it.
      files.push({ name: f.name, json: { url: j.url, firstSeenAt: j.firstSeenAt, source: j.source, sources: j.sources, fullText: j.fullText, ensembleData: j.ensembleData } });
    } catch { /* one unreadable file grades by its date */ }
  }
  return grader.loadSiteMetaFromDir(null, files);
}

module.exports = {
  runShadowNight, replayClock,
  REAL_NIGHT_WINDOW_MIN, createShadowPublishPorts, createScoreRecorder, createLiveRecorder, buildShadowReport, reportMarkdown, writeShadowReport,
  loadSiteMeta,
};
