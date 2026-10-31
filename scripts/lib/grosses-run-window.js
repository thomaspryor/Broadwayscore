'use strict';
/**
 * Which production a weekly Broadway grosses row belongs to (BRO-5016).
 *
 * A League row is for one week ending on a Sunday. It belongs to the shows.json
 * entry whose run (first preview to closing) contains that week. Every
 * production of a title used to share one key in grosses-history.json because
 * the matcher's exact-title step never saw a revival listed under a longer
 * title ("Cabaret" vs "Cabaret at the Kit Kat Club"): 24 years of Cabaret weeks
 * sat on cabaret-2014, and the live card summed them.
 *
 * Pure: no I/O.
 */

const DAY_MS = 86400 * 1000;
/** Slack on both ends: a week ending up to 7 days before the first preview or after closing. */
const WINDOW_SLACK_DAYS = 7;
/** Previews assumed when shows.json has an opening date but no previewsStartDate. */
const PREVIEW_WEEKS_IF_UNKNOWN = 4;

function toMs(d) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(d || ''));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * [startMs, endMs] for week-ending dates that can hold this show's grosses, or
 * null when shows.json has neither a previews nor an opening date. A running
 * show (no closingDate) runs to nowMs.
 */
function runWeekWindow(show, nowMs = Date.now()) {
  if (!show) return null;
  const opening = toMs(show.openingDate);
  const start = toMs(show.previewsStartDate) ?? (opening == null ? null : opening - PREVIEW_WEEKS_IF_UNKNOWN * 7 * DAY_MS);
  if (start == null) return null;
  const end = toMs(show.closingDate) ?? nowMs;
  const slack = WINDOW_SLACK_DAYS * DAY_MS;
  return { startMs: start - slack, endMs: end + slack };
}

/** True when the week ending `week` (YYYY-MM-DD) is inside the show's run window; null when the show has no dates. */
function weekInRun(show, week, nowMs = Date.now()) {
  const w = runWeekWindow(show, nowMs);
  const t = toMs(week);
  if (!w || t == null) return null;
  return t >= w.startMs && t <= w.endMs;
}

// Not "on": "On the Town" must not reduce to "Town" and match "Our Town".
const NOISE_WORDS = new Set(['the', 'a', 'an', 'musical', 'broadway']);
const CONNECTORS = new Set(['and', 'of', 'in', 'at', 'to', 'for', 'with', 'or', 'from']);

/** Title as a word list: diacritics, punctuation, "&"/"+" folded, articles and "the musical" dropped. */
function titleWords(title) {
  return String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/\s*[&+]\s*/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w));
}

// The original production a show descends from, when shows.json says: its
// originalProductionId, or itself for a non-revival. null when unknown.
const workRoot = (s) => s.originalProductionId || (s.isRevival === false ? (s.slug || s.id) : null);

/**
 * Same work, possibly another production. Identical titles always are. For
 * differing titles shows.json's originalProductionId decides when both sides
 * have one (Cabaret 2014 and 2024 both descend from
 * cabaret-1987; SIX and Six Degrees of Separation are two originals). Otherwise
 * one title's words sit whole inside the other's ("Dancin'" in "Bob Fosse's
 * Dancin'", "Romeo and Juliet" and "Romeo + Juliet"); a one-word title only
 * as the other's first or last word. Callers still act only when exactly one
 * such production's run contains the week.
 */
