'use strict';
/**
 * Grade an opening-night lane replay the way a real press night is graded (BRO-5201 S4-T6).
 *
 * A replay (tests/unit/opening-night-lane-replay-*.test.mjs) runs the real lane wiring against recorded pages with an
 * injected clock. This module gives it:
 *   - createReplaySitePorts: a modelled site behind the lane's publish ports. Merges rows with the lane's own
 *     mergeShowRows, makes a deployed row live after deployLagMs, and answers fetchLiveShow from that, so the lane
 *     logs rebuilt / deployed / verified-live as on a real night (the shadow ports apply nothing).
 *   - replayToPressNightRecord: the press-night record (lib/press-night-record.js) of that night: per-review live
 *     times sampled through applySample, the review-file snapshot read with press-night-review-state (the
 *     firstSeenAt the lane writer stamps), the census at +2h and the lane shadow's start and first discovery.
 *   - gradeReplay: evaluateCheck on that record; the observed-release grade (BRO-6614) when there is one.
 * No network, no copyrighted text: everything comes from the replay's own fixtures and tmp dirs.
 */
const ledger = require('./opening-night-lane/ledger');
const pnr = require('./press-night-record');
const { readReviewFileState } = require('./press-night-review-state');

const MIN = 60 * 1000;

/**
 * Publish ports for a modelled site. `live()` lists {url, row, liveAt} for every row that went live.
 * @param {{now: () => number, deployLagMs?: number}} opts
 */
function createReplaySitePorts({ now, deployLagMs = 0 } = {}) {
  if (typeof now !== 'function') throw new Error('lane-replay-grade: now is required');
  let doc = { reviews: [] };
  const pending = []; // rows merged but not deployed yet
  const deployed = []; // {row, liveAt}
  return {
    async updateReviews(fn) {
      const out = fn(doc);
      doc = out.doc;
      pending.push(...(out.applied || []));
      return { doc: out.doc, added: out.added, replaced: out.replaced, kept: out.kept, applied: out.applied || [] };
    },
    async pushData() { return { pushed: true }; },
    async isLeased() { return true; },
    async regenShow() { return { missing: [] }; },
    async deploy() {
      const at = now() + deployLagMs;
      for (const row of pending.splice(0)) deployed.push({ row, liveAt: at });
    },
    async fetchLiveShow() {
      const t = now();
      return { rv: deployed.filter((d) => d.liveAt <= t).map((d) => ({ u: d.row.url })) };
    },
    live() { return deployed.map((d) => ({ url: d.row.url, row: d.row, liveAt: d.liveAt })); },
  };
}

/**
 * The press-night record of a replayed night.
 * @param {object} args
 *   show {id, openingDate, category}, night, embargoAt (ISO; default the market embargo), live (site.live()),
 *   ledgerDir, reviewTextsDir (the review-texts ROOT), censusOutletIds (outlets the aggregators listed),
 *   startedAt (ms, when the lane started polling), closedAt (ms, when the night is captured; at least embargo +3h30m
 *   or the gate reads unknown), sampleEveryMs (probe interval, default 2 min)
 */
