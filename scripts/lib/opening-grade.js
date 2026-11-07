'use strict';

/**
 * BRO-7082: grade every opening, in all four markets, on one question: did the
 * pipeline get its reviews live on its own, or did a person / Claude session
 * have to step in during opening week?
 *
 * Pure (CLAUDE.md §15). scripts/grade-openings.js gathers inputs; tests require these.
 *
 * "Needed hands" uses the SAME evidence the press-night record uses
 * (press-night-manual-actions.manualActionsFromCommits: an `ingest-urls:` dispatch,
 * or a non-bot commit touching the show's review files), widened to opening week,
 * plus the record's own manualActions and file-level hand steps (review-provenance).
 * Commits touching more than SWEEP_SHOWS shows are corpus-wide maintenance and are
 * ignored. Bot-filed Linear cards are not evidence. Without git history covering
 * the window an opening is 'not-gradable', never a pass.
 *
 * An `ingest-urls:` commit by the CI bot is a hand dispatch of ingest-urls.yml
 * EXCEPT the scheduled tic-daily ingests made before tic-daily passed a caller
 * (BRO-7082 adds `ingest-urls(<caller>):` subjects). Those are kept apart as
 * kind 'ingest-dispatch' so the baseline can show both counts honestly.
 */

const { manualActionsFromCommits, isBotAuthor } = require('./press-night-manual-actions');
const { handSteps, GATING_FIX_FIELDS } = require('./review-provenance');

const HOUR = 3600000;
const MARKETS = ['broadway', 'off-broadway', 'west-end', 'off-west-end'];
const MARKET_LABEL = { broadway: 'Broadway', 'off-broadway': 'Off-Broadway', 'west-end': 'West End', 'off-west-end': 'Off-West End' };
const MARKET_TZ = { broadway: 'America/New_York', 'off-broadway': 'America/New_York', 'west-end': 'Europe/London', 'off-west-end': 'Europe/London' };
const BEFORE_H = 72; // previews and early embargo lifts
const AFTER_H = 7 * 24; // opening week
const SWEEP_SHOWS = 3;

const toMs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

function tzOffsetMs(tz, ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

/** Approximate embargo, 22:00 local on the opening date, as UTC ms (null for a bad date). */
function estimateEmbargoMs(openingDate, category) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(openingDate || ''))) return null;
  const [y, m, d] = openingDate.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 22);
  return naive - tzOffsetMs(MARKET_TZ[category] || 'America/New_York', naive);
}

/** Shows that opened in [fromDate, toDate] (inclusive YYYY-MM-DD) in the four graded markets. */
function selectOpenings(shows, { fromDate, toDate }) {
  return (shows || []).filter((s) => s && MARKETS.includes(s.category)
    && typeof s.openingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.openingDate)
    && s.openingDate >= fromDate && s.openingDate <= toDate
    && !/^cancel/i.test(String(s.status || '')));
}

/** The press-night record for this opening: same night, else the nearest within 3 days. */
function pickPressNight(records, show) {
  const target = toMs(`${show.openingDate}T12:00:00Z`);
  let best = null;
  for (const r of records || []) {
    if (!r || r.showId !== show.id) continue;
    const gap = Math.abs(toMs(`${r.night}T12:00:00Z`) - target);
    if (!(gap <= 3 * 24 * HOUR)) continue;
    if (!best || gap < best.gap) best = { rec: r, gap };
  }
  return best ? best.rec : null;
}

/** Show directories a commit touched (first path segment). */
function showsTouched(commit) {
  return new Set((commit.files || []).map((f) => String(f).split('/')[0]).filter(Boolean));
}

function isExcludedFile(f) {
  return !!(f && (f.wrongProduction || f.wrongShow || f.isRoundupArticle || f.duplicateOf || f.contentTier === 'invalid'));
}

const median = (a) => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Grade one opening.
 * @param {object} p
 * @param {object} p.show            shows.json entry
 * @param {object[]} p.files         parsed review files for the show (each with _file = '<show>/<name>.json')
 * @param {object[]} p.commits       review-texts commits (press-night-manual-actions.parseGitLog shape)
 * @param {number|null} p.historyFromMs  earliest instant the git history covers (null = full history)
 * @param {object|null} p.pressNight press-night record or null
 * @param {object|null} p.gapResult  show-review-gap.json result for the show, or null
 * @param {number} p.nowMs
 */