function sameWork(a, b) {
  if (!a || !b) return false;
  const wa = titleWords(a.title);
  const wb = titleWords(b.title);
  if (!wa.length || !wb.length) return false;
  const [big, small] = wa.length >= wb.length ? [wa, wb] : [wb, wa];
  // Same title: same work (Waitress 2016 and its 2021 return are both listed
  // as originals). The production link only settles differing titles.
  if (small.length === big.length && small.every((w, i) => w === big[i])) return true;
  const ra = workRoot(a);
  const rb = workRoot(b);
  if (ra && rb) return ra === rb;
  if (small.length === big.length) return false;
  // A fragment is not the work: "& Juliet" is not "Romeo and Juliet".
  if (CONNECTORS.has(small[0]) || CONNECTORS.has(small[small.length - 1])) return false;
  // One word is too weak alone (Annie / Annie Get Your Gun, Once / Once Upon a
  // Mattress): only a subtitle may follow it ("Doubt: A Parable").
  // A full-name possessive credit may precede it ("Bob Fosse's Dancin'",
  // "Rodgers + Hammerstein's Cinderella"), but not a one-word or article-led
  // possessive: "The Band's Visit" is not "The Visit", "A Midsummer Night's
  // Dream" is not "Dream", "Shakespeare's Cabaret" is not "Cabaret".
  if (small.length === 1) {
    const [bigTitle, smallTitle] = wa.length >= wb.length ? [a.title, b.title] : [b.title, a.title];
    const mainTitle = String(bigTitle || '').split(/:|\s[-–—]\s/)[0].trim();
    const main = titleWords(mainTitle);
    if (main.length === 1) return main[0] === small[0];
    if (/^\s*(the|a|an)\s/i.test(String(smallTitle || ''))) return false;
    const credited = /^(?!(?:the|a|an)\s)\S+(?:\s+\S+)+['’]s\s+(\S+)$/i.exec(mainTitle);
    const last = credited ? titleWords(credited[1]) : [];
    return last.length === 1 && last[0] === small[0];
  }
  // Longer titles must open or close the other one ("Porgy and Bess").
  const n = small.length;
  return small.every((w, i) => big[i] === w) || small.every((w, i) => big[big.length - n + i] === w);
}

// Same test as alltime-attribution.js: category is the tier, market the fallback.
const isBroadway = (s) => (s.category || s.market || 'broadway') === 'broadway';

/**
 * The single Broadway production of the same work whose run contains `week`,
 * or null when none or more than one does.
 */
function productionForWeek(show, week, shows, nowMs = Date.now()) {
  if (!show) return null;
  const hits = (shows || []).filter((s) => s && isBroadway(s) && (s === show || sameWork(show, s)) && weekInRun(s, week, nowMs) === true);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The production a League row for week `week` belongs to, given the show the
 * title matcher picked: the one same-work production whose run holds the week,
 * else the picked show unless its own run rules the week out (then null, so
 * the row is reported unmatched instead of filed on the wrong run).
 */
function grossesProductionFor(show, week, shows, nowMs = Date.now()) {
  if (!show || !week) return show || null;
  const p = productionForWeek(show, week, shows, nowMs);
  if (p) return p;
  return weekInRun(show, week, nowMs) === false ? null : show;
}

/**
 * The Broadway production a word-based (medium) match may take for a League
 * row titled `title`: the one Broadway production of the matched work that ran
 * that week, and only when the row's own title names that work too. Fuzzy
 * alone filed rows on the wrong show ("Gore Vidal's The Best Man" is The Best
 * Man 2012; a title that merely shares words with a running show is not).
 * The title before a colon counts too ("Wolf Hall: Parts 1 & 2" for "Wolf
 * Hall Parts One & Two").
 */
function mediumMatchProduction(title, show, week, shows, nowMs = Date.now()) {
  const ran = week ? productionForWeek(show, week, shows, nowMs) : null;
  if (!ran || !isBroadway(ran)) return null;
  const main = String(title || '').split(':')[0];
  return sameWork({ title }, ran) || sameWork({ title: main }, ran) ? ran : null;
}

/**
 * The Broadway production a past week's League row titled `title` belongs to, given
 * matchTitleToShow's result for its title, or null to drop the row (the
 * historical backfill; the weekly scrape keeps an out-of-run pick for the
 * save-time repair instead). The matcher's window check only sees productions
 * with the exact title, so the pick is re-made by run window across the same
 * work (BRO-5016). A medium (word-based fuzzy) match goes through
 * mediumMatchProduction. The market is
 * checked on the re-pick, not the first match: "Back To The Future" first
 * matches the West End run, and every Broadway week of it was dropped.
 */
function historicalGrossesProduction(title, match, week, shows, nowMs = Date.now()) {
  if (!match || !match.show) return null;
  const picked = match.confidence === 'high'
    ? grossesProductionFor(match.show, week, shows, nowMs)
    : match.confidence === 'medium' ? mediumMatchProduction(title, match.show, week, shows, nowMs) : null;
  return picked && isBroadway(picked) ? picked : null;
}

module.exports = {
  historicalGrossesProduction,
  mediumMatchProduction,
  grossesProductionFor,
  WINDOW_SLACK_DAYS,
  PREVIEW_WEEKS_IF_UNKNOWN,
  runWeekWindow,
  weekInRun,
  titleWords,
  sameWork,
  productionForWeek,
  isBroadway,
};
