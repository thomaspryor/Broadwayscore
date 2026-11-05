'use strict';
/**
 * Grade an opening-night lane shadow report against the live site (BRO-6872).
 *
 * Input: the report lib/opening-night-lane-shadow.js buildShadowReport writes (shadow-report.json): one entry per
 * review with side 'both' | 'lane-only' | 'site-only' | 'lane-unscored', lane and site scores, lane scored time.
 * Output: the numbers the 2026-10 replays were graded on by hand, with a pass/fail per check:
 *   recall          lane-scored reviews the site also has / reviews the site has, all time (reported, not gated)
 *   onTimeRecall    the same over reviews the site dates on or before the night + 1 day (the gate): a review
 *                   published days later (a weekly magazine) cannot be found on the night. siteRowVerdict settles
 *                   undated pages from the regular pipeline's first sighting (siteMeta)
 *   falsePositives  lane-scored reviews the site does not have (a non-review, a roundup, a duplicate URL, or a real
 *                   review the regular pipeline missed: listed so a person can tell which)
 *   duplicates      lane-scored reviews that are one review twice: same outlet and the same critic, the same article
 *                   path on another host, or no critic name to tell them apart
 *   scoreGaps       shared reviews whose lane and site scores differ by GAP_PTS or more, with the lane's text length
 *   timeToScore     minutes from the night's embargo (replay) or the shadow's start to each lane score
 *   publish         errors from the publish merge, and how many rows the sandbox merge accepted
 * Pure: no I/O except writeGrade. The thresholds are the gate; a replay that misses one fails.
 */
const fs = require('fs');
const path = require('path');
const { detectBandFromReviewFile } = require('./star-reliability');

const GAP_PTS = 8;
// A gap smaller than the answer key's OWN ensemble spread (reviews.json scoreDelta: how far the three models were apart
// on that same text) is not a lane defect: rescoring the site's text would move it that far too. The 2026-10 replays
// flagged nytg 62/48 and theatermania 62/48 as 14-point gaps on complete text, where the site rows' own spreads are 18
// and 13 with "2/3 models agree" at medium confidence. Only gaps BEYOND that spread say the lane read different text.
const DEFAULT_THRESHOLDS = Object.freeze({ minOnTimeRecall: 0.85, maxFalsePositives: 2, maxDuplicates: 0, maxPublishErrors: 0, maxMeanAbsDiff: 6, maxScoreGapsBeyondEnsemble: 1 });

function outletKey(r) {
  try {
    const o = require('./review-normalization').resolveOutletFromUrl(r.url);
    if (o && o.outletId) return o.outletId;
  } catch { /* fall through */ }
  return String(r.outlet || '').toLowerCase().trim() || null;
}
const criticKey = (c) => String(c || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
const ms = (t) => { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : null; };
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * A short hash of a review text (whitespace collapsed): enough to say whether the lane and the site read the same copy,
 * never the text itself (the repo is public and the pages are copyrighted). A match proves the same text; a mismatch
 * can also be the same article cut differently by two extractors, so the grade reads it beside the two lengths.
 */
function textSha(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? require('crypto').createHash('sha256').update(t).digest('hex').slice(0, 16) : null;
}

/** The ensemble's per-model scores ({claude, openai, gemini, kimi}, finite numbers only) from a review file's ensembleData. */
function modelScores(ens) {
  if (!ens || typeof ens !== 'object') return null;
  const out = {};
  for (const [k, f] of [['claude', 'claudeScore'], ['openai', 'openaiScore'], ['gemini', 'geminiScore'], ['kimi', 'kimiScore']]) if (Number.isFinite(ens[f])) out[k] = ens[f];
  return Object.keys(out).length ? out : null;
}
const modelsLabel = (m) => (m ? Object.values(m).join('/') : '?');

// The lane starts this long before the embargo (lane-only-markets.js window, embargo - 3h). A review the regular
// pipeline already had before then is on the site when the lane starts, and the lane's merge keeps it.
const LANE_LEAD_MS = 3 * 60 * 60 * 1000;
const etDate = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** {firstSeenAt, source} the regular pipeline recorded for a site URL (opts.siteMeta: Map canonical URL -> meta). */
function lookupMeta(siteMeta, url) {
  if (!siteMeta || !url) return null;
  try { return siteMeta.get(require('./opening-night-lane/discovery').canonicalUrl(url)) || null; } catch { return null; }
}

/**
 * Whether a site review counts in the on-time recall (BRO-6872 round 9). Production's own first sighting
 * (firstSeenAt in its review file) settles the cases a publish date cannot:
 *   already-live     production had it before the lane starts (a preview-period blog post production found the
 *                    morning of opening day): on a lane night it is already on the site. Excluded.
 *   (A reader-form rule was tried and dropped: ingest-review-from-url.js labels every caller's file
 *   'submit-review-form', so `sources` cannot tell a reader's post from a pipeline find. The two BC blog posts that
 *   prompted it had no review-submission issue: one was already live, one arrived 8 days late, and the rules here
 *   exclude both.)
 *   on-time / late   by the full publish date (<= night + 1). With no full date (undated pages, "2026-10"), by the
 *                    day production first saw it (Eastern time), and on time when that is unknown too.
 * Without siteMeta every row falls through to the date rule, as before.
 */
function siteRowVerdict(r, { nightPlus1, laneStartMs, meta }) {
  const seen = meta ? ms(meta.firstSeenAt) : null;
  if (seen != null && laneStartMs != null && seen < laneStartMs) return 'already-live';
  if (!nightPlus1) return 'on-time';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.siteDate || '')) ? r.siteDate : null;
  if (date) return date <= nightPlus1 ? 'on-time' : 'late';
  if (seen != null) return etDate(seen) <= nightPlus1 ? 'on-time' : 'late';
  return 'on-time';
}

