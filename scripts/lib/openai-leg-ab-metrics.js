/**
 * Pure metrics + gates for the OpenAI-leg migration A/B (owner plan 2026-11-09:
 * move the scoring ensemble's OpenAI leg off gpt-4o, which OpenAI retires on
 * 2027-01-14). Input: one record per sampled past review, written by
 * scripts/llm-scoring/openai-leg-shadow.ts. Each record holds the CONTROL final
 * (production pipeline, gpt-4o leg) and the SHADOW final (same fresh Claude and
 * Gemini outputs, candidate model in the OpenAI leg, same combine/clamp/stretch).
 *
 * Gates (all must pass to recommend a switch):
 *   bucketShiftPp   every final-bucket share, incl. Mixed, moves <= 5pp (CLAUDE.md §13)
 *   meanDrift       |mean signed final-score change| <= 2 pts (stricter than §13's 5)
 *   rejectionDelta  rejected share moves <= 2pp (pre-mortem: mini rejecting more)
 *   showDrift       <= 10% of shows (>= 5 sampled reviews) move > 2 pts;
 *                   fewer than 10 such shows = not enough evidence = FAIL
 *   legAccuracy     shadow leg's MAE to the critic's star-band midpoint is no
 *                   worse than the control leg's + 1 pt (band-clamped finals hide this)
 *   shadowErrors    the shadow OpenAI CALL's own error rate <= 1% (a failed leg
 *                   leaves a valid 2-model ensemble, so arm success hides it),
 *                   plus whole-arm failures
 *   legAccuracy needs >= 30 star-banded pairs; fewer = FAIL (no vacuous pass)
 * Shares are reweighted to the population (rec.weight) because the sample is
 * stratified.
 */
'use strict';

const BUCKETS = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];

const GATES = Object.freeze({
  bucketShiftPp: 5,
  meanDrift: 2,
  rejectionDeltaPp: 2,
  showDriftPts: 2,
  showDriftMaxShare: 0.10,
  showMinReviews: 5,
  legAccuracySlack: 1,
  shadowErrorMaxRate: 0.01,
  showMinShows: 10,
  legAccuracyMinPairs: 30,
});

/** 'rejected' | 'failed' | a bucket, for one arm of one record. */
function outcomeClass(arm) {
  if (!arm) return 'failed';
  if (arm.rejected) return 'rejected';
  if (!arm.success || !BUCKETS.includes(arm.bucket)) return 'failed';
  return arm.bucket;
}

function weightedShares(records, armKey) {
  const totals = Object.fromEntries([...BUCKETS, 'rejected'].map((k) => [k, 0]));
  let denom = 0;
  for (const r of records) {
    const c = outcomeClass(r[armKey]);
    if (c === 'failed') continue;
    const w = r.weight || 1;
    totals[c] += w;
    denom += w;
  }
  const shares = {};
  for (const k of Object.keys(totals)) shares[k] = denom ? totals[k] / denom : 0;
  return { shares, denom };
}

function legMidpointError(arm, band) {
  if (!band || !arm || !Number.isFinite(arm.openaiScore)) return null;
  const mid = (band.floor + band.ceiling) / 2;
  return Math.abs(arm.openaiScore - mid);
}