function gradeOpening({ show, files = [], commits = [], historyFromMs = null, pressNight = null, gapResult = null, nowMs = Date.now() }) {
  const embargoMs = toMs(pressNight && pressNight.embargoAt) ?? estimateEmbargoMs(show.openingDate, show.category);
  const lo = embargoMs - BEFORE_H * HOUR;
  const hi = embargoMs + AFTER_H * HOUR;
  const inWin = (t) => t != null && t >= lo && t <= hi;

  const signals = [];
  const bySha = new Map((commits || []).map((c) => [String(c.sha).slice(0, 8), c]));
  const fixCommits = (commits || []).filter((c) => showsTouched(c).size <= SWEEP_SHOWS);
  const seen = new Set();
  for (const a of manualActionsFromCommits(fixCommits, { showId: show.id, embargoAt: new Date(embargoMs).toISOString(), nightStartH: BEFORE_H, endH: AFTER_H })) {
    const sha = String(a.source || '').split(' ')[0];
    if (seen.has(sha)) continue;
    seen.add(sha);
    const c = bySha.get(sha);
    const kind = c && isBotAuthor(c.author, c.email) ? 'ingest-dispatch' : 'hand-commit';
    signals.push({ kind, at: a.at, outletId: a.outletId, source: String(a.source).slice(0, 140) });
  }
  for (const a of (pressNight && Array.isArray(pressNight.manualActions) ? pressNight.manualActions : [])) {
    const shas = String(a.source || '').match(/\b[0-9a-f]{8}\b/g) || [];
    if (shas.some((s) => seen.has(s))) continue;
    signals.push({ kind: 'press-night-log', at: a.at || null, outletId: a.outletId || null, source: String(a.source || '').slice(0, 140) });
  }
  for (const f of files || []) {
    const created = toMs(f.firstSeenAt);
    if (f.ingestOrigin === 'manual' && inWin(created)) {
      signals.push({ kind: 'hand-created-file', at: f.firstSeenAt, file: f._file || null, by: f.ingestOriginBy || null });
      continue;
    }
    const fixes = (Array.isArray(f.approvedFixes) ? f.approvedFixes : []).filter((x) => x && GATING_FIX_FIELDS.has(x.field) && inWin(toMs(x.at)));
    if (fixes.length) { signals.push({ kind: 'approved-fix', at: fixes[0].at, file: f._file || null, fields: fixes.map((x) => x.field) }); continue; }
    if (inWin(created)) {
      const gating = handSteps({ ...f, approvedFixes: [] }).gating;
      if (gating.length) signals.push({ kind: 'hand-step', at: f.firstSeenAt, file: f._file || null, steps: gating });
    }
  }

  const live = (files || []).filter((f) => !isExcludedFile(f)).length;
  const cv = gapResult && gapResult.censusVerdict;
  const known = cv && Number.isInteger(cv.candidateCount) && cv.candidateCount > 0 ? cv.candidateCount : null;
  let hoursToLive = null;
  if (pressNight && toMs(pressNight.embargoAt) != null && Array.isArray(pressNight.perReview)) {
    hoursToLive = median(pressNight.perReview.filter((r) => r && !r.baseline && toMs(r.firstLiveAt) != null)
      .map((r) => (toMs(r.firstLiveAt) - toMs(pressNight.embargoAt)) / HOUR));
  }

  const historyCovers = historyFromMs == null || historyFromMs <= lo;
  const hard = signals.filter((s) => s.kind !== 'ingest-dispatch');
  let verdict;
  if (signals.length) verdict = 'needed-hands';
  else if (!historyCovers) verdict = 'not-gradable';
  else if (live === 0) verdict = 'no-reviews';
  else verdict = 'on-its-own';

  return {
    showId: show.id,
    title: show.title || show.id,
    category: show.category,
    openingDate: show.openingDate,
    embargoAt: new Date(embargoMs).toISOString(),
    embargoFrom: pressNight && pressNight.embargoAt ? 'press-night record' : '22:00 local estimate',
    windowEnd: new Date(hi).toISOString(),
    windowClosed: nowMs > hi,
    live,
    known,
    hoursToLive: round1(hoursToLive),
    verdict,
    onlyIngestDispatches: verdict === 'needed-hands' && hard.length === 0,
    signals,
    historyCovers,
  };
}

