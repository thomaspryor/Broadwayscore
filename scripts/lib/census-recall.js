'use strict';

/**
 * census-recall.js — the pure decision layer for SERP-census recall
 * measurement (Coverage Verdict S1; tasks #872 + #898).
 *
 * #872 built the harness (scripts/audit-serp-census-recall.js): it runs the
 * scoped census arms and the naive "what the owner actually types" arm side by
 * side over recent openings and reports what each found. It ran ONCE. #898 is
 * the meta-failure that followed: a one-shot measurement cannot see a
 * regression, because a regression is a CHANGE, and one number has nothing to
 * change from. Every arm improvement shipped before it (#371/#444/#720/#767)
 * had the same shape — improve an arm, never measure the whole, so the next
 * silent breakage is invisible by construction.
 *
 * So this module holds the two things a cadence needs and a one-shot run does
 * not:
 *
 *   1. perArmRecall() — attribute recall to the INDIVIDUAL arm that found the
 *      URLs, not just to the run. A run-level number hides the failure mode
 *      that actually happens here: one arm dies (a query builder regresses, a
 *      provider stops honouring a date window) while the others cover for it,
 *      so the headline barely moves and nobody looks. Per-arm, a dead arm
 *      reads as a dead arm.
 *
 *   2. detectRecallRegression() — judge the latest run against the arm's own
 *      recent history, not a hardcoded floor. Recall is denominator-driven:
 *      ground truth is the union of everything all arms found, so a week where
 *      the naive arm digs up six long-tail blogs mechanically DROPS the scoped
 *      arm's recall without anything having broken. Only movement relative to
 *      the same arm's own recent baseline is evidence.
 *
 * ── Why recall is pooled (micro-averaged), not averaged per show ────────────
 * A per-show mean gives a regional show with 2 findable reviews the same vote
 * as a Broadway opening with 14, and the sample is small enough (5-20 shows)
 * that one sparse show swings the headline. Pooling — total URLs found over
 * total ground-truth URLs — weights each show by how much evidence it carries.
 * Per-category breakdowns are reported alongside precisely because the pooled
 * number is Broadway-weighted, and off-west-end/regional shows have 2-4 total
 * reviews (Coverage Verdict plan, S1).
 *
 * ── Why samples are classified before they are counted ──────────────────────
 * Two kinds of show cannot honestly contribute to a recall number:
 *   · a show that opened hours ago — Google indexes major outlets ~3h+ after
 *     publication (memory/feedback_serp_opening_night_timing.md), so its
 *     "missing" reviews are missing from the INDEX, not from the census. It is
 *     `settling`, and counting it manufactures a recall dip every opening
 *     night.
 *   · a show with no openingDate — 377 exist in the corpus. The #872 harness
 *     dropped these silently at selection time, which is the same invisible
 *     coverage hole the whole sprint is about. They are `unknown-date`:
 *     excluded from the headline, but COUNTED and named in the report.
 */

/** Hours after opening during which SERP indexing is still settling. */
const SETTLING_HOURS = 24;

const REGRESSION_DEFAULTS = {
  /** Prior runs whose median forms the baseline for each arm. */
  baselineRuns: 4,
  /** Minimum prior runs before any verdict other than 'blind' is possible. */
  minBaselineRuns: 2,
  /** Absolute recall drop vs baseline that counts as a regression. */
  dropThreshold: 0.15,
  /**
   * Runs whose ground truth is thinner than this cannot support a recall
   * comparison — with 6 truth URLs a single long-tail blog moves recall by
   * 0.17, which is the entire threshold. Report it rather than alerting on it.
   */
  minTruthUrls: 10,
};

/**
 * Arm family for an arm label. Individual arms are labelled with their slot
 * ('scoped-q0', 'naive-p1') so a single dead query is visible; the family is
 * what the trend line and the digest speak in.
 * @param {string} arm
 * @returns {string}
 */
function armFamily(arm) {
  const s = String(arm || '');
  const dash = s.indexOf('-');
  return dash > 0 ? s.slice(0, dash) : s;
}

