#!/usr/bin/env node
/**
 * Rolling-EMA per-model calibration offset (Phase B, Notion 367637c5-416f-81a3;
 * generalized to all 4 ensemble models, BRO-197, Notion 3b5637c5-416f-81ec)
 *
 * Gemini was the most frequent sole outlier in the ensemble (1003/2608 = 38.5%
 * of data/audit/ensemble-sole-outlier-queue.jsonl) and, when it's the outlier,
 * scores a mean +12.2pts HIGHER than the majority (82% of those cases are
 * positive gaps). GEMINI_CALIBRATION_OFFSET in config.ts is a static hardcoded
 * 0 — this script computes a rolling exponential moving average of a model's
 * signed bias so that value can eventually be driven by data instead of by
 * hand, the same way MAJORITY_WEIGHT's 1.5→1.4 change was driven by the 72h
 * observation on Phase A. The same audit data has sole-outlier cases for the
 * other 3 ensemble models too (openai 687, claude 505, kimi 413) — this script
 * now computes an EMA for any of the 4 via --model=<name>.
 *
 * Scope (deliberately narrow): this script COMPUTES and PERSISTS a recommended
 * offset. It does NOT write to config.ts or change live scoring — wiring a
 * recommendation into a live *_CALIBRATION_OFFSET is a follow-up decision that
 * should go through the same flag-gated + observed rollout Phase A/B did.
 *
 * State: data/audit/{model}-calibration-ema-state.json — { model, alpha, ema,
 * sampleCount, recommendedOffset, lastSeededAt/lastUpdatedAt }. One file per
 * model so seeding one doesn't clobber another; the default model (gemini)
 * keeps writing to the original data/audit/gemini-calibration-ema-state.json
 * path for backward compatibility.
 *
 * Usage:
 *   node scripts/llm-scoring/gemini-calibration-ema.js --seed                    # (re)build EMA for gemini (default) from the historical queue
 *   node scripts/llm-scoring/gemini-calibration-ema.js --model=openai --seed     # same, for another ensemble model
 *   node scripts/llm-scoring/gemini-calibration-ema.js --report                 # print current state (gemini by default)
 *   node scripts/llm-scoring/gemini-calibration-ema.js --model=claude --update=<gap>  # append one new signed-gap observation
 *
 * Caveat: ensemble-sole-outlier-queue.jsonl has no timestamps and is sorted
 * alphabetically by showId — --seed's "file order" carries NO chronological
 * signal at all (verified: 0 out-of-order adjacent pairs by showId across all
 * 2608 rows). Its EMA output is closer to a flat/weighted average over
 * whichever shows happen to sort last than a true recency-weighted estimate.
 * Treat --seed as a one-time bootstrap number, not a trend; --update is the
 * intended path for genuinely time-ordered incremental calibration once
 * wired into the live scoring pipeline.
 */

const fs = require('fs');
const path = require('path');

const QUEUE_PATH = path.join(__dirname, '../../data/audit/ensemble-sole-outlier-queue.jsonl');
const AUDIT_DIR = path.join(__dirname, '../../data/audit');

const VALID_MODELS = ['gemini', 'openai', 'claude', 'kimi'];
const DEFAULT_MODEL = 'gemini';
const MODEL_LABELS = { gemini: 'Gemini', openai: 'OpenAI', claude: 'Claude', kimi: 'Kimi' };

// Slow-moving average by design: the seed sample is a disagreement-biased
// selection (only sole-outlier cases), so a low alpha avoids overreacting to
// any single batch of scoring runs.
const DEFAULT_ALPHA = 0.05;

function statePath(model = DEFAULT_MODEL) {
  return path.join(AUDIT_DIR, `${model}-calibration-ema-state.json`);
}

/**
 * Signed gap between a model's score and the mean of the other models in the
 * same ensemble call, for entries where that model is the sole outlier.
 * Positive = the model scored higher than the majority. Returns null when
 * the entry isn't a sole-outlier case for this model or has no other models
 * to compare against.
 */
function computeSignedGap(entry, model = DEFAULT_MODEL) {
  if (!entry || !entry.outlier || entry.outlier.model !== model) return null;
  if (!Array.isArray(entry.models)) return null;
  const others = entry.models.filter(m => m.model !== model).map(m => m.score);
  if (others.length === 0) return null;
  const majorityMean = others.reduce((s, v) => s + v, 0) / others.length;
  return entry.outlier.score - majorityMean;
}

