'use strict';
/**
 * Pure helpers for scripts/audit-city-hub-dual-model.js (BRO-7256): the pre-launch
 * dual-model (GPT + Gemini) audit of a city hub. No network, no file writes, so the
 * tests call the real functions.
 *
 * Design rule: the models never see our dates, critic, score or rating. They extract
 * facts from the source text blind; THIS file compares the extraction to our record.
 * That removes the known false-positive pattern of an LLM "wrong production" call
 * anchored on our own dates.
 */

const RECENT_DAYS = 365; // mirrors src/lib/city-hub.ts
const CLOSED_LIMIT = 12; // mirrors src/lib/city-hub.ts
const ESTIMATED_RUN_DAYS = 42; // mirrors src/lib/city-hub.ts

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/** JS mirror of hubPhase() in src/lib/city-hub.ts. The test pins the contract. */
function hubPhase(s, today) {
  const open = s.openingDate || '';
  const close = s.closingDate || '';
  if (s.status === 'closed') return 'closed';
  if (close && close < today) return 'closed';
  if (s.closingDateSource === 'estimated' && open && open <= today && addDays(open, ESTIMATED_RUN_DAYS) < today) return 'closed';
  if (s.status === 'previews') return 'now';
  if (open && open > today) return 'soon';
  if (s.status === 'upcoming') return 'soon';
  return 'now';
}

/** JS mirror of sectionHubShows() in src/lib/city-hub.ts (local productions only). */
function sectionHubShows(shows, metro, since, today) {
  const mine = shows.filter((s) => s.city === metro && !(since && hubPhase(s, today) === 'closed' && (s.openingDate || '') < since));
  const out = { now: [], soon: [], closedRecent: [], archive: [] };
  const cut = addDays(today, -RECENT_DAYS);
  const endOf = (s) => s.closingDate || s.openingDate || '';
  const closed = [];
  for (const s of mine) {
    const p = hubPhase(s, today);
    if (p === 'now') out.now.push(s);
    else if (p === 'soon') out.soon.push(s);
    else closed.push(s);
  }
  closed.sort((a, b) => endOf(b).localeCompare(endOf(a)) || a.id.localeCompare(b.id));
  const recent = closed.filter((s) => endOf(s) >= cut);
  out.closedRecent = recent.slice(0, CLOSED_LIMIT);
  out.archive = [...recent.slice(CLOSED_LIMIT), ...closed.filter((s) => endOf(s) < cut)];
  return out;
}