/**
 * Classify a show for measurement.
 *
 * @param {object} show shows.json record
 * @param {object} [opts] {now: epoch ms, settlingHours}
 * @returns {{state:'measured'|'settling'|'unknown-date', reason:string}}
 */
function classifySample(show, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const settlingHours = opts.settlingHours === undefined ? SETTLING_HOURS : opts.settlingHours;
  const opening = show && show.openingDate ? Date.parse(show.openingDate) : NaN;
  if (!Number.isFinite(opening)) {
    return {
      state: 'unknown-date',
      reason: 'no parseable openingDate — measured but excluded from the headline recall',
    };
  }
  const hoursSince = (now - opening) / 3600000;
  if (hoursSince < settlingHours) {
    return {
      state: 'settling',
      reason: `opened ${Math.max(0, Math.round(hoursSince))}h ago (<${settlingHours}h) — SERP indexing still settling`,
    };
  }
  return { state: 'measured', reason: `opened ${Math.round(hoursSince / 24)}d ago` };
}

/** Unique accepted URLs an arm record carries. */
function armUrls(armRec) {
  return new Set(Array.isArray(armRec && armRec.urls) ? armRec.urls : []);
}

/**
 * Pooled per-arm and per-family recall across report rows.
 *
 * Every accepted URL is in ground truth by construction (truth is the union of
 * all arms plus what is already on disk), so an arm's recall is simply the
 * share of truth it recovered — no intersection needed. What DOES need care is
 * de-duplication: the three scoped queries overwhelmingly return the same
 * reviews, so summing their per-query counts would report a "recall" above 1.
 *
 * @param {Array<object>} rows report rows ({counts:{truth}, arms:[{arm, urls, ok}]})
 * @returns {{truthUrls:number, shows:number, arms:object, families:object}}
 */
function perArmRecall(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let truthUrls = 0;
  const arms = new Map();     // label → {found, queries, failed}
  const families = new Map(); // family → {found, arms:Set, failed}

  for (const row of list) {
    const truth = Number(row && row.counts && row.counts.truth) || 0;
    truthUrls += truth;

    const familyUrls = new Map(); // family → Set (deduped within this show)
    for (const rec of (row && row.arms) || []) {
      const label = String(rec.arm || 'unknown');
      const fam = armFamily(label);
      const urls = armUrls(rec);

      if (!arms.has(label)) arms.set(label, { found: 0, queries: 0, failed: 0 });
      const a = arms.get(label);
      a.found += urls.size;
      a.queries += 1;
      if (rec.ok === false) a.failed += 1;

      if (!families.has(fam)) families.set(fam, { found: 0, arms: new Set(), failed: 0 });
      const f = families.get(fam);
      f.arms.add(label);
      if (rec.ok === false) f.failed += 1;

      if (!familyUrls.has(fam)) familyUrls.set(fam, new Set());
      for (const u of urls) familyUrls.get(fam).add(u);
    }
    for (const [fam, urls] of familyUrls) families.get(fam).found += urls.size;
  }

  const recallOf = (found) => (truthUrls === 0 ? null : round3(found / truthUrls));
  const armOut = {};
  for (const [label, a] of [...arms].sort((x, y) => x[0].localeCompare(y[0]))) {
    armOut[label] = { found: a.found, queries: a.queries, failed: a.failed, recall: recallOf(a.found) };
  }
  const famOut = {};
  for (const [fam, f] of [...families].sort((x, y) => x[0].localeCompare(y[0]))) {
    famOut[fam] = { found: f.found, arms: f.arms.size, failed: f.failed, recall: recallOf(f.found) };
  }
  return { truthUrls, shows: list.length, arms: armOut, families: famOut };
}

/**
 * Pooled recall per market category, so a Broadway-shaped headline cannot mask
 * a market where the census is blind (S1: per-category expectations).
 * @param {Array<object>} rows
 * @returns {Object<string, {shows:number, truthUrls:number, families:object}>}
 */
