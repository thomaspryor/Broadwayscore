#!/usr/bin/env node
/**
 * haiku-swap-spotcheck.js (BRO-7527): old-vs-new spot check before a per-job
 * Haiku pin (scripts/lib/models.js VERIFIER_HAIKU, VIDEO_TITLES_HAIKU) moves
 * from Haiku 4.5 to Haiku 5.5. Runs each job's PRODUCTION code path with the
 * model pinned, on real past inputs, old model twice (noise floor) and new
 * model --reps-new times.
 *
 * Jobs:
 *   verifier: the 30 truth-labeled golden cases
 *     (tests/fixtures/content-verifier-golden/real-world-fixtures.json) through
 *     content-verifier.js verifyContent({ provider }) built from callAnthropic.
 *   titles: batches of 50 real video titles from data/video-reviews-discovery
 *     (creators production screens) through pre-classify-titles.js
 *     classifyTitleBatchWithUsage.
 *
 * Pass rules (fixed before the first run):
 *   verifier: new mean accuracy >= old mean accuracy - 1 case, new mean
 *     false-accepts (garbage called valid) <= old mean + 1, zero new API errors.
 *   titles: old-vs-new per-title agreement >= old-vs-old agreement - 2pp, new
 *     keeps >= 95% of titles both old runs flagged, zero new API errors.
 *
 * Spend: HARD cap (--cap-usd, default 10). Every reply's usage is priced at
 * the Haiku 4.5 rate whatever the model (conservative), and no call starts once
 * the running total plus a reserve for the calls already in flight (CONCURRENCY
 * x the largest single call seen, min $0.05 each) reaches the cap, so the
 * total cannot pass it. List-price spend is reported separately.
 *
 * Output: metadata only (case ids, labels, verdict flags, counts, video ids).
 * Never review text or prompts. One JSON object on stdout after the last line
 * "SPOTCHECK-JSON:".
 *
 * Usage: node scripts/evals/haiku-swap-spotcheck.js [--job=all|verifier|titles]
 *          [--cap-usd=10] [--reps-new=2] [--title-batches=40] [--probe-only]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { CLAUDE_HAIKU, CLAUDE_HAIKU_5 } = require('../lib/models');
const { estimateUSD } = require('../lib/autonomous-budget');

const arg = (name, dflt) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const JOB = arg('job', 'all');
const CAP_USD = Number(arg('cap-usd', '10'));
const REPS_OLD = 2;
const REPS_NEW = Number(arg('reps-new', '2'));
const TITLE_BATCHES = Number(arg('title-batches', '40'));
const PROBE_ONLY = process.argv.includes('--probe-only');
const OLD = CLAUDE_HAIKU;
const NEW = CLAUDE_HAIKU_5;
const CONCURRENCY = 4;
const FIXTURE = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'content-verifier-golden', 'real-world-fixtures.json');

// ---- spend meter (pure, exported for the unit test) ----
function createMeter(capUsd) {
  const t = { capUsd, capPricedUsd: 0, listUsd: 0, calls: 0, maxCallUsd: 0.05, byModel: {} };
  return {
    totals: t,
    // Reserve room for every call that may already be in flight.
    canSpend: () => t.capPricedUsd + CONCURRENCY * t.maxCallUsd < capUsd,
    record(usage, model) {
      const inT = (usage && (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)) || 0;
      const outT = (usage && usage.output_tokens) || 0;
      t.calls += 1;
      const callUsd = estimateUSD(OLD, inT, outT); // 4.5 rate for every model: never under-counts
      t.capPricedUsd += callUsd;
      if (callUsd > t.maxCallUsd) t.maxCallUsd = callUsd;
      t.listUsd += estimateUSD(model, inT, outT);
      const m = (t.byModel[model] ||= { calls: 0, inputTokens: 0, outputTokens: 0 });
      m.calls += 1; m.inputTokens += inT; m.outputTokens += outT;
    },
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const r3 = x => Math.round(x * 1000) / 1000;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ---- verifier job ----
async function runVerifier(meter) {
  const { verifyContent, callAnthropic } = require('../lib/content-verifier');
  const cases = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).cases;
  const runs = [];
  for (const [model, reps] of [[OLD, REPS_OLD], [NEW, REPS_NEW]]) {
    for (let rep = 0; rep < reps; rep++) {
      let errors = 0, capped = 0;
      const base = callAnthropic(model, { timeoutMs: 120000, onUsage: (u, m) => meter.record(u, m) });
      const call = async (prompt) => {
        try { return await base(prompt); } catch (e) { errors += 1; throw e; }
      };
      const verdicts = await pool(cases, CONCURRENCY, async (c) => {
        if (!meter.canSpend()) { capped += 1; return null; }
        const r = await verifyContent({ ...c.input, provider: { name: model, call } });
        return {
          id: c.id, isValid: !!r.isValid, verifiedBy: r.verifiedBy || null, confidence: r.confidence || null,
          wrongProduction: !!r.wrongProduction, wrongArticle: !!r.wrongArticle, truncated: !!r.truncated, isFilmTv: !!r.isFilmTv,
        };
      });
      runs.push({ model, rep, errors, capped, verdicts });
    }
  }
  const expected = new Map(cases.map(c => [c.id, !!(c.expected && c.expected.isValid)]));
  const score = (run) => {
    const v = run.verdicts.filter(x => x && x.verifiedBy && x.verifiedBy !== 'heuristic');
    return {
      model: run.model, rep: run.rep, scored: v.length, errors: run.errors, capped: run.capped,
      correct: v.filter(x => x.isValid === expected.get(x.id)).length,
      falseAccepts: v.filter(x => x.isValid && !expected.get(x.id)).length,
      falseRejects: v.filter(x => !x.isValid && expected.get(x.id)).length,
    };
  };
  const scores = runs.map(score);
  const verdictOf = (run) => new Map(run.verdicts.filter(Boolean).map(x => [x.id, x.isValid]));
  const agree = (a, b) => {
    const A = verdictOf(a), B = verdictOf(b);
    const ids = [...A.keys()].filter(k => B.has(k));
    return ids.length ? ids.filter(k => A.get(k) === B.get(k)).length / ids.length : null;
  };
  const oldRuns = runs.filter(r => r.model === OLD), newRuns = runs.filter(r => r.model === NEW);
  // Disagreement classes: case where old's majority and a new run differ, grouped by
  // (expected, old verdict -> new verdict) and the new run's flags.
  const classes = {};
  const oldMaj = verdictOf(oldRuns[0]);
  for (const nr of newRuns) {
    for (const v of nr.verdicts.filter(Boolean)) {
      if (!oldMaj.has(v.id) || oldMaj.get(v.id) === v.isValid) continue;
      const flags = ['wrongProduction', 'wrongArticle', 'truncated', 'isFilmTv'].filter(f => v[f]).join('+') || 'none';
      const key = `expected=${expected.get(v.id) ? 'valid' : 'garbage'} old=${oldMaj.get(v.id) ? 'valid' : 'invalid'} new=${v.isValid ? 'valid' : 'invalid'} newFlags=${flags}`;
      (classes[key] ||= []).push(v.id);
    }
  }
  const o = scores.filter(s => s.model === OLD), n = scores.filter(s => s.model === NEW);
  const pass = n.length > 0
    && n.every(s => s.errors === 0 && s.capped === 0 && s.scored === cases.length)
    && o.every(s => s.errors === 0 && s.capped === 0 && s.scored === cases.length)
    && mean(n.map(s => s.correct)) >= mean(o.map(s => s.correct)) - 1
    && mean(n.map(s => s.falseAccepts)) <= mean(o.map(s => s.falseAccepts)) + 1;
  return {
    cases: cases.length, scores,
    agreementOldOld: oldRuns.length > 1 ? r3(agree(oldRuns[0], oldRuns[1])) : null,
    agreementOldNew: newRuns.map(nr => r3(agree(oldRuns[0], nr))),
    disagreementClasses: classes,
    pass,
  };
}

// ---- titles job ----
function titleBatches(limit) {
  const { DISCOVERY_DIR, creatorsById } = require('../video-reviews/pre-classify-titles');
  const files = fs.readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.')).sort();
  const perFile = [];
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, f), 'utf8'));
    const creator = creatorsById.get(f.replace(/\.json$/, '').toLowerCase());
    if (data.platform === 'youtube' && !(creator && creator.titleScreen)) continue; // same screen as production
    const vids = (data.videos || []).filter(v => v && v.id && v.title);
    const batches = [];
    for (let i = 0; i + 1 < vids.length; i += 50) batches.push({ file: f, handle: data.handle, platform: data.platform, videos: vids.slice(i, i + 50) });
    perFile.push(batches);
  }
  const out = [];
  for (let i = 0; out.length < limit && perFile.some(b => b.length > i); i++) {
    for (const b of perFile) if (b[i] && out.length < limit) out.push(b[i]);
  }
  return out;
}

async function runTitles(meter) {
  const { classifyTitleBatchWithUsage } = require('../video-reviews/pre-classify-titles');
  const batches = titleBatches(TITLE_BATCHES);
  const runs = [];
  for (const [model, reps] of [[OLD, REPS_OLD], [NEW, REPS_NEW > 0 ? 1 : 0]]) {
    for (let rep = 0; rep < reps; rep++) {
      let errors = 0, capped = 0;
      const flagged = await pool(batches, CONCURRENCY, async (b) => {
        if (!meter.canSpend()) { capped += 1; return null; }
        try {
          const { indices, usage } = await classifyTitleBatchWithUsage(b.videos, b.handle, b.platform, model);
          meter.record(usage, model);
          return new Set(indices.map(i => b.videos[i - 1] && b.videos[i - 1].id).filter(Boolean));
        } catch { errors += 1; return null; }
      });
      runs.push({ model, rep, errors, capped, flagged });
    }
  }
  const labels = (run) => {
    const m = new Map();
    batches.forEach((b, i) => { if (run.flagged[i]) for (const v of b.videos) m.set(v.id, run.flagged[i].has(v.id)); });
    return m;
  };
  const agree = (a, b) => {
    const A = labels(a), B = labels(b);
    const ids = [...A.keys()].filter(k => B.has(k));
    return ids.length ? ids.filter(k => A.get(k) === B.get(k)).length / ids.length : null;
  };
  const oldRuns = runs.filter(r => r.model === OLD), newRun = runs.find(r => r.model === NEW);
  const o1 = labels(oldRuns[0]), o2 = labels(oldRuns[1]);
  const bothOld = [...o1.keys()].filter(k => o1.get(k) && o2.get(k));
  const N = newRun ? labels(newRun) : new Map();
  const kept = bothOld.filter(k => N.get(k) === true);
  const missed = bothOld.filter(k => N.has(k) && N.get(k) === false);
  const added = [...N.keys()].filter(k => N.get(k) && !o1.get(k) && !o2.get(k));
  const titles = batches.reduce((s, b) => s + b.videos.length, 0);
  const aOO = agree(oldRuns[0], oldRuns[1]);
  const aON = newRun ? agree(oldRuns[0], newRun) : null;
  const keptShare = bothOld.length ? kept.length / bothOld.length : null;
  const pass = !!newRun && runs.every(r => r.errors === 0 && r.capped === 0)
    && aON !== null && aOO !== null && aON >= aOO - 0.02
    && keptShare !== null && keptShare >= 0.95;
  return {
    batches: batches.length, titles,
    runs: runs.map(r => ({ model: r.model, rep: r.rep, errors: r.errors, capped: r.capped, flaggedTitles: r.flagged.reduce((s, x) => s + (x ? x.size : 0), 0) })),
    agreementOldOld: aOO === null ? null : r3(aOO), agreementOldNew: aON === null ? null : r3(aON),
    flaggedByBothOld: bothOld.length, keptByNew: kept.length, keptShare: keptShare === null ? null : r3(keptShare),
    missedByNew: missed, addedByNew: added.length,
    pass,
  };
}

// ---- probe: one tiny call per model with the exact production body shape ----
async function probe(meter) {
  const { callAnthropic } = require('../lib/content-verifier');
  const out = {};
  for (const model of [OLD, NEW]) {
    try {
      const text = await callAnthropic(model, { timeoutMs: 60000, onUsage: (u, m) => meter.record(u, m) })('Reply with exactly: {"ok": true}');
      out[model] = { ok: /\{\s*"ok"\s*:\s*true\s*\}/.test(text), textChars: text.length };
    } catch (e) {
      out[model] = { ok: false, error: String(e.message).slice(0, 160) };
    }
  }
  return out;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
  if (!(CAP_USD > 0 && CAP_USD <= 10)) { console.error('--cap-usd must be in (0, 10] (BRO-7527 hard cap)'); process.exit(1); }
  const meter = createMeter(CAP_USD);
  const result = { card: 'BRO-7527', at: new Date().toISOString(), oldModel: OLD, newModel: NEW, capUsd: CAP_USD };
  result.probe = await probe(meter);
  console.log('probe:', JSON.stringify(result.probe));
  if (!PROBE_ONLY && result.probe[NEW] && result.probe[NEW].ok) {
    if (JOB === 'all' || JOB === 'verifier') { result.verifier = await runVerifier(meter); console.log('verifier pass:', result.verifier.pass); }
    if (JOB === 'all' || JOB === 'titles') { result.titles = await runTitles(meter); console.log('titles pass:', result.titles.pass); }
  }
  result.spend = { ...meter.totals, capPricedUsd: r3(meter.totals.capPricedUsd), listUsd: r3(meter.totals.listUsd) };
  console.log('SPOTCHECK-JSON:');
  console.log(JSON.stringify(result));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { createMeter, titleBatches };