const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** One plain-English line for the owner's morning email. */
function gradeLine(g) {
  const head = `${g.title} (${MARKET_LABEL[g.category] || g.category}, opened ${fmtDate(g.openingDate)})`;
  const n = `${g.live} review${g.live === 1 ? '' : 's'} live`;
  // known can trail live (the census lags new files), so only show it when reviews are still missing.
  const count = g.known != null && g.known > g.live ? `${n} of ${g.known} known` : n;
  const sofar = g.windowClosed ? '' : ' so far';
  let tail;
  if (g.verdict === 'needed-hands') {
    const n = g.signals.length;
    tail = `needed a person or a Claude session${sofar} (${n} fix${n === 1 ? '' : 'es'} by hand)`;
  } else if (g.verdict === 'on-its-own') tail = `ran on its own${sofar}`;
  else if (g.verdict === 'no-reviews') tail = (g.known || 0) > 0 ? 'reviews are out but none are on the site yet' : 'no reviews live yet';
  else tail = 'not graded (edit history missing)';
  return `${head}: ${count}, ${tail}.`;
}

/** Per-market tallies. */
function summarize(grades) {
  const out = {};
  for (const m of MARKETS) out[m] = { openings: 0, onItsOwn: 0, neededHands: 0, neededHandsIngestOnly: 0, noReviews: 0, notGradable: 0 };
  for (const g of grades || []) {
    const s = out[g.category];
    if (!s) continue;
    s.openings += 1;
    if (g.verdict === 'on-its-own') s.onItsOwn += 1;
    else if (g.verdict === 'needed-hands') { s.neededHands += 1; if (g.onlyIngestDispatches) s.neededHandsIngestOnly += 1; }
    else if (g.verdict === 'no-reviews') s.noReviews += 1;
    else s.notGradable += 1;
  }
  return out;
}

/** Digest tally line, e.g. "Openings in the last 14 days that ran on their own: Broadway 2 of 3, West End 1 of 1." */
function tallyLine(summary, days) {
  // Denominator is graded openings only: a show with no reviews yet, or with
  // missing edit history, neither passed nor failed.
  const graded = (s) => s.onItsOwn + s.neededHands;
  const parts = MARKETS.filter((m) => summary[m] && graded(summary[m]))
    .map((m) => `${MARKET_LABEL[m]} ${summary[m].onItsOwn} of ${graded(summary[m])}`);
  return parts.length ? `Openings in the last ${days} days that ran on their own: ${parts.join(', ')}.` : `No graded openings in the last ${days} days.`;
}

const DOT = { 'on-its-own': '#15803d', 'needed-hands': '#b45309', 'no-reviews': '#999', 'not-gradable': '#999' };
const defaultEsc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Morning-email block: one line per opening of the last `lineDays` days plus the
 * per-market tally over the snapshot's own range. A missing snapshot says
 * "not checked yet" (never silent); a stale one is flagged by the digest banner.
 */
function renderOpeningGradesBlock(snapshot, { esc = defaultEsc, nowMs = Date.now(), lineDays = 7 } = {}) {
  const title = 'Did each opening need a person this week?';
  if (!snapshot || !Array.isArray(snapshot.grades)) {
    return `<div style="margin:0 0 16px;font-size:14px;"><b>${title}</b> not checked yet (the daily grade has not run).</div>`;
  }
  const cutoff = new Date(nowMs - lineDays * 86400000).toISOString().slice(0, 10);
  const recent = snapshot.grades.filter((g) => g.openingDate >= cutoff
    // No reviews live is only news when reviews are known to exist (a miss).
    && (g.verdict !== 'no-reviews' || (g.known || 0) > 0));
  const rows = recent.map((g) => `<div style="margin:0 0 6px;font-size:14px;"><span style="color:${DOT[g.verdict] || '#999'};">&#9679;</span> ${esc(gradeLine(g))}</div>`).join('\n    ');
  const days = Math.max(1, Math.round((Date.parse(`${snapshot.to}T00:00:00Z`) - Date.parse(`${snapshot.from}T00:00:00Z`)) / 86400000));
  const tally = tallyLine(snapshot.summary || summarize(snapshot.grades), days);
  return `<div style="margin:0 0 16px;">
    <p style="font-size:14px;font-weight:700;margin:0 0 8px;">${title}</p>
    ${rows || '<div style="margin:0 0 6px;font-size:14px;">No openings with reviews in the last week.</div>'}
    <div style="margin:0 0 8px;font-size:13px;color:#555;">${esc(tally)}</div>
  </div>`;
}

module.exports = {
  MARKETS, MARKET_LABEL, BEFORE_H, AFTER_H, SWEEP_SHOWS,
  estimateEmbargoMs, selectOpenings, pickPressNight, showsTouched, isExcludedFile, gradeOpening, gradeLine, summarize, tallyLine, renderOpeningGradesBlock,
};
