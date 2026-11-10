'use strict';

/**
 * press-night-runs.js (BRO-6863): what a press-night record keeps about the night's pipeline, so
 * press-night-watchdog-replay.js can replay the score / rebuild / deploy stages from the record alone.
 *
 * At --capture-reference --label=end, press-night-record.js:
 *   - stamps perReview[].scoredAt (llmMetadata.scoredAt of the matching review file, via fileState.files) and
 *     fileState.files[].inCoreAtEnd (is the review in core reviews.json at the end of the night);
 *   - saves the night's runs of the five watched workflows as rec.pipelineRuns, window embargo -2h to +3h, fields
 *     {workflow,status,conclusion,displayTitle,startedAt,updatedAt}.
 * reviews.json carries no scoring time, so scoredAt comes from the review files; reviews.json says only whether a
 * review made it into core by the end.
 *
 * Pure: the caller does the gh / file reads.
 */

const MIN = 60000;
// The workflows press-night-watchdog.js reads (scripts/press-night-watchdog.js recentRuns).
const WATCHED_WORKFLOWS = ['opening-night-orchestrator.yml', 'opening-night-poller.yml', 'llm-ensemble-score.yml', 'rebuild-fast.yml', 'vercel-deploy.yml'];
const WINDOW_BEFORE_MIN = 120;
const WINDOW_AFTER_MIN = 180;
// Runs are listed by creation time; a run created up to this long before the window can still be running in it.
const LIST_LEAD_MIN = 60;

const foldKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const toMs = (t) => (t == null || t === '' ? NaN : Date.parse(t));

/** The window [embargo -2h, +3h], and the creation range to list runs over. Null for a bad embargo. */
function runsWindow(embargoAt) {
  const e = toMs(embargoAt);
  if (!Number.isFinite(e)) return null;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); // GitHub's created= syntax has no milliseconds
  return {
    from: iso(e - WINDOW_BEFORE_MIN * MIN), to: iso(e + WINDOW_AFTER_MIN * MIN),
    listFrom: iso(e - (WINDOW_BEFORE_MIN + LIST_LEAD_MIN) * MIN), listTo: iso(e + WINDOW_AFTER_MIN * MIN),
  };
}

/** One GitHub API workflow run (REST shape, or gh run list's camelCase) -> the record's run row. */
function slimRun(run, workflow) {
  return {
    workflow,
    status: run.status || null,
    conclusion: run.conclusion || null,
    displayTitle: run.display_title != null ? run.display_title : (run.displayTitle != null ? run.displayTitle : null),
    startedAt: run.run_started_at || run.startedAt || run.created_at || run.createdAt || null,
    updatedAt: run.updated_at || run.updatedAt || null,
  };
}

/** Runs active at any point in the window (started by its end, last updated at/after its start), sorted by start. */
function selectWindowRuns(runs, win) {
  const from = toMs(win.from);
  const to = toMs(win.to);
  return (runs || []).filter((r) => {
    const s = toMs(r.startedAt);
    const u = toMs(r.updatedAt);
    return Number.isFinite(s) && s <= to && (!Number.isFinite(u) || u >= from);
  }).sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt) || String(a.workflow).localeCompare(String(b.workflow)));
}

/**
 * rec.pipelineRuns from a listing per workflow: {workflow -> {runs:[api runs]} | {error}}. Complete only when every
 * watched workflow listed; a partial listing would read as "that workflow never ran", so the replay ignores it.
 */
function pipelineRunsFrom(listing, win, capturedAt) {
  const errors = [];
  const runs = [];
  for (const wf of WATCHED_WORKFLOWS) {
    const got = listing[wf];
    if (!got || got.error || !Array.isArray(got.runs)) { errors.push({ workflow: wf, error: String((got && got.error) || 'not listed').slice(0, 160) }); continue; }
    for (const r of got.runs) runs.push(slimRun(r, wf));
  }
  return { capturedAt, window: { from: win.from, to: win.to }, complete: errors.length === 0, ...(errors.length ? { errors } : {}), runs: selectWindowRuns(runs, win) };
}

/** Keep an earlier complete capture over a new incomplete one (a re-run without a token must not erase it). */
function mergePipelineRuns(prev, next) {
  if (prev && prev.complete && !(next && next.complete)) return prev;
  return next;
}

/** The record's runs for the replay, or null when it has none or an incomplete capture. */
function recordedRuns(rec) {
  const p = rec && rec.pipelineRuns;
  return p && p.complete && Array.isArray(p.runs) ? p.runs : null;
}