/** Levenshtein distance, capped: only "is it at most `max`" matters. */
function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * A lane-only row and a site-only row that are one review stored under two URLs: same host and parent path, and article
 * slugs at most 2 edits apart, one-to-one in both directions (the site row of Other Desert Cities at Culture Sauce is "/ther-desert-cities-...",
 * a typo the outlet redirects to "/other-desert-cities-..."). Each such pair becomes one 'both' row with the site's
 * score. Slugs under 12 characters never pair (too little to tell two reviews apart).
 */
function joinNearSlugs(reviews) {
  const slug = (u) => { try { const x = new URL(u); const parts = x.pathname.replace(/\/+$/, '').toLowerCase().split('/'); return { host: x.hostname.replace(/^www\./, ''), last: parts.pop(), dir: parts.join('/') }; } catch { return null; } };
  // Two slugs that differ only in digits or a trailing "-N" are two articles (WordPress's "-2" for a repeated slug,
  // "part-1" / "part-2"), never a typo.
  const sameArticle = (a, b) => a.host === b.host && a.dir === b.dir && a.last.length >= 12 && b.last.length >= 12 && a.last !== b.last
    && a.last.replace(/-\d+$/, '') !== b.last.replace(/-\d+$/, '') && a.last.replace(/\d/g, '') !== b.last.replace(/\d/g, '')
    && editDistanceAtMost(a.last, b.last, 2);
  const out = [...reviews];
  const lanes = out.filter((r) => r.side === 'lane-only').map((r) => ({ r, s: slug(r.url) })).filter((x) => x.s);
  const sites = out.filter((r) => r.side === 'site-only').map((r) => ({ r, s: slug(r.url) })).filter((x) => x.s);
  for (const l of lanes) {
    const hits = sites.filter((x) => sameArticle(l.s, x.s));
    if (hits.length !== 1) continue;
    // One-to-one both ways: a site row two lane rows could claim pairs with neither.
    if (lanes.filter((y) => sameArticle(y.s, hits[0].s)).length !== 1) continue;
    const s = hits[0].r;
    Object.assign(l.r, { side: 'both', siteScore: s.siteScore ?? null, siteLiveAt: s.siteLiveAt || null, siteDate: s.siteDate || null, siteUrl: s.url, joinedBy: 'near-slug' });
    out.splice(out.indexOf(s), 1);
  }
  return out;
}

function pct(values, p) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

/**
 * @param {object} rep  shadow report
 * @param {object} [opts] { replayAnchorAt (ISO), sandbox ([{url,row,liveAt}] from createReplaySitePorts.live()), thresholds }
 */