/**
 * Fold a sequence of signed-gap observations into an EMA, starting from seed.
 * ema_t = alpha * observation_t + (1 - alpha) * ema_(t-1)
 */
function computeEma(observations, alpha = DEFAULT_ALPHA, seed = 0) {
  return observations.reduce((ema, obs) => alpha * obs + (1 - alpha) * ema, seed);
}

/** *_CALIBRATION_OFFSET is added to the model's raw score, so the correction runs opposite the bias. */
function recommendedOffsetFromEma(ema) {
  return -Math.round(ema);
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) {
    console.error(`Queue file not found: ${QUEUE_PATH}`);
    console.error('This is the ensemble-sole-outlier-queue.jsonl audit log — nothing to seed from.');
    process.exit(1);
  }
  return fs.readFileSync(QUEUE_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function loadState(model = DEFAULT_MODEL) {
  const p = statePath(model);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`State file is corrupted: ${p}`);
    console.error(`Delete it and re-run with --seed to rebuild. (${err.message})`);
    process.exit(1);
  }
}

function saveState(model, state) {
  fs.writeFileSync(statePath(model), JSON.stringify(state, null, 2) + '\n');
}

function seed(model = DEFAULT_MODEL, alpha = DEFAULT_ALPHA) {
  const entries = loadQueue();
  const gaps = entries.map(e => computeSignedGap(e, model)).filter(g => g !== null);
  const ema = computeEma(gaps, alpha, 0);
  const state = {
    model,
    alpha,
    ema,
    sampleCount: gaps.length,
    recommendedOffset: recommendedOffsetFromEma(ema),
    source: 'ensemble-sole-outlier-queue.jsonl (file-order bootstrap, no real timestamps)',
    lastSeededAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
  saveState(model, state);
  return state;
}

function update(model = DEFAULT_MODEL, gap) {
  const state = loadState(model) || { model, alpha: DEFAULT_ALPHA, ema: 0, sampleCount: 0 };
  const ema = computeEma([gap], state.alpha, state.ema);
  const next = {
    ...state,
    model,
    ema,
    sampleCount: state.sampleCount + 1,
    recommendedOffset: recommendedOffsetFromEma(ema),
    lastUpdatedAt: new Date().toISOString(),
  };
  saveState(model, next);
  return next;
}

function report(model = DEFAULT_MODEL) {
  const state = loadState(model);
  if (!state) {
    console.log(`No state file yet for ${model}. Run with --seed first.`);
    return null;
  }
  const label = MODEL_LABELS[model] || model;
  console.log(`${label} calibration EMA (alpha=${state.alpha}, n=${state.sampleCount})`);
  console.log(`  Rolling signed-gap EMA: ${state.ema.toFixed(2)}pts (positive = ${label} scores high)`);
  console.log(`  Recommended ${model.toUpperCase()}_CALIBRATION_OFFSET: ${state.recommendedOffset}`);
  console.log(`  Current live value (config.ts): 0 (unwired — this is a recommendation, not applied)`);
  console.log(`  Last updated: ${state.lastUpdatedAt}`);
  return state;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const modelArg = args.find(a => a.startsWith('--model='));
  const model = modelArg ? modelArg.split('=')[1] : DEFAULT_MODEL;
  if (!VALID_MODELS.includes(model)) {
    console.error(`Unknown --model=${model}. Valid models: ${VALID_MODELS.join(', ')}`);
    process.exit(1);
  }

  if (args.includes('--seed')) {
    const state = seed(model);
    console.log(`Seeded from ${state.sampleCount} historical ${model}-outlier cases.`);
    report(model);
  } else if (args.find(a => a.startsWith('--update='))) {
    const gap = parseFloat(args.find(a => a.startsWith('--update=')).split('=')[1]);
    if (!Number.isFinite(gap)) {
      console.error('Usage: --update=<signed gap, e.g. --update=14.5> (must be a finite number)');
      process.exit(1);
    }
    update(model, gap);
    report(model);
  } else {
    report(model);
  }
}

module.exports = {
  computeSignedGap,
  computeEma,
  recommendedOffsetFromEma,
  seed,
  update,
  report,
  statePath,
  VALID_MODELS,
  DEFAULT_MODEL,
  DEFAULT_ALPHA,
};