/** records -> full report with per-gate pass/fail. Records where control failed are excluded and counted. */
function computeReport(records) {
  const usable = records.filter((r) => outcomeClass(r.control) !== 'failed');
  const controlFailed = records.length - usable.length;

  // Paired: both arms' shares are taken over the SAME reviews (both arms
  // produced a score or a rejection). Dropping shadow failures from only the
  // shadow side would let a model that fails on the hardest reviews look
  // better; those failures are gated separately (shadowErrors).
  const paired = usable.filter((r) => outcomeClass(r.shadow) !== 'failed');
  const c = weightedShares(paired, 'control');
  const s = weightedShares(paired, 'shadow');
  const bucketShiftPp = {};
  for (const b of BUCKETS) bucketShiftPp[b] = +(100 * (s.shares[b] - c.shares[b])).toFixed(2);
  const rejectionDeltaPp = +(100 * (s.shares.rejected - c.shares.rejected)).toFixed(2);

  let wSum = 0; let dSum = 0; let moved5 = 0; let flips = 0; let both = 0;
  const perShow = new Map();
  for (const r of usable) {
    if (outcomeClass(r.control) === 'rejected' || ['rejected', 'failed'].includes(outcomeClass(r.shadow))) continue;
    const d = r.shadow.score - r.control.score;
    const w = r.weight || 1;
    wSum += w; dSum += w * d; both += 1;
    if (Math.abs(d) > 5) moved5 += 1;
    if (r.shadow.bucket !== r.control.bucket) flips += 1;
    const ps = perShow.get(r.showId) || { n: 0, sum: 0 };
    ps.n += 1; ps.sum += d; perShow.set(r.showId, ps);
  }
  const meanDrift = wSum ? +(dSum / wSum).toFixed(2) : 0;
  const shows = [...perShow.entries()].filter(([, v]) => v.n >= GATES.showMinReviews).map(([id, v]) => ({ showId: id, n: v.n, meanDelta: +(v.sum / v.n).toFixed(2) }));
  const showsOver = shows.filter((x) => Math.abs(x.meanDelta) > GATES.showDriftPts);

  const errs = { control: [], shadow: [] };
  for (const r of usable) {
    const ec = legMidpointError(r.control, r.band); const es = legMidpointError(r.shadow, r.band);
    if (ec !== null && es !== null) { errs.control.push(ec); errs.shadow.push(es); }
  }
  const mae = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
  const legMae = { control: mae(errs.control), shadow: mae(errs.shadow), n: errs.control.length };

  // A leg error = the OpenAI call itself failed (not a rejection). Whole-arm
  // failures count too. Control's rate is reported for comparison.
  const legFailed = (a) => outcomeClass(a) === 'failed' || (a && a.openaiLegOk === false && !a.openaiLegRejected);
  const shadowFailed = usable.filter((r) => legFailed(r.shadow)).length;
  const controlLegFailed = usable.filter((r) => legFailed(r.control)).length;
  const shadowErrorRate = usable.length ? shadowFailed / usable.length : 0;

  const gates = {
    bucketShiftPp: { pass: BUCKETS.every((b) => Math.abs(bucketShiftPp[b]) <= GATES.bucketShiftPp), value: bucketShiftPp, limit: GATES.bucketShiftPp },
    meanDrift: { pass: Math.abs(meanDrift) <= GATES.meanDrift, value: meanDrift, limit: GATES.meanDrift },
    rejectionDelta: { pass: Math.abs(rejectionDeltaPp) <= GATES.rejectionDeltaPp, value: rejectionDeltaPp, limit: GATES.rejectionDeltaPp },
    showDrift: { pass: shows.length >= GATES.showMinShows && showsOver.length / shows.length <= GATES.showDriftMaxShare, value: { showsChecked: shows.length, showsOver: showsOver.length, worst: showsOver.sort((a, b) => Math.abs(b.meanDelta) - Math.abs(a.meanDelta)).slice(0, 10) }, limit: GATES.showDriftMaxShare },
    legAccuracy: { pass: legMae.n >= GATES.legAccuracyMinPairs && legMae.shadow <= legMae.control + GATES.legAccuracySlack, value: legMae, limit: GATES.legAccuracySlack },
    shadowErrors: { pass: shadowErrorRate <= GATES.shadowErrorMaxRate, value: { shadow: +shadowErrorRate.toFixed(4), control: usable.length ? +(controlLegFailed / usable.length).toFixed(4) : 0 }, limit: GATES.shadowErrorMaxRate },
  };
  return {
    sampled: records.length,
    usable: usable.length,
    paired: paired.length,
    controlFailed,
    scoredBoth: both,
    sharesControl: c.shares,
    sharesShadow: s.shares,
    movedOver5Pts: both ? +(moved5 / both).toFixed(4) : 0,
    bucketFlips: both ? +(flips / both).toFixed(4) : 0,
    gates,
    allPass: Object.values(gates).every((g) => g.pass),
  };
}

module.exports = { BUCKETS, GATES, outcomeClass, weightedShares, computeReport };