function gradeShadowReport(rep, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const reviews = joinNearSlugs((Array.isArray(rep && rep.reviews) ? rep.reviews : []).map((r) => ({ ...r })));
  const scored = reviews.filter((r) => r.side === 'both' || r.side === 'lane-only');
  const both = reviews.filter((r) => r.side === 'both');
  const siteLive = reviews.filter((r) => r.side === 'both' || r.side === 'site-only');
  const brief = (r) => ({ url: r.url, outlet: r.outlet || null, critic: r.critic || null, laneScore: r.laneScore ?? null, siteScore: r.siteScore ?? null });

  // Two lane rows are one review when they share an outlet and either the same critic or the same article path (one
  // review on two hosts: independent.co.uk and the-independent.com). A missing byline alone is not enough: an outlet
  // with two critics (NYSR) where one row lacks a byline would otherwise fail every replay.
  const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '').toLowerCase(); } catch { return null; } };
  const same = (a, b) => {
    const ca = criticKey(a.critic); const cb = criticKey(b.critic);
    return (ca && cb && ca === cb) || Boolean(pathOf(a.url) && pathOf(a.url) === pathOf(b.url));
  };
  const byOutlet = new Map();
  for (const r of scored) { const o = outletKey(r); if (!o) continue; if (!byOutlet.has(o)) byOutlet.set(o, []); byOutlet.get(o).push(r); }
  const duplicates = [];
  for (const rs of byOutlet.values()) {
    const used = new Set();
    for (let i = 0; i < rs.length; i++) {
      if (used.has(i)) continue;
      const g = [rs[i]];
      for (let j = i + 1; j < rs.length; j++) if (!used.has(j) && g.some((x) => same(x, rs[j]))) { g.push(rs[j]); used.add(j); }
      if (g.length > 1) duplicates.push(g.map(brief));
    }
  }

  const spreadOf = (r) => lookupMeta(opts.siteScoreSpread, r.siteUrl || r.url);
  const siteTextOf = (r) => lookupMeta(opts.siteMeta, r.siteUrl || r.url) || {};
  const diffs = both.filter((r) => r.laneScore != null && r.siteScore != null).map((r) => {
    const sp = spreadOf(r);
    const delta = r.laneScore - r.siteScore;
    const spread = sp && Number.isFinite(sp.spread) ? sp.spread : null;
    // A site row scored inside its critic's printed star band (anchored-v6): a lane score inside the same band is the
    // same verdict, one outside it is a real gap, whatever the models' spread (BRO-6872: NYSR "3/5" site 63 lane 71).
    const band = sp && sp.band && Number.isFinite(sp.band.floor) && Number.isFinite(sp.band.ceiling) ? sp.band : null;
    const outsideBand = band ? (r.laneScore < band.floor || r.laneScore > band.ceiling) : null;
    // The GAP_PTS floor comes FIRST: a gap smaller than the reporting bar is never a defect, whatever the spread.
    // Without it a row whose three models agreed exactly (spread 0, 1026 such rows in reviews.json) would fail the
    // replay on a 1-point difference, which the lane's own ensemble produces on the same text.
    // Above the floor the spread excuses the gap, EXCEPT when the lane's text is not complete: a paywall teaser
    // scored 15 points off a row with an 18-point spread is a text defect, not model variance, so tier decides.
    const big = Math.abs(delta) >= GAP_PTS;
    const partialText = !!(r.laneContentTier && r.laneContentTier !== 'complete');
    const st = siteTextOf(r);
    return {
      ...brief(r), delta, laneTextChars: r.laneTextChars ?? null, laneContentTier: r.laneContentTier || null,
      laneModels: r.laneModels || null, siteModels: st.models || null, siteTextChars: st.textChars ?? null,
      sameText: r.laneTextSha && st.textSha ? r.laneTextSha === st.textSha : null,
      siteScoreSpread: spread, siteBand: band ? { floor: band.floor, ceiling: band.ceiling, rating: band.rating || null } : null,
      siteModelAgreement: (sp && sp.agreement) || null, siteScoreConfidence: (sp && sp.confidence) || null,
      beyondEnsemble: big && (partialText || (band ? outsideBand : (spread == null || Math.abs(delta) > spread))),
    };
  });
  const meanAbsDiff = diffs.length ? round1(diffs.reduce((a, d) => a + Math.abs(d.delta), 0) / diffs.length) : null;
  const byGap = (a, b) => Math.abs(b.delta) - Math.abs(a.delta);
  const scoreGaps = diffs.filter((d) => Math.abs(d.delta) >= GAP_PTS).sort(byGap);
  const scoreGapsBeyondEnsemble = diffs.filter((d) => d.beyondEnsemble).sort(byGap);

  const t0 = ms(opts.replayAnchorAt) ?? ms(rep && rep.startedAt);
  const tts = t0 == null ? [] : scored.map((r) => ms(r.laneScoredAt)).filter((t) => t != null).map((t) => Math.round((t - t0) / 60000));

  const publishErrors = ((rep && rep.laneErrorsByAdapter && rep.laneErrorsByAdapter.publish) || {}).count || 0;
  const sandboxPublished = Array.isArray(opts.sandbox) ? opts.sandbox.length : null;
  const ratio = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
  const recall = ratio(both.length, siteLive.length);
  const nightPlus1 = rep && rep.night && Number.isFinite(Date.parse(rep.night)) ? new Date(Date.parse(rep.night) + 86400e3).toISOString().slice(0, 10) : null;
  const laneStartMs = opts.laneStartAt ? ms(opts.laneStartAt) : (ms(opts.replayAnchorAt) != null ? ms(opts.replayAnchorAt) - LANE_LEAD_MS : ms(rep && rep.startedAt));
  const verdict = (r) => siteRowVerdict(r, { nightPlus1, laneStartMs, meta: lookupMeta(opts.siteMeta, r.siteUrl || r.url) });
  for (const r of reviews) if (r.side === 'both' || r.side === 'site-only') r.onTimeVerdict = verdict(r);
  const counted = (r) => r.onTimeVerdict === 'on-time';
  const onTimeRecall = ratio(both.filter(counted).length, siteLive.filter(counted).length);
  const excluded = siteLive.filter((r) => r.onTimeVerdict === 'already-live').map((r) => ({ ...brief(r), why: r.onTimeVerdict }));
  const falsePositives = reviews.filter((r) => r.side === 'lane-only').map(brief);

  const checks = [
    { name: 'onTimeRecall', value: onTimeRecall, threshold: `>= ${th.minOnTimeRecall}`, pass: onTimeRecall != null && onTimeRecall >= th.minOnTimeRecall },
    { name: 'falsePositives', value: falsePositives.length, threshold: `<= ${th.maxFalsePositives}`, pass: falsePositives.length <= th.maxFalsePositives },
    { name: 'duplicates', value: duplicates.length, threshold: `<= ${th.maxDuplicates}`, pass: duplicates.length <= th.maxDuplicates },
    { name: 'publishErrors', value: publishErrors, threshold: `<= ${th.maxPublishErrors}`, pass: publishErrors <= th.maxPublishErrors },
    { name: 'meanAbsScoreDiff', value: meanAbsDiff, threshold: `<= ${th.maxMeanAbsDiff}`, pass: meanAbsDiff == null || meanAbsDiff <= th.maxMeanAbsDiff },
    { name: 'scoreGapsBeyondEnsemble', value: scoreGapsBeyondEnsemble.length, threshold: `<= ${th.maxScoreGapsBeyondEnsemble}`, pass: scoreGapsBeyondEnsemble.length <= th.maxScoreGapsBeyondEnsemble },
  ];
  if (sandboxPublished != null) checks.push({ name: 'sandboxPublished', value: sandboxPublished, threshold: '> 0 when anything scored', pass: !scored.length || sandboxPublished > 0 });

  return {
    show: rep && rep.show, night: rep && rep.night, replayAnchorAt: opts.replayAnchorAt || null,
    pass: checks.every((c) => c.pass), checks,
    counts: { laneScored: scored.length, siteLive: siteLive.length, both: both.length, laneOnly: falsePositives.length, siteOnly: reviews.filter((r) => r.side === 'site-only').length, laneUnscored: reviews.filter((r) => r.side === 'lane-unscored').length },
    recall, onTimeRecall, meanAbsScoreDiff: meanAbsDiff,
    siteMeta: opts.siteMeta ? { reviews: opts.siteMeta.size } : null,
    siteScoreSpread: opts.siteScoreSpread ? { reviews: opts.siteScoreSpread.size, matched: diffs.filter((d) => d.siteScoreSpread != null || d.siteBand).length, ofDiffs: diffs.length } : null,
    scoreGapsBeyondEnsemble,
    falsePositives, excluded, missed: reviews.filter((r) => r.side === 'site-only').map((r) => ({ ...brief(r), siteDate: r.siteDate || null, late: r.onTimeVerdict === 'late', excluded: r.onTimeVerdict === 'already-live' })), duplicates, scoreGaps,
    timeToScoreMin: { median: pct(tts, 50), p90: pct(tts, 90), max: tts.length ? Math.max(...tts) : null, from: opts.replayAnchorAt ? 'embargo' : 'shadow start' },
    publish: { errors: publishErrors, sandboxPublished },
  };
}