function replayToPressNightRecord({ show, night, embargoAt = null, live, ledgerDir, reviewTextsDir, censusOutletIds = [], startedAt, closedAt, sampleEveryMs = 2 * MIN }) {
  const emb = embargoAt || pnr.defaultEmbargoAt(show);
  if (!emb) throw new Error(`lane-replay-grade: no embargo for ${show && show.id}`);
  const embargoSource = embargoAt ? pnr.classifyEmbargo(show, embargoAt) : 'market-default';
  const rec = pnr.emptyRecord({ showId: show.id, night, market: show.category, embargoAt: emb, embargoSource, intervalMin: sampleEveryMs / MIN });
  // Probe samples from before anything was live (so no review reads as baseline) to the capture.
  const firstLive = live.length ? Math.min(...live.map((l) => l.liveAt)) : startedAt;
  const from = Math.min(startedAt, firstLive) - sampleEveryMs;
  const asSample = (l) => ({ outlet: l.row.outlet || l.row.outletId, critic: l.row.criticName || null, tier: l.row.tier || null, date: l.row.publishDate || null });
  for (let t = from; t <= closedAt; t += sampleEveryMs) {
    pnr.applySample(rec, { at: new Date(t).toISOString(), reviews: live.filter((l) => l.liveAt <= t).map(asSample) });
  }
  rec.probe.endedAt = new Date(closedAt).toISOString();

  // Census at +2h, shaped like referenceFrom: a listed outlet is covered when a review of it was live by then.
  const t2 = Date.parse(emb) + 2 * 60 * MIN;
  const liveBy = (t) => new Set(live.filter((l) => l.liveAt <= t).map((l) => l.row.outletId).filter(Boolean));
  const census = [...new Set(censusOutletIds)];
  const at2 = liveBy(t2);
  const missing = census.filter((o) => !at2.has(o));
  const reference = (missingIds, at) => (census.length ? {
    status: missingIds.length ? 'gaps' : 'complete', source: ['replay'], count: census.length, covered: census.length - missingIds.length,
    coverage: Math.round(((census.length - missingIds.length) / census.length) * 1000) / 1000, missing: missingIds, suppressedMissing: [],
    liveCount: live.filter((l) => l.liveAt <= at).length, fetchedAt: new Date(at).toISOString(),
  } : { status: 'no-census-yet', source: null, count: 0, covered: null, coverage: null, missing: [], liveCount: 0, fetchedAt: new Date(at).toISOString() });
  rec.reference['2h'] = reference(missing, t2);
  const atEnd = liveBy(closedAt);
  rec.reference.end = reference(census.filter((o) => !atEnd.has(o)), closedAt);

  // The lane shadow's start and first discovery (observed release, BRO-6614).
  const rows = ledger.readLedger(ledgerDir, show.id, night).events;
  const disc = rows.filter((r) => r.stage === 'discovered').map((r) => Date.parse(r.at)).filter(Number.isFinite);
  rec.laneShadow = {
    startedAt: new Date(startedAt).toISOString(),
    firstDiscoveredAt: disc.length ? new Date(Math.min(...disc)).toISOString() : null,
    liveFirstSeen: [],
  };

  // The review files the lane wrote, as the probe's late checkout reads them.
  const state = readReviewFileState(show.id, show, { dir: reviewTextsDir });
  rec.fileState = { capturedAt: new Date(closedAt).toISOString(), files: state.available ? state.files : [] };
  return rec;
}

/** Lane-side errors that are failures of the lane itself, not of a source page (a 404 before reviews drop is normal). */
const LANE_ERROR_ADAPTERS = new Set(['publish', 'memo']);

/**
 * Grade a replayed night. Uses the observed-release grade when the release looked late (BRO-6614), else the
 * assumed-embargo grade. A lane run that failed a review for good, left a scored review unpublished, or hit a publish
 * or memo error never grades PASS on same-night completeness. A source that errored or listed nothing is not a lane
 * failure on its own: what it cost shows up in the census and review-file gates (sourceErrors lists them).
 * @returns {{verdict, gates, sameNight: {status, detail}, release: object|null, runProblems: string[], sourceErrors: object[]}}
 */
function gradeReplay(rec, run = {}) {
  const res = pnr.evaluateCheck(rec);
  const graded = res.release && res.release.observed ? res.release.observed : res;
  const errors = run.errors || [];
  const runProblems = [
    ...errors.filter((e) => e && LANE_ERROR_ADAPTERS.has(e.adapter)).map((e) => `${e.adapter} error: ${e.error}`),
    ...(run.failed || []).map((f) => `review failed: ${f && f.key} (${f && f.reason})`),
    ...(run.unpublished || []).map((u) => `scored but unpublished: ${(u && (u.key || u.url)) || JSON.stringify(u)}`),
  ];
  const gates = graded.gates.map((g) => (g.name === 'same-night-completeness' && runProblems.length && g.status === 'pass'
    ? { ...g, status: 'fail', detail: `the lane run reported problems: ${runProblems.join('; ')}` } : g));
  const sn = gates.find((g) => g.name === 'same-night-completeness');
  const required = gates.filter((g) => g.required);
  const verdict = required.some((g) => g.status === 'fail') ? 'FAIL' : (required.every((g) => g.status === 'pass') ? 'PASS' : 'UNKNOWN');
  return { verdict, gates, sameNight: { status: sn.status, detail: sn.detail }, release: res.release || null, runProblems, sourceErrors: errors.filter((e) => !(e && LANE_ERROR_ADAPTERS.has(e.adapter))) };
}

module.exports = { createReplaySitePorts, replayToPressNightRecord, gradeReplay };