/**
 * Stamp perReview[].scoredAt from the review files and fileState.files[].inCoreAtEnd from core reviews.json rows
 * of the show ({outletId|outlet, criticName}). Mutates rec; returns counts. A review matches a file by outlet id and
 * folded critic, or by outlet id alone when the outlet has exactly one file. Without fileState, nothing is stamped.
 */
function stampReviewTimes(rec, coreRows, normOutlet) {
  const files = (rec.fileState && rec.fileState.files) || [];
  const key = (oid, critic) => `${oid}|${foldKey(critic)}`;
  const core = new Set();
  const coreByOutlet = new Map();
  for (const r of coreRows || []) {
    const oid = r.outletId || normOutlet(r.outlet);
    if (!oid) continue;
    core.add(key(oid, r.criticName)); coreByOutlet.set(oid, (coreByOutlet.get(oid) || 0) + 1);
  }
  const filesPerOutlet = new Map();
  for (const f of files) if (f && f.outletId) filesPerOutlet.set(f.outletId, (filesPerOutlet.get(f.outletId) || 0) + 1);
  let inCore = 0;
  if (coreRows) {
    for (const f of files) {
      if (!f || !f.outletId) continue;
      // A critic name can differ between the file and reviews.json (initials, a co-byline): one file and one core row
      // for the outlet are the same review.
      const oneToOne = filesPerOutlet.get(f.outletId) === 1 && coreByOutlet.get(f.outletId) === 1;
      f.inCoreAtEnd = core.has(key(f.outletId, f.critic)) || ((!f.critic || oneToOne) && coreByOutlet.has(f.outletId));
      if (f.inCoreAtEnd) inCore++;
    }
  }
  const byKey = new Map();
  const byOutlet = new Map();
  for (const f of files) {
    if (!f || !f.outletId || !f.scoredAt) continue;
    byKey.set(key(f.outletId, f.critic), f);
    if (!byOutlet.has(f.outletId)) byOutlet.set(f.outletId, []);
    byOutlet.get(f.outletId).push(f);
  }
  let scored = 0;
  for (const p of rec.perReview || []) {
    const oid = normOutlet(p.outlet);
    const one = byOutlet.get(oid);
    const f = byKey.get(key(oid, p.critic)) || (one && one.length === 1 ? one[0] : null);
    if (f) { p.scoredAt = f.scoredAt; scored++; } else delete p.scoredAt;
  }
  return { scored, reviews: (rec.perReview || []).length, inCore, files: files.length, coreKnown: !!coreRows };
}

/**
 * The files as the replay feeds them to the watchdog: scoredAt from the file, else from the matching perReview row.
 * Records captured before the review files carried scoredAt have neither, and every pending review reads "score".
 */
function replayFiles(rec, normOutlet) {
  const byKey = new Map();
  for (const p of rec.perReview || []) if (p.scoredAt) byKey.set(`${normOutlet(p.outlet)}|${foldKey(p.critic)}`, p.scoredAt);
  return ((rec.fileState && rec.fileState.files) || []).map((f) => ({ ...f, scoredAt: f.scoredAt || byKey.get(`${f.outletId}|${foldKey(f.critic)}`) || null }));
}

/**
 * Core reviews.json rows as they stood at nowMs, modelled: a scored file that was in core at the end (or, with no
 * end stamp, that went live) entered core when the first successful rebuild-fast run that started after it was scored
 * finished, and no later than when it went live. A file never in core at the end never enters (it was dropped).
 * `liveMsOf(file)` = when the file's review went live, or NaN.
 */
function coreRowsAt(files, runs, nowMs, liveMsOf) {
  const rebuilds = (runs || []).filter((r) => r.workflow === 'rebuild-fast.yml' && r.conclusion === 'success')
    .map((r) => ({ start: toMs(r.startedAt), end: toMs(r.updatedAt) })).filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end));
  const out = [];
  for (const f of files || []) {
    if (!f || !f.outletId) continue;
    const scoredMs = toMs(f.scoredAt);
    const liveMs = liveMsOf(f);
    const endsInCore = f.inCoreAtEnd === true || (f.inCoreAtEnd == null && Number.isFinite(liveMs));
    if (!Number.isFinite(scoredMs) || !endsInCore) continue;
    const rb = rebuilds.filter((r) => r.start > scoredMs).sort((a, b) => a.end - b.end)[0];
    const inMs = Math.min(rb ? rb.end : Infinity, Number.isFinite(liveMs) ? liveMs : Infinity);
    if (inMs <= nowMs) out.push({ outletId: f.outletId, criticName: f.critic || null });
  }
  return out;
}

module.exports = {
  WATCHED_WORKFLOWS, runsWindow, slimRun, selectWindowRuns, pipelineRunsFrom, mergePipelineRuns, recordedRuns,
  stampReviewTimes, replayFiles, coreRowsAt,
};