function gradeMarkdown(g) {
  const row = (r) => `${r.outlet || r.url}${r.critic ? ` (${r.critic})` : ''}`;
  const lines = [
    `## Lane replay grade: ${g.show} (${g.night}): ${g.pass ? 'PASS' : 'FAIL'}`,
    '',
    ...g.checks.map((c) => `- ${c.pass ? 'ok' : 'FAIL'} ${c.name}: ${c.value == null ? 'n/a' : c.value} (${c.threshold})`),
    `- All-time recall ${g.recall ?? 'n/a'} (not gated: includes reviews published after the night).`,
    // Say the coverage out loud: an unreadable reviews.json or a URL that does not canonicalise the same on both
    // sides would otherwise silently put every gap back on the flat rule with nothing in the report to show it.
    `- Answer-key ensemble spread known for ${g.siteScoreSpread ? `${g.siteScoreSpread.matched} of ${g.siteScoreSpread.ofDiffs}` : 'none'} of the shared reviews${g.siteScoreSpread ? '' : ' (no reviews.json: every gap on the flat rule)'}.`,
    `- Lane scored ${g.counts.laneScored}, site has ${g.counts.siteLive}, both ${g.counts.both}, lane only ${g.counts.laneOnly}, site only ${g.counts.siteOnly}, lane unscored ${g.counts.laneUnscored}.`,
    `- Time to score (min from ${g.timeToScoreMin.from}): median ${g.timeToScoreMin.median ?? 'n/a'}, p90 ${g.timeToScoreMin.p90 ?? 'n/a'}, max ${g.timeToScoreMin.max ?? 'n/a'}.`,
    ...(g.falsePositives.length ? ['', 'Lane only:', ...g.falsePositives.map((r) => `- ${row(r)} ${r.laneScore} ${r.url}`)] : []),
    ...(g.missed.length ? ['', 'Site only (missed):', ...g.missed.map((r) => `- ${row(r)} ${r.siteScore} ${r.url}${r.late ? ` (dated ${r.siteDate || 'by first sighting'}, after the night)` : ''}${r.excluded ? ' (not gated, see below)' : ''}`)] : []),
    ...(g.excluded && g.excluded.length ? ['', 'Not gated (already live before the lane starts):', ...g.excluded.map((r) => `- ${row(r)} ${r.url} (${r.why})`)] : []),
    ...(g.duplicates.length ? ['', 'Duplicates:', ...g.duplicates.map((d) => `- ${d.map((r) => r.url).join(' | ')}`)] : []),
    ...(g.scoreGaps.length ? ['', `Score gaps of ${GAP_PTS}+ (lane / site, lane text chars, tier; "within ensemble" = smaller than the site row's own model spread, so not a text difference):`,
      ...g.scoreGaps.map((d) => `- ${row(d)} ${d.laneScore} / ${d.siteScore} (${d.delta > 0 ? '+' : ''}${d.delta}), ${d.laneTextChars ?? '?'} chars, ${d.laneContentTier || '?'}`
        + (d.siteBand ? `, site rating ${d.siteBand.rating || '?'} (band ${d.siteBand.floor}-${d.siteBand.ceiling}): ${d.beyondEnsemble ? 'BEYOND band' : 'inside band'}`
          : d.siteScoreSpread == null ? ', site spread unknown' : `, site spread ${d.siteScoreSpread}${d.siteModelAgreement ? ` (${d.siteModelAgreement})` : ''}: ${d.beyondEnsemble ? 'BEYOND ensemble' : 'within ensemble'}`)
        + (d.laneModels || d.siteModels ? `; models lane ${modelsLabel(d.laneModels)} / site ${modelsLabel(d.siteModels)}` : '')
        + (d.sameText == null ? '' : d.sameText ? '; same text as the site' : `; text differs from the site's (${d.siteTextChars ?? '?'} chars there), or was cut differently`))] : []),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * siteMeta from review files ({url, firstSeenAt, source, sources} per file, plus the text's length, hash and model scores; the text itself is never kept): a local review-texts
 * show directory, or `files` already read ([{name, json}]). Returns a Map canonical URL -> {firstSeenAt, source, sources}.
 */
function loadSiteMetaFromDir(dir, files = null) {
  const { canonicalUrl } = require('./opening-night-lane/discovery');
  const list = files || (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((name) => {
    try { return { name, json: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }; } catch { return null; }
  }).filter(Boolean) : []);
  const meta = new Map();
  for (const { json } of list) {
    const k = canonicalUrl(json && json.url);
    if (!k) continue;
    const m = { firstSeenAt: json.firstSeenAt || null, source: json.source || null, sources: Array.isArray(json.sources) ? json.sources : null };
    // What the site scored, without keeping it: the text's length and hash, and each model's score (BRO-6872: a lane
    // 48 / site 60 Talkin' Broadway gap could not be traced to the text or to the models).
    if (typeof json.fullText === 'string' && json.fullText) Object.assign(m, { textChars: json.fullText.length, textSha: textSha(json.fullText) });
    const models = modelScores(json.ensembleData);
    if (models) m.models = models;
    // Two files for one URL (a duplicate): production first had it when the earlier of them was first seen.
    const prev = meta.get(k);
    if (!prev || (ms(m.firstSeenAt) != null && (ms(prev.firstSeenAt) == null || ms(m.firstSeenAt) < ms(prev.firstSeenAt)))) meta.set(k, m);
  }
  return meta;
}

/**
 * The answer key's own ensemble spread per review, from data/reviews.json: Map canonical URL ->
 * {spread, agreement, confidence, source, band?}. Ensemble rows (scoreSource llm-*) and human-review rows carry their
 * models' spread (scoreDelta). An anchored-v6 row also carries the star band of its own printed rating
 * (star-reliability.js detectBandFromReviewFile, the band its score was held to); the grader tests the lane score
 * against that band instead of the spread (BRO-6872). Rows scored any other way have neither, and their gaps fall back
 * to the flat GAP_PTS rule.
 * @param {string} reviewsJsonPath path to data/reviews.json
 * @param {string} showId
 */
function loadSiteScoreSpread(reviewsJsonPath, showId) {
  const { canonicalUrl } = require('./opening-night-lane/discovery');
  const out = new Map();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf8')); } catch { return out; }
  const rows = Array.isArray(raw) ? raw : (raw && raw.reviews) || [];
  for (const r of rows) {
    if (!r || r.showId !== showId) continue;
    const src = String(r.scoreSource || '');
    const anchored = src === 'anchored-v6';
    if (!/^llm/i.test(src) && src !== 'human-review' && !anchored) continue;
    const k = canonicalUrl(r.url);
    if (!k) continue;
    let band = null;
    if (anchored) {
      const d = detectBandFromReviewFile(r);
      if (d && d.band) band = { floor: d.band.floor, ceiling: d.band.ceiling, rating: d.starsRaw || null };
    }
    if (!band && !Number.isFinite(r.scoreDelta)) continue;
    const m = { spread: Number.isFinite(r.scoreDelta) ? r.scoreDelta : null, agreement: r.modelAgreement || null, confidence: r.scoreConfidence || null, source: src || null, ...(band ? { band } : {}) };
    // Two rows for one URL: keep the NARROWER spread. The wider one would excuse more gaps on a row we are not
    // even sure we matched; the narrow one keeps the gate strict (BRO-6872 review).
    // A band is a stricter, rating-based test, so a row with one wins over one without.
    const prev = out.get(k);
    const narrower = (a, b) => (a.spread ?? Infinity) < (b.spread ?? Infinity);
    if (!prev || (m.band && !prev.band) || (!!m.band === !!prev.band && narrower(m, prev))) out.set(k, m);
  }
  return out;
}

function writeGrade(outDir, g) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'shadow-grade.json'), `${JSON.stringify(g, null, 2)}\n`);
  const md = gradeMarkdown(g);
  fs.writeFileSync(path.join(outDir, 'shadow-grade.md'), md);
  return md;
}

module.exports = { textSha, modelScores, GAP_PTS, DEFAULT_THRESHOLDS, LANE_LEAD_MS, gradeShadowReport, gradeMarkdown, writeGrade, siteRowVerdict, joinNearSlugs, loadSiteMetaFromDir, loadSiteScoreSpread };