function perCategoryRecall(rows) {
  const byCat = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const cat = (row && row.market) || 'unknown';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(row);
  }
  const out = {};
  for (const [cat, catRows] of [...byCat].sort((a, b) => a[0].localeCompare(b[0]))) {
    const agg = perArmRecall(catRows);
    out[cat] = { shows: agg.shows, truthUrls: agg.truthUrls, families: agg.families };
  }
  return out;
}

/**
 * One trend-ledger record for a completed run.
 *
 * `measuredRows` are the rows that count; excluded rows are still tallied by
 * state so a run that measured nothing says so instead of reporting a clean
 * recall computed over zero shows.
 *
 * @param {object} report {generatedAt, naivePages, shows:[rows]}
 * @param {object} [opts] {date}
 * @returns {object} trend record
 */
function summarizeRun(report, opts = {}) {
  const rows = Array.isArray(report && report.shows) ? report.shows : [];
  const measured = rows.filter(r => (r.sampleState || 'measured') === 'measured');
  const excluded = {};
  for (const r of rows) {
    const s = r.sampleState || 'measured';
    if (s === 'measured') continue;
    excluded[s] = (excluded[s] || 0) + 1;
  }
  const agg = perArmRecall(measured);
  const generatedAt = (report && report.generatedAt) || null;
  return {
    date: opts.date || (generatedAt ? String(generatedAt).slice(0, 10) : null),
    generatedAt,
    naivePages: (report && report.naivePages) !== undefined ? report.naivePages : null,
    shows: agg.shows,
    excluded,
    truthUrls: agg.truthUrls,
    onDiskUrls: measured.reduce((n, r) => n + ((r.counts && r.counts.onDisk) || 0), 0),
    newFromNaive: measured.reduce((n, r) => n + ((r.newFromNaive || []).length), 0),
    families: mapValues(agg.families, v => v.recall),
    arms: mapValues(agg.arms, v => v.recall),
    armsFailed: mapValues(agg.arms, v => v.failed),
    byCategory: mapValues(perCategoryRecall(measured), v => ({
      shows: v.shows,
      truthUrls: v.truthUrls,
      families: mapValues(v.families, f => f.recall),
    })),
    sampleIds: measured.map(r => r.showId),
  };
}

/**
 * Judge the latest run against the arms' own recent history.
 *
 * Verdicts, and why each exists rather than collapsing into "ok":
 *   blind              — too little history to compare. Saying "ok" here is
 *                        exactly how a detector reports health it has not
 *                        measured (the #647 lesson, arm-yield.js).
 *   insufficient-sample— the run's ground truth is too thin for a ratio to
 *                        mean anything.
 *   regressed          — an arm's recall fell >= dropThreshold below its own
 *                        median, or an arm that used to report vanished.
 *   ok                 — compared, nothing moved.
 *
 * @param {Array<object>} entries chronological trend records (latest last)
 * @param {object} [opts] overrides for REGRESSION_DEFAULTS
 * @returns {{verdict:string, reason:string, regressions:Array<object>, latest:object|null, comparedArms:number}}
 */
