'use strict';
// BRO-6773: pure logic for the monthly Profitability Scorecard email.
// Preview-only: nothing here sends or creates a broadcast (CLAUDE.md §17).

const { isLossDesignation, isRecoupedDesignation } = require('../lib/commercial-designations');
const isFinalDesignation = (d) => isLossDesignation(d) || isRecoupedDesignation(d);

// A firstAdded day with more than this many entries is a bulk backfill, not news.
const BULK_DAY_THRESHOLD = 8;
const ESTIMATE_MOVE_MIN_PTS = 15;
const MAX_ITEMS = 5;
const SITE = 'https://broadwayscorecard.com';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fmtDay(d) {
  const [y, m, day] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

// Window for the issue: the calendar month before `today` (NY date string), or [since, today].
function resolveWindow({ today, month, since }) {
  const t = new Date(`${today}T12:00:00Z`);
  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`bad --since: ${since}`);
    return { start: since, end: today, label: `since ${fmtDay(since)}`, monthKey: today.slice(0, 7), catchup: true };
  }
  let y; let m;
  if (month) {
    const mm = /^(\d{4})-(\d{2})$/.exec(month);
    if (!mm) throw new Error(`bad --month: ${month}`);
    y = Number(mm[1]); m = Number(mm[2]);
  } else {
    y = t.getUTCFullYear(); m = t.getUTCMonth(); // 0-based current month == 1-based previous month
    if (m === 0) { y -= 1; m = 12; }
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}`, label: MONTHS[m - 1], monthKey: `${y}-${pad(m)}`, catchup: false };
}

function usd(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

const monthBefore = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

// Recoupment is news when its month sits inside the window, or (monthly issues only)
// is the month before and we learned it inside the window (ingest lag). Catch-up windows
// get no grace, so a backfilled older recoupment cannot ride in on a long --since.
function isRecoupmentNews(e, w) {
  if (!e || !e.recouped || !/^\d{4}-\d{2}$/.test(e.recoupedDate || '')) return false;
  const d = e.recoupedDate;
  if (d >= w.start.slice(0, 7) && d <= w.end.slice(0, 7)) return !e.firstAdded || (String(e.firstAdded).slice(0, 10) >= w.start && String(e.firstAdded).slice(0, 10) <= w.end);
  const fa = e.firstAdded ? String(e.firstAdded).slice(0, 10) : null;
  return !w.catchup && !!fa && fa >= w.start && fa <= w.end && d === monthBefore(w.start.slice(0, 7));
}

const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_RE = new RegExp(`\\b${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b|\\b(\\d{1,2}) ${MONTH_RE} (\\d{4})\\b|\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`, 'gi');
const realDate = (y, mo, d) => { const t = new Date(Date.UTC(+y, +mo - 1, +d)); return t.getUTCFullYear() === +y && t.getUTCMonth() === +mo - 1 && t.getUTCDate() === +d; };
// Publication date of the source a capitalization figure came from, as YYYY-MM-DD, or null.
// Citations name the primary source first ("NYT (Jun 8, 2026) ...; THR (Aug 11, 2026) repeated it"),
// so the FIRST full date wins: later corroborating mentions must not make an old figure look new.
// Dates after `notAfter` (e.g. an opening date the article mentions) are skipped.
function capitalizationPublishedDate(src, notAfter) {
  if (!src) return null;
  for (const m of String(src).matchAll(DATE_RE)) {
    const [y, mo, d] = m[1] ? [m[3], MONTH_NUM[m[1].slice(0, 3).toLowerCase()], m[2]]
      : m[4] ? [m[6], MONTH_NUM[m[5].slice(0, 3).toLowerCase()], m[4]] : [m[7], m[8], m[9]];
    if (!realDate(y, mo, d)) continue;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!notAfter || iso <= notAfter) return iso;
  }
  return null;
}

// Last N days before the window: an article from then that we only ingested inside the window
// (monthly issues only) still counts, so ingest lag cannot drop a figure from every issue.
const CAP_GRACE_DAYS = 7;
const daysBefore = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

function bulkDays(commercial) {
  const counts = {};
  for (const e of Object.values(commercial)) {
    if (e && e.firstAdded) { const d = String(e.firstAdded).slice(0, 10); counts[d] = (counts[d] || 0) + 1; }
  }
  return new Set(Object.keys(counts).filter((d) => counts[d] > BULK_DAY_THRESHOLD));
}

const midOf = (r) => (Array.isArray(r) && r.length >= 2 ? (r.length === 3 ? r[1] : (r[0] + r[1]) / 2) : null);

function snapshotOf(commercial) {
  const out = {};
  for (const [slug, e] of Object.entries(commercial)) {
    if (!e) continue;
    out[slug] = { pct: midOf(e.modelRecoupmentPct), cap: Number.isFinite(e.capitalization) ? e.capitalization : null, designation: e.designation || null };
  }
  return out;
}

function buildIssue({ commercial, shows, snapshot, window: w }) {
  const bySlug = new Map(shows.filter((s) => s.market === 'broadway').map((s) => [s.slug, s]));
  const bulk = bulkDays(commercial);
  const link = (slug) => `${SITE}/show/${slug}`;

  const recoupments = [];
  const closings = [];
  const capitalization = [];
  const undatedCapitalization = [];
  for (const [slug, e] of Object.entries(commercial)) {
    const show = bySlug.get(slug);
    if (!e || !show) continue;
    if (isRecoupmentNews(e, w) && !bulk.has(String(e.firstAdded || '').slice(0, 10))) {
      recoupments.push({ slug, title: show.title, date: e.recoupedDate, designation: e.designation, url: link(slug) });
    }
    if (show.status === 'closed' && show.closingDate >= w.start && show.closingDate <= w.end && isFinalDesignation(e.designation) && !e.nonprofitOrg) {
      closings.push({ slug, title: show.title, closed: show.closingDate, designation: e.designation, capitalization: e.modelCapitalizationEstimate ? null : (e.capitalization || null), url: link(slug) });
    }
    // BRO-6871: a capitalization figure is news only when its source was published inside the
    // window (Oct 2026 issue listed an Aug article and a Jan 2025 SEC filing as "new" because we
    // happened to add them in October). No parseable date = not provably new = skipped.
    const pub = capitalizationPublishedDate(e.capitalizationSource, w.end);
    const fa = e.firstAdded ? String(e.firstAdded).slice(0, 10) : null;
    const lateIngest = !w.catchup && !!pub && !!fa && pub < w.start && pub >= daysBefore(w.start, CAP_GRACE_DAYS) && fa >= w.start && fa <= w.end;
    const publishedInWindow = !!pub && ((pub >= w.start && pub <= w.end) || lateIngest);
    const prev = snapshot && snapshot[slug];
    const alreadyHad = !!prev && prev.cap != null; // on the scorecard at the last issue: not new, whatever the citation says
    const current = show.status !== 'closed' || (show.closingDate >= w.start && show.closingDate <= w.end); // an old closed show added late is backfill, not news
    if (publishedInWindow && !alreadyHad && current && Number.isFinite(e.capitalization) && e.capitalizationSource && !/^no verified/i.test(e.capitalizationSource) && !e.modelCapitalizationEstimate && !e.nonprofitOrg) {
      capitalization.push({ slug, title: show.title, capitalization: e.capitalization, source: e.capitalizationSource, url: link(slug) });
    } else if (!pub && current && fa && fa >= w.start && fa <= w.end && Number.isFinite(e.capitalization) && e.capitalizationSource && !/^no verified/i.test(e.capitalizationSource) && !e.modelCapitalizationEstimate) {
      undatedCapitalization.push(slug); // added this window but citation has no date: cannot prove it is new
    }
  }
  const moves = [];
  if (snapshot) {
    for (const [slug, e] of Object.entries(commercial)) {
      const show = bySlug.get(slug); const prev = snapshot[slug];
      if (!e || !show || !prev || show.status !== 'open' || e.recouped) continue;
      const now = midOf(e.modelRecoupmentPct);
      if (now == null || prev.pct == null) continue;
      const delta = Math.round(now - prev.pct);
      if (Math.abs(delta) >= ESTIMATE_MOVE_MIN_PTS) moves.push({ slug, title: show.title, from: Math.round(prev.pct), to: Math.round(now), delta, url: link(slug) });
    }
    moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }
  recoupments.sort((a, b) => a.title.localeCompare(b.title));
  closings.sort((a, b) => a.closed.localeCompare(b.closed));
  capitalization.sort((a, b) => b.capitalization - a.capitalization);

  // Headline stat: how closed Broadway shows with a final label ended up.
  let rec = 0; let loss = 0;
  for (const [slug, e] of Object.entries(commercial)) {
    const show = bySlug.get(slug);
    if (!e || !show || show.status !== 'closed' || e.nonprofitOrg || show.type === 'tour') continue;
    if (isRecoupedDesignation(e.designation)) rec++; else if (isLossDesignation(e.designation)) loss++;
  }
  const stat = rec + loss >= 20 ? { recouped: rec, total: rec + loss, pct: Math.round((100 * rec) / (rec + loss)) } : null;

  const totals = { recoupments: recoupments.length, closings: closings.length, moves: moves.length, capitalization: capitalization.length };
  const sections = {
    recoupments: recoupments.slice(0, MAX_ITEMS),
    closings: closings.slice(0, MAX_ITEMS),
    moves: moves.slice(0, MAX_ITEMS),
    capitalization: capitalization.slice(0, MAX_ITEMS),
  };
  const newsCount = Object.values(totals).reduce((n, a) => n + a, 0);
  return { window: w, sections, totals, stat, newsCount, quiet: newsCount === 0, hasBaseline: !!snapshot, undatedCapitalization };
}

function buildSubject(issue) {
  const m = issue.window.catchup ? issue.window.label.replace('since ', 'Since ') : issue.window.label;
  const { recoupments, closings } = issue.sections;
  const nRec = issue.totals.recoupments; const nClose = issue.totals.closings;
  if (issue.quiet) return `Money Scorecard, ${m}: a quiet month, nothing new to report`;
  const bits = [];
  if (nRec) bits.push(nRec === 1 ? `${recoupments[0].title} recouped` : `${nRec} recoupments`);
  if (nClose) bits.push(nClose === 1 ? `${closings[0].title} closed as a ${closings[0].designation}` : `${nClose} closings with final labels`);
  if (!bits.length) bits.push('new money data');
  return `Money Scorecard, ${m}: ${bits.join(' and ')}`;
}

module.exports = { capitalizationPublishedDate, resolveWindow, isRecoupmentNews, bulkDays, snapshotOf, buildIssue, buildSubject, usd, fmtDay, midOf, BULK_DAY_THRESHOLD, isFinalDesignation };