const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&amp;|&/g, ' and ').replace(/&#0?39;|&#x27;|’|‘/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- model output ----------
function parseJson(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(String(text || '')) || [null, text || ''];
  const s = m[1]; const i = s.search(/[{[]/);
  if (i < 0) return null;
  for (let e = s.length; e > i; e--) { try { return JSON.parse(s.slice(i, e)); } catch (_) { /* shrink */ } }
  return null;
}

// ---------- scores ----------
/** Star rating (0-5) from our originalRating / a rating printed in text. null when it is not a star rating. */
function starsFromRating(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  let m = /^(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (m) {
    const n = Number(m[1]); const d = Number(m[2]);
    if (d === 5) return n;
    if (d === 4) return Math.round((n / 4) * 5 * 2) / 2;
    if (d === 10) return Math.round(n / 2 * 2) / 2;
    return null;
  }
  m = /^(\d+(?:\.\d+)?)\s*stars?\b(?:\s*\(?\s*(?:of|out of)\s*(?:a possible\s*)?(\d+))?/i.exec(t);
  if (m && m[2] && Number(m[2]) !== 5) return Number(m[2]) === 4 ? Math.round((Number(m[1]) / 4) * 5 * 2) / 2 : null;
  if (m && Number(m[1]) <= 5) return Number(m[1]);
  const full = (t.match(/★/g) || []).length; const half = /½/.test(t) ? 0.5 : 0;
  if (full) return full + half;
  return null;
}

// CLAUDE.md §3: 2/5 -> 31-50, 3/5 -> 51-70, 4/5 -> 71-90, 5/5 -> 91-100 (1/5 -> 1-30)
const STAR_BAND = { 1: [1, 30], 2: [31, 50], 3: [51, 70], 4: [71, 90], 5: [91, 100] };
function bandForStars(stars) {
  if (stars == null || stars < 1 || stars > 5) return null;
  const lo = STAR_BAND[Math.floor(stars)]; const hi = STAR_BAND[Math.ceil(stars)];
  return [lo[0], hi[1]];
}
/** null = consistent or not a star rating; otherwise a short reason. */
function starBandProblem(originalRating, score) {
  const stars = starsFromRating(originalRating);
  const band = bandForStars(stars);
  if (!band || typeof score !== 'number') return null;
  return score < band[0] || score > band[1] ? `${originalRating} should score ${band[0]}-${band[1]}, scored ${score}` : null;
}

const VERDICT_RANGE = { rave: [82, 100], positive: [62, 95], mixed: [40, 78], negative: [15, 58], pan: [0, 42] };
/** null = consistent or unclear; otherwise a reason. Wide ranges: only clear contradictions flag. */
function verdictProblem(verdict, score) {
  const r = VERDICT_RANGE[String(verdict || '').toLowerCase()];
  if (!r || typeof score !== 'number') return null;
  return score < r[0] || score > r[1] ? `text reads ${verdict}, score ${score}` : null;
}

// ---------- text checks ----------
/** True when the pull quote (or its core, ignoring ellipses/brackets) appears in the article text. */
function quoteInText(quote, text) {
  const q = fold(String(quote || '').replace(/\[[^\]]*\]|\.{3}|…/g, ' '));
  const t = fold(text);
  if (!q || !t) return null;
  if (t.includes(q)) return true;
  const parts = fold(String(quote || '').replace(/\[[^\]]*\]/g, ' ').split(/\.{3}|…/).sort((a, b) => b.length - a.length)[0]);
  return parts.length >= 25 && t.includes(parts);
}

/** Last name / token overlap between our byline and the one extracted from the article. */
function bylineMatches(ours, theirs) {
  const a = fold(ours).split(' ').filter((w) => w.length > 1);
  const b = new Set(fold(theirs).split(' ').filter((w) => w.length > 1));
  if (!a.length || !b.size) return null;
  return a.some((w) => b.has(w)) ? true : false;
}

function dateDiffDays(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b || '')) return null;
  return Math.abs(daysBetween(a, b));
}

// ---------- model-vs-record comparisons ----------
/** Flags for one model's blind review extraction against our reviews.json row. */
function reviewFlags(row, ex, { opening, closing } = {}) {
  const f = [];
  if (!ex || typeof ex !== 'object') return [{ code: 'no-output', detail: 'model returned no parseable JSON' }];
  if (ex.matchesProduction === 'no') f.push({ code: 'wrong-production', detail: ex.matchQuote || ex.notes || '' });
  const kind = String(ex.isReview || '').toLowerCase();
  if (kind && kind !== 'review') f.push({ code: `non-review:${kind}`, detail: ex.notes || '' });
  if (ex.bylineInText && bylineMatches(row.criticName, ex.bylineInText) === false && !/^unknown|staff$/i.test(row.criticName || '')) {
    f.push({ code: 'byline', detail: `ours "${row.criticName}" / article "${ex.bylineInText}"` });
  }
  const dd = dateDiffDays(row.publishDate, ex.publishDateInText);
  if (dd != null && dd > 3) f.push({ code: 'publish-date', detail: `ours ${row.publishDate} / article ${ex.publishDateInText}` });
  if (ex.publishDateInText && opening && ex.publishDateInText < addDays(opening, -21)) {
    f.push({ code: 'pre-run-date', detail: `article dated ${ex.publishDateInText}, run opens ${opening}` });
  }
  if (ex.publishDateInText && closing && ex.publishDateInText > addDays(closing, 400)) {
    f.push({ code: 'long-after-run', detail: `article dated ${ex.publishDateInText}, run closed ${closing}` });
  }
  const sb = ex.ratingInText && starBandProblem(ex.ratingInText, row.assignedScore);
  if (sb) f.push({ code: 'star-band', detail: `article prints ${sb}` });
  const vp = verdictProblem(ex.verdict, row.assignedScore);
  if (vp) f.push({ code: 'score-vs-text', detail: vp });
  return f;
}

/** Flags for one model's blind show extraction (theatre page) against our shows.json row. */
function showFlags(show, ex) {
  const f = [];
  if (!ex || typeof ex !== 'object') return [{ code: 'no-output', detail: 'model returned no parseable JSON' }];
  if (ex.pageIsAboutProduction === 'no') f.push({ code: 'page-not-this-production', detail: ex.quote || '' });
  const cmp = (code, ours, theirs, tol) => {
    const d = dateDiffDays(ours, theirs);
    if (theirs && !ours) f.push({ code: `${code}-missing`, detail: `page ${theirs}, ours empty` });
    else if (d != null && d > tol) f.push({ code, detail: `ours ${ours} / page ${theirs}` });
  };
  cmp('opening-date', show.openingDate, ex.opening, 2);
  cmp('closing-date', show.closingDate, ex.closing, 2);
  cmp('preview-date', show.previewsStartDate || show.previewDate, ex.previewStart, 3);
  if (ex.venue && show.venue && fold(show.venue).split(' ').filter((w) => w.length > 3).every((w) => !fold(ex.venue).includes(w))) {
    f.push({ code: 'venue', detail: `ours "${show.venue}" / page "${ex.venue}"` });
  }
  if (ex.title && fold(ex.title) && !fold(ex.title).includes(fold(show.title)) && !fold(show.title).includes(fold(ex.title))) {
    f.push({ code: 'title', detail: `ours "${show.title}" / page "${ex.title}"` });
  }
  if (ex.productionType === 'tour' && show.category !== 'tour') f.push({ code: 'category', detail: 'page says touring production' });
  if (ex.status === 'cancelled') f.push({ code: 'cancelled', detail: ex.quote || '' });
  return f;
}

function imageFlags(show, ex) {
  const f = [];
  if (!ex || typeof ex !== 'object') return [{ code: 'no-output', detail: 'model returned no parseable JSON' }];
  if (ex.isPlaceholderOrBanner === true) f.push({ code: 'image-not-key-art', detail: ex.description || '' });
  const vt = fold(ex.visibleTitle);
  const t = fold(show.title);
  if (vt && t && !vt.includes(t) && !t.includes(vt)) {
    const words = t.split(' ').filter((w) => w.length > 3);
    if (!words.some((w) => vt.includes(w))) f.push({ code: 'image-other-title', detail: `image text "${ex.visibleTitle}" / show "${show.title}"` });
  }
  return f;
}

// ---------- live page ----------
const decode = (s) => String(s).replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');

/** Titles listed under each hub heading of the rendered /tours/<city> HTML. */
function parseLiveHub(html) {
  const body = String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const toks = body.replace(/<[^>]+>/g, '|').split('|').map((t) => decode(t).trim()).filter(Boolean);
  const heads = { 'Now playing': 'now', 'Coming soon': 'soon', 'Recently closed': 'closed' };
  const out = { now: [], soon: [], closed: [], other: [] };
  let sec = null;
  for (let i = 0; i < toks.length; i++) {
    if (heads[toks[i]]) { sec = heads[toks[i]]; continue; }
    if (/^(MUSICAL|PLAY|REVUE|COMEDY|CONCERT|SPECIAL|DANCE|OPERA)$/.test(toks[i]) && sec && i > 0) {
      const prev = toks[i - 1];
      const venue = toks.slice(Math.max(0, i - 6), i - 1).reverse().find((t) => /·|Theat|Stage|Center|Playhouse|Hall|Pantages|Ahmanson/i.test(t)) || '';
      out[sec].push({ title: prev, venue });
    }
  }
  return out;
}


const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** Run-end dates a review's own text announces ("through November 21", "extended through Sept. 27"),
 *  as ISO dates in `year`. Only dates that follow a through/thru/closes/extended cue are returned. */
function runEndsInText(text, year) {
  const out = [];
  const re = /\b(?:through|thru|closes|closing|extended(?:\s+through)?|runs\s+until|until)\s+(?:(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)[a-z]*\.?,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(20\d\d))?/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const y = m[3] ? Number(m[3]) : year;
    out.push(`${y}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`);
  }
  return out;
}
/** Latest announced run end that is more than `slackDays` after our closing date (null when none). */
function laterRunEnd(text, closing, slackDays = 3) {
  if (!closing) return null;
  const year = Number(String(closing).slice(0, 4));
  const later = runEndsInText(text, year).filter((d) => d > closing && dateDiffDays(closing, d) > slackDays && dateDiffDays(closing, d) <= 120);
  return later.length ? later.sort().pop() : null;
}

module.exports = {
  runEndsInText, laterRunEnd,
  addDays, daysBetween, hubPhase, sectionHubShows, fold, parseJson, starsFromRating, bandForStars,
  starBandProblem, verdictProblem, quoteInText, bylineMatches, dateDiffDays, reviewFlags, showFlags,
  imageFlags, parseLiveHub, RECENT_DAYS, CLOSED_LIMIT,
};