function detectRecallRegression(entries, opts = {}) {
  const cfg = { ...REGRESSION_DEFAULTS, ...opts };
  const list = (Array.isArray(entries) ? entries : []).filter(e => e && typeof e === 'object');
  const latest = list.length ? list[list.length - 1] : null;
  const prior = list.slice(0, -1).slice(-cfg.baselineRuns);

  if (!latest) {
    return { verdict: 'blind', reason: 'no trend entries recorded yet', regressions: [], latest: null, comparedArms: 0 };
  }
  if (prior.length < cfg.minBaselineRuns) {
    return {
      verdict: 'blind',
      reason: `only ${prior.length} prior run(s) on record (need ${cfg.minBaselineRuns}) — no baseline to judge against yet`,
      regressions: [], latest, comparedArms: 0,
    };
  }
  if ((latest.truthUrls || 0) < cfg.minTruthUrls) {
    return {
      verdict: 'insufficient-sample',
      reason: `latest run found only ${latest.truthUrls || 0} ground-truth URL(s) (need ${cfg.minTruthUrls}) — too thin for a recall comparison`,
      regressions: [], latest, comparedArms: 0,
    };
  }

  const latestFams = latest.families || {};
  const baselineArms = new Set(prior.flatMap(e => Object.keys(e.families || {})));
  const regressions = [];
  let comparedArms = 0;

  for (const arm of [...baselineArms].sort()) {
    const samples = prior
      .map(e => (e.families || {})[arm])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    if (samples.length < cfg.minBaselineRuns) continue;
    const baseline = median(samples);
    const current = latestFams[arm];

    if (typeof current !== 'number' || !Number.isFinite(current)) {
      // An arm that used to report and no longer appears is the dead-arm shape
      // — silence read as health is the failure this whole cadence exists to
      // stop, so it is a regression, not a skip.
      regressions.push({
        arm, baseline: round3(baseline), current: null, drop: round3(baseline),
        reason: `arm reported in ${samples.length} prior run(s) (median recall ${round3(baseline)}) but is absent from the latest run`,
      });
      continue;
    }
    comparedArms += 1;
    const drop = baseline - current;
    if (drop >= cfg.dropThreshold) {
      regressions.push({
        arm, baseline: round3(baseline), current: round3(current), drop: round3(drop),
        reason: `recall ${round3(current)} vs ${round3(baseline)} median over ${samples.length} prior run(s) — down ${round3(drop)} (threshold ${cfg.dropThreshold})`,
      });
    }
  }

  if (regressions.length) {
    return {
      verdict: 'regressed',
      reason: regressions.map(r => `${r.arm}: ${r.reason}`).join('; '),
      regressions, latest, comparedArms,
    };
  }
  if (comparedArms === 0) {
    return {
      verdict: 'blind',
      reason: `no arm has ${cfg.minBaselineRuns} comparable prior runs — nothing to judge`,
      regressions: [], latest, comparedArms: 0,
    };
  }
  return {
    verdict: 'ok',
    reason: `${comparedArms} arm(s) within ${cfg.dropThreshold} of their ${prior.length}-run median`,
    regressions: [], latest, comparedArms,
  };
}

/**
 * Did the whole run hit a dead scraping chain rather than a real recall drop?
 *
 * A missing key, an exhausted ScrapingBee cap or a dead Bright Data zone makes
 * every SERP arm return nothing — numerically identical to every arm having
 * regressed to zero. Recording that would put a fabricated collapse into the
 * median every future run is judged against, so the caller must record nothing
 * when this is true. The test is RAW results, not accepted URLs: a run can
 * legitimately accept zero (all results filtered as ticketing/wrong-production)
 * while the providers are perfectly healthy.
 *
 * `onDisk` is excluded — it is a filesystem read, not a provider call, and
 * counting it would mask an outage on any show that already has reviews.
 *
 * @param {Array<object>} rows report rows
 * @returns {{outage:boolean, serpRuns:number, productiveRuns:number}}
 */
function detectProviderOutage(rows) {
  const serpRuns = (Array.isArray(rows) ? rows : [])
    .flatMap(r => ((r && r.arms) || []).filter(a => a && a.arm !== 'onDisk'));
  const productiveRuns = serpRuns.filter(a => (Number(a.raw) || 0) > 0).length;
  return {
    outage: serpRuns.length > 0 && productiveRuns === 0,
    serpRuns: serpRuns.length,
    productiveRuns,
  };
}

/** Parse a JSONL trend file's contents into records, skipping unparseable lines. */
function parseTrendJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch { /* a torn line must not blind the whole detector */ }
  }
  return out;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round3(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n;
}

function mapValues(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = fn(v);
  return out;
}

module.exports = {
  REGRESSION_DEFAULTS,
  SETTLING_HOURS,
  armFamily,
  classifySample,
  detectProviderOutage,
  detectRecallRegression,
  parseTrendJsonl,
  perArmRecall,
  perCategoryRecall,
  summarizeRun,
};
