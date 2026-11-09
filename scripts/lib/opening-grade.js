'use strict';

const path = require('path');

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
// review-guards pulls scraper/axios/playwright in transitively. The morning digest
// requires this module for its render helpers only and runs without npm ci
// (tests/unit/morning-digest-action.test.mjs walks literal require()s), so the
// rule loads at first grade, which only grade-openings.js does.
const INCLUSION_RULE_MODULE = './review-guards';
let _includable = null;
function isIncludableForRebuild(f, show, filePath) {
  if (!_includable) _includable = require(INCLUSION_RULE_MODULE).isIncludableForRebuild;
  return _includable(f, show, filePath);
}

const HOUR = 3600000;
const MARKETS = ['broadway', 'off-broadway', 'west-end', 'off-west-end'];
const MARKET_LABEL = { broadway: 'Broadway', 'off-broadway': 'Off-Broadway', 'west-end': 'West End', 'off-west-end': 'Off-West End' };
const MARKET_TZ = { broadway: 'America/New_York', 'off-broadway': 'America/New_York', 'west-end': 'Europe/London', 'off-west-end': 'Europe/London' };
const BEFORE_H = 72; // previews and early embargo lifts
const AFTER_H = 7 * 24; // opening week
const SWEEP_SHOWS = 3;
// BRO-7161 F19: breadth alone is not proof of maintenance (a person fixing four
// shows in one commit is hand work). A commit touching more than SWEEP_SHOWS
// shows is ignored only when its subject names a maintenance operation, or it
// touches more than SWEEP_CEILING shows (no human fixes that many at once).
const SWEEP_CEILING = 12;
// Anchored to the start of the subject (after an optional BRO-N): "fix: refresh reviews for X, Y" is a person's fix, "BRO-6745 reverify" is maintenance.
const MAINTENANCE_SUBJECT = /^\s*(?:BRO-\d+[:\s-]*)?(?:chore[:(\s]|maintenance|sweep|backfill|re-?verif|re-?score|re-?build|bulk\b|checkpoint|dedup|reindex|retrofit|migrat|normali[sz]e|prune|purge|stamp\b)/i;
// BRO-7161 F18: a gap-audit row older than this no longer vouches that nothing is missing.
const STALE_AUDIT_H = 72;

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

/**
 * BRO-7161 F17: is this review file actually live on the site? Delegates to the
 * rebuild's own inclusion rule (review-guards.isIncludableForRebuild, the same
 * definition the gap audit uses for "covered"), so a stub, empty body, non-review
 * or preview placeholder never counts. A throw counts as not live (fail closed).
 * @param {object} f review file with _file = '<show>/<name>.json'
 * @param {object} show shows.json entry
 * @param {string|null} rtDir review-texts root, for guards that read sibling files
 */
function isLiveFile(f, show, rtDir = null) {
  if (!f) return false;
  try {
    const filePath = rtDir && f._file ? path.join(rtDir, f._file) : null;
    return isIncludableForRebuild(f, show, filePath) === true;
  } catch (_) {
    return false;
  }
}

/** True when a commit is corpus-wide maintenance, not a person fixing this opening (BRO-7161 F19). */
function isSweepCommit(c) {
  const n = showsTouched(c).size;
  if (n <= SWEEP_SHOWS) return false;
  return n > SWEEP_CEILING || MAINTENANCE_SUBJECT.test(String(c.subject || ''));
}

/** Embargo and hand-evidence window bounds for an opening (shared with grade-openings.js). */
function openingWindow(show, pressNight) {
  const embargoMs = toMs(pressNight && pressNight.embargoAt) ?? estimateEmbargoMs(show.openingDate, show.category);
  return { embargoMs, lo: embargoMs - BEFORE_H * HOUR, hi: embargoMs + AFTER_H * HOUR };
}


// BRO-7145: every hand signal names its cause so the weekly email can say WHY an
// opening needed a person, and a repeat outlet shows up as a repeat class.
const CAUSE_LABEL = {
  'discovery-gap': 'review missed by discovery',
  'wrong-label': 'wrong-production or wrong-show flag',
  'date-guard': 'publish-date guard',
  'duplicate-identity': 'duplicate or URL identity',
  attribution: 'critic or outlet attribution',
  'scoring-by-hand': 'score set by hand',
  'content-tier': 'content tier or non-review flag',
  other: 'other fix',
};
const CAUSE_BY_FIELD = {
  wrongProduction: 'wrong-label', wrongShow: 'wrong-label', wrongProductionManualClear: 'wrong-label',
  publishDate: 'date-guard', combinedWith: 'date-guard',
  duplicateOf: 'duplicate-identity', url: 'duplicate-identity', showId: 'duplicate-identity',
  contentTier: 'content-tier', isRoundupArticle: 'content-tier',
  humanReviewScore: 'scoring-by-hand',
};
const field = (x) => String(x).replace(/^approvedFix:/, '');

/** Cause class of a set of gating fields / hand steps (first known field wins). */
function causeOfFields(fields) {
  for (const f of fields || []) { const c = CAUSE_BY_FIELD[field(f)]; if (c) return c; }
  return 'other';
}

/** Cause class of a hand commit or log line, from its subject. */
function causeOfSubject(subject) {
  const t = String(subject || '').toLowerCase();
  if (/wrongprod|wrongshow|wrong.show/.test(t)) return 'wrong-label';
  if (/ingest|missed|discovery|on-monitor|opening.night monitor|\bdirect\b|recover|full.?text|pull quote|\badd(ed)?\b.*review|\bfeat: .*review/.test(t)) return 'discovery-gap';
  if (/byline|criticname|re-credit|attribut|outletid/.test(t)) return 'attribution';
  if (/publishdate|date guard/.test(t)) return 'date-guard';
  if (/duplic|syndicat/.test(t)) return 'duplicate-identity';
  if (/wrongprod|wrongshow|wrong.show|stale|combinedwith|tour|cross-market|misfiled/.test(t)) return 'wrong-label';
  if (/override|score|rating|isnonreview|non-review|not_a_review|box-office|junk/.test(t)) return /override|score|rating/.test(t) ? 'scoring-by-hand' : 'content-tier';
  return 'other';
}

/** Outlet id of a review file: its own outletId, else the "<outlet>--<critic>.json" name. */
function outletOfFile(f) {
  if (f && typeof f.outletId === 'string' && f.outletId) return f.outletId;
  const name = String((f && f._file) || '').split('/')[1] || '';
  const o = name.split('--')[0];
  return o && !o.endsWith('.json') ? o : null;
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
 * @param {number|null} p.missingCited  aggregator-cited reviews the gap audit still
 *   has not collected (audit-show-review-gap.alertUncollected of gapResult), or null
 *   when there is no audit row
 * @param {number} p.nowMs
 */
function gradeOpening({ show, files = [], commits = [], historyFromMs = null, pressNight = null, gapResult = null, missingCited = null, rtDir = null, expectedMissing = null, nowMs = Date.now() }) {
  const { embargoMs, lo, hi } = openingWindow(show, pressNight);
  const inWin = (t) => t != null && t >= lo && t <= hi;

  const signals = [];
  const bySha = new Map((commits || []).map((c) => [String(c.sha).slice(0, 8), c]));
  const fixCommits = (commits || []).filter((c) => !isSweepCommit(c));
  const seen = new Set();
  for (const a of manualActionsFromCommits(fixCommits, { showId: show.id, embargoAt: new Date(embargoMs).toISOString(), nightStartH: BEFORE_H, endH: AFTER_H })) {
    const sha = String(a.source || '').split(' ')[0];
    if (seen.has(sha)) continue;
    seen.add(sha);
    const c = bySha.get(sha);
    const kind = c && isBotAuthor(c.author, c.email) ? 'ingest-dispatch' : 'hand-commit';
    signals.push({ kind, at: a.at, outletId: a.outletId, cause: kind === 'ingest-dispatch' ? 'discovery-gap' : causeOfSubject(a.source), source: String(a.source).slice(0, 140) });
  }
  // ingest-urls.yml's fallback commit ("data: Ingest URLs for <show>") is a
  // hand dispatch the frozen press-night rule does not recognise.
  for (const c of fixCommits) {
    const sha = String(c.sha).slice(0, 8);
    const at = toMs(c.at);
    if (seen.has(sha) || !inWin(at) || !/^data: Ingest URLs for /.test(c.subject || '')) continue;
    if (!(c.files || []).some((f) => f.startsWith(`${show.id}/`))) continue;
    seen.add(sha);
    signals.push({ kind: 'ingest-dispatch', at: new Date(at).toISOString(), outletId: null, cause: 'discovery-gap', source: `${sha} ${String(c.subject).slice(0, 120)}` });
  }
  for (const a of (pressNight && Array.isArray(pressNight.manualActions) ? pressNight.manualActions : [])) {
    const shas = String(a.source || '').match(/\b[0-9a-f]{8}\b/g) || [];
    if (shas.some((s) => seen.has(s))) continue;
    signals.push({ kind: 'press-night-log', at: a.at || null, outletId: a.outletId || null, cause: causeOfSubject(a.source), source: String(a.source || '').slice(0, 140) });
  }
  for (const f of files || []) {
    const created = toMs(f.firstSeenAt);
    if (f.ingestOrigin === 'manual' && inWin(created)) {
      signals.push({ kind: 'hand-created-file', at: f.firstSeenAt, file: f._file || null, outletId: outletOfFile(f), cause: 'discovery-gap', by: f.ingestOriginBy || null });
      continue;
    }
    const fixes = (Array.isArray(f.approvedFixes) ? f.approvedFixes : []).filter((x) => x && GATING_FIX_FIELDS.has(x.field) && inWin(toMs(x.at)));
    if (fixes.length) { signals.push({ kind: 'approved-fix', at: fixes[0].at, file: f._file || null, outletId: outletOfFile(f), cause: causeOfFields(fixes.map((x) => x.field)), fields: fixes.map((x) => x.field) }); continue; }
    if (inWin(created)) {
      const gating = handSteps({ ...f, approvedFixes: [] }).gating;
      if (gating.length) signals.push({ kind: 'hand-step', at: f.firstSeenAt, file: f._file || null, outletId: outletOfFile(f), cause: causeOfFields(gating), steps: gating });
    }
  }

  // BRO-7161 F17: live = files the rebuild would include. F20: only files first
  // seen by the end of opening week count toward the week's outcome; later
  // rescues are reported as lateLive, never folded into the week's grade. A file
  // with no firstSeenAt cannot be shown to be late, so it counts.
  const liveFiles = (files || []).filter((f) => isLiveFile(f, show, rtDir));
  const isLate = (f) => { const t = toMs(f.firstSeenAt); return t != null && t > hi; };
  const live = liveFiles.filter((f) => !isLate(f)).length;
  const lateLive = liveFiles.length - live;
  // BRO-7147: "known" was the census candidateCount, which counts every URL any
  // source ever surfaced, other productions included (King Lear OB "2 of 10":
  // all 8 extra were a DC, a Sydney, a Chicago and a Texas staging). Known is now
  // live plus the aggregator-cited reviews the gap audit still cannot collect,
  // the same count the per-show alert uses (BRO-7116). The census count stays as
  // censusCandidates for reference only.
  const cv = gapResult && gapResult.censusVerdict;
  const censusCandidates = cv && Number.isInteger(cv.candidateCount) ? cv.candidateCount : null;
  // null when no gap audit row exists for the show (unknown, not zero).
  const missing = Number.isInteger(missingCited) ? Math.max(0, missingCited) : null;
  // BRO-7161 F18: unknown coverage is not zero missing. No audit row, or a row
  // too old to vouch for today, cannot back a clean grade.
  const auditAt = toMs(gapResult && gapResult.computedAt);
  const auditStale = gapResult != null && (auditAt == null || nowMs - auditAt > STALE_AUDIT_H * HOUR);
  const coverageUnknown = missing === null || auditStale;
  const known = missing === null ? null : live + missing;
  const windowClosed = nowMs > hi;
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
  // BRO-7147: a window that closed with cited reviews still missing did not run
  // on its own, whether or not anyone touched it, and with none live at all it
  // is the worst case, so it outranks no-reviews.
  else if (windowClosed && missing > 0) verdict = 'incomplete';
  // A closed week with reviews first seen only after it ended did not run on its own (F20).
  else if (windowClosed && lateLive > 0) verdict = 'incomplete';
  // Nothing live stays visible as no-reviews even without an audit row (F18).
  else if (live === 0) verdict = 'no-reviews';
  else if (coverageUnknown) verdict = 'coverage-unknown';
  else verdict = 'on-its-own';

  return {
    showId: show.id,
    title: show.title || show.id,
    category: show.category,
    openingDate: show.openingDate,
    embargoAt: new Date(embargoMs).toISOString(),
    embargoFrom: pressNight && pressNight.embargoAt ? 'press-night record' : '22:00 local estimate',
    windowEnd: new Date(hi).toISOString(),
    windowClosed,
    live,
    lateLive,
    known,
    missing,
    censusCandidates,
    hoursToLive: round1(hoursToLive),
    verdict,
    onlyIngestDispatches: verdict === 'needed-hands' && hard.length === 0,
    signals,
    historyCovers,
    // BRO-7166: usual critics (standing set) with no review yet; never moves the verdict.
    expectedMissing: Array.isArray(expectedMissing) && expectedMissing.length ? expectedMissing : null,
  };
}

const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "review missed by discovery (thestage, guardian); publish-date guard" from a grade's signals. */
function causeSummary(signals) {
  const by = new Map();
  for (const s of signals || []) {
    if (!s.cause) continue;
    if (!by.has(s.cause)) by.set(s.cause, new Set());
    if (s.outletId) by.get(s.cause).add(s.outletId);
  }
  return [...by].map(([c, o]) => `${CAUSE_LABEL[c] || c}${o.size ? ` (${[...o].slice(0, 3).join(', ')}${o.size > 3 ? ', ...' : ''})` : ''}`).join('; ');
}

/** One plain-English line for the owner's morning email. */
function gradeLine(g) {
  const head = `${g.title} (${MARKET_LABEL[g.category] || g.category}, opened ${fmtDate(g.openingDate)})`;
  const n = `${g.live} review${g.live === 1 ? '' : 's'} live`;
  // BRO-7147: known = live + aggregator-cited reviews still missing, so it only
  // differs from live when a cited review is missing. Older snapshots carried the
  // census count here (other productions included); they age out in 14 days.
  const count = g.known != null && g.known > g.live ? `${n} of ${g.known} cited` : n;
  const sofar = g.windowClosed ? '' : ' so far';
  const late = g.lateLive > 0 ? ` (${g.lateLive} more added after opening week)` : '';
  let tail;
  if (g.verdict === 'needed-hands') {
    const n = g.signals.length;
    const why = causeSummary(g.signals);
    tail = `needed a person or a Claude session${sofar} (${n} fix${n === 1 ? '' : 'es'} by hand${why ? `: ${why}` : ''})`;
  } else if (g.verdict === 'on-its-own') tail = `ran on its own${sofar}`;
  else if (g.verdict === 'incomplete') {
    const m = g.missing || Math.max(0, (g.known || 0) - g.live) || g.lateLive || 0;
    tail = g.missing > 0 || (g.known || 0) > g.live ? `opening week ended with ${m} cited review${m === 1 ? '' : 's'} still missing`
      : `opening week ended before ${m} review${m === 1 ? ' was' : 's were'} found`;
  }
  else if (g.verdict === 'coverage-unknown') tail = 'not graded clean: the missing-review check has no fresh result for it';
  else if (g.verdict === 'no-reviews') tail = (g.known || 0) > 0 ? 'cited reviews are out but none are on the site yet' : g.windowClosed ? 'opening week ended and no reviews were found' : 'no reviews live yet';
  else tail = 'not graded (edit history missing)';
  const usual = Array.isArray(g.expectedMissing) && g.expectedMissing.length
    ? ` Usual critics with no review yet: ${g.expectedMissing.map((m) => m.name || m.outletId).join(', ')}.`
    : '';
  return `${head}: ${count}${late}, ${tail}.${usual}`;
}

/** Per-market tallies. */
function summarize(grades) {
  const out = {};
  for (const m of MARKETS) out[m] = { openings: 0, onItsOwn: 0, neededHands: 0, neededHandsIngestOnly: 0, incomplete: 0, noReviews: 0, noReviewsClosed: 0, coverageUnknown: 0, notGradable: 0 };
  for (const g of grades || []) {
    const s = out[g.category];
    if (!s) continue;
    s.openings += 1;
    if (g.verdict === 'on-its-own') s.onItsOwn += 1;
    else if (g.verdict === 'needed-hands') { s.neededHands += 1; if (g.onlyIngestDispatches) s.neededHandsIngestOnly += 1; }
    else if (g.verdict === 'incomplete') s.incomplete += 1;
    else if (g.verdict === 'no-reviews') { s.noReviews += 1; if (g.windowClosed) s.noReviewsClosed += 1; }
    else if (g.verdict === 'coverage-unknown') s.coverageUnknown += 1;
    else s.notGradable += 1;
  }
  return out;
}

/** Digest tally line, e.g. "Openings in the last 14 days that ran on their own: Broadway 2 of 3, West End 1 of 1." */
function tallyLine(summary, days) {
  // Denominator is graded openings only: a show with no reviews yet, or with
  // missing edit history, neither passed nor failed.
  // An incomplete opening is graded (it failed), so it counts in the denominator.
  const graded = (s) => s.onItsOwn + s.neededHands + (s.incomplete || 0);
  const parts = MARKETS.filter((m) => summary[m] && graded(summary[m]))
    .map((m) => `${MARKET_LABEL[m]} ${summary[m].onItsOwn} of ${graded(summary[m])}`);
  // BRO-7161 F18: openings left out of the denominator are named, never silent.
  const sum = (k) => MARKETS.reduce((n, m) => n + ((summary[m] && summary[m][k]) || 0), 0);
  const notes = [];
  if (sum('noReviewsClosed')) notes.push(`${sum('noReviewsClosed')} ended opening week with no reviews found`);
  if (sum('coverageUnknown')) notes.push(`${sum('coverageUnknown')} not graded clean (missing-review check stale or absent)`);
  const extra = notes.length ? ` Not counted: ${notes.join('; ')}.` : '';
  return (parts.length ? `Openings in the last ${days} days that ran on their own: ${parts.join(', ')}.` : `No graded openings in the last ${days} days.`) + extra;
}

const DOT = { 'coverage-unknown': '#b45309', 'on-its-own': '#15803d', 'needed-hands': '#b45309', incomplete: '#b91c1c', 'no-reviews': '#999', 'not-gradable': '#999' };
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
    // No reviews live is only news when reviews are known to exist (a miss) or
    // opening week already ended (BRO-7161 F18: a closed week with nothing found is a finding).
    && (g.verdict !== 'no-reviews' || (g.known || 0) > 0 || g.windowClosed)
    && (g.verdict !== 'coverage-unknown' || g.windowClosed));
  const rows = recent.map((g) => `<div style="margin:0 0 6px;font-size:14px;"><span style="color:${DOT[g.verdict] || '#999'};">&#9679;</span> ${esc(gradeLine(g))}</div>`).join('\n    ');
  const rawDays = Math.round((Date.parse(`${snapshot.to}T00:00:00Z`) - Date.parse(`${snapshot.from}T00:00:00Z`)) / 86400000);
  const days = Number.isFinite(rawDays) && rawDays >= 1 ? rawDays : 14;
  const tally = tallyLine(snapshot.summary || summarize(snapshot.grades), days);
  return `<div style="margin:0 0 16px;">
    <p style="font-size:14px;font-weight:700;margin:0 0 8px;">${title}</p>
    ${rows || '<div style="margin:0 0 6px;font-size:14px;">No openings with reviews in the last week.</div>'}
    <div style="margin:0 0 8px;font-size:13px;color:#555;">${esc(tally)}</div>
  </div>`;
}

module.exports = {
  MARKETS, MARKET_LABEL, BEFORE_H, AFTER_H, SWEEP_SHOWS, SWEEP_CEILING, STALE_AUDIT_H, isLiveFile, isSweepCommit, openingWindow,
  estimateEmbargoMs, selectOpenings, CAUSE_LABEL, causeOfFields, causeOfSubject, outletOfFile, causeSummary, pickPressNight, showsTouched, isExcludedFile, gradeOpening, gradeLine, summarize, tallyLine, renderOpeningGradesBlock,
};
