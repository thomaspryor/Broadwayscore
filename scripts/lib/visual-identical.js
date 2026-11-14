'use strict';
/**
 * visual-identical.js (BRO-7491 Phase 1, SHADOW ONLY): decide whether a change looks pixel-identical
 * before and after. Pure helpers plus a sharp-based image compare. Nothing here may skip the owner's ask.
 * The real auto-approval (Phase 2) runs in CI where the site data exists; this phase only collects evidence.
 */
const fs = require('fs');

// A pixel differs when any colour channel moves by more than CHANNEL_DELTA. A pair is the same only when
// at most MAX_DIFF_PIXELS pixels differ, an absolute cap so a tall page cannot hide a thin scattered change
// (reviewers: a ratio let 5,760 pixels through on a 1440x20000 shot).
const CHANNEL_DELTA = 4;
const MAX_DIFF_PIXELS = 20;
const SHADOW_MARK = 'Before/after screenshot check (trial run, you were still asked):';

/** Compare two image files. Fails closed: anything unreadable, missing or a different size is "different". */
async function compareImages(aPath, bPath, opts = {}) {
  const channelDelta = opts.channelDelta ?? CHANNEL_DELTA;
  const maxDiff = opts.maxDiffPixels ?? MAX_DIFF_PIXELS;
  try {
    if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) return { same: false, reason: 'missing image' };
    const sharp = (await import('sharp')).default;
    const [a, b] = await Promise.all([aPath, bPath].map((p) => sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
    if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
      return { same: false, reason: `size differs (${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height})` };
    }
    let diff = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (Math.abs(a.data[i] - b.data[i]) > channelDelta || Math.abs(a.data[i + 1] - b.data[i + 1]) > channelDelta
        || Math.abs(a.data[i + 2] - b.data[i + 2]) > channelDelta || Math.abs(a.data[i + 3] - b.data[i + 3]) > channelDelta) diff++;
    }
    return { same: diff <= maxDiff, diffPixels: diff, reason: diff <= maxDiff ? '' : `${diff} pixels differ` };
  } catch (e) {
    return { same: false, reason: `could not compare: ${e.message}` };
  }
}

/**
 * pairs: [{ route, width, state, status: 'same'|'different'|'error', reason }]; canaryOk: the self-test showed a known
 * 1-pixel-class change is detected. Returns the outcome: identical | different | could-not-render | invalid.
 * Only 'identical' means every pair was captured and matched; empty input, an error or a failed canary never does.
 */
function decide(pairs, canaryOk) {
  const list = Array.isArray(pairs) ? pairs : [];
  if (canaryOk !== true) return { outcome: 'invalid', identical: false, reasons: ['the self-test could not prove a real change would be noticed'] };
  if (!list.length) return { outcome: 'could-not-render', identical: false, reasons: ['no screenshot pairs were captured'] };
  const errors = list.filter((p) => p.status === 'error');
  if (errors.length) return { outcome: 'could-not-render', identical: false, reasons: errors.slice(0, 5).map((p) => `${p.route} @ ${p.width}${p.state ? ` (${p.state})` : ''}: ${p.reason || 'error'}`) };
  const different = list.filter((p) => p.status !== 'same');
  if (different.length) return { outcome: 'different', identical: false, reasons: different.slice(0, 5).map((p) => `${p.route} @ ${p.width}${p.state ? ` (${p.state})` : ''}: ${p.reason || 'differs'}`) };
  return { outcome: 'identical', identical: true, reasons: [] };
}

const OUTCOME_TEXT = {
  identical: (n) => `every one of the ${n} before/after pictures matched.`,
  different: () => 'the pictures differ, as expected for a visible change.',
  'could-not-render': () => 'the pages could not be captured (not a verdict on the change).',
  invalid: () => 'the check could not prove it would notice a change, so its result was thrown away.',
};

/** What a shadow run records. skipAsk is ALWAYS false in Phase 1 (class guard: tested directly). */
function shadowDecision(report, patch) {
  if (!report || typeof report !== 'object') return { skipAsk: false, outcome: 'not-run', line: `${SHADOW_MARK} not run.` };
  if (report.schema !== 1 || !report.patch || (patch && report.patch !== patch)) return { skipAsk: false, outcome: 'not-run', line: `${SHADOW_MARK} not run on this version of the change.` };
  const d = decide(report.pairs, report.canaryOk);
  const text = (OUTCOME_TEXT[d.outcome] || OUTCOME_TEXT.invalid)((report.pairs || []).length);
  return { skipAsk: false, outcome: d.outcome, line: `${SHADOW_MARK} ${text}` };
}

module.exports = { compareImages, decide, shadowDecision, CHANNEL_DELTA, MAX_DIFF_PIXELS, SHADOW_MARK };
