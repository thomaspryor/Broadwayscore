/**
 * Report-only consistency checks on commercial.json (BRO-4985).
 *
 * - closedStillTbd: a show closed long enough ago that its designation should
 *   be settled, still TBD. The stale-closure classifier settles researched
 *   ones; the rest need deep research (22 such shows on 2026-10-10).
 * - recoupedModelDisagreements: the reported recouped flag and the model's
 *   call disagree. The reported flag stays authoritative; the row is for a
 *   person to look at. When the model gives a [low, mid, high] recoupment
 *   range, only a range wholly on the other side of 100% counts: gutenberg
 *   (trade-reported recoupment, range 67.7-129.4) and frozen-2018 (not
 *   recouped, 67.9-168.3) are consistent with what was reported (BRO-4995).
 * - recoupedDateNoteConflicts: notes name a recoupment month that differs
 *   from recoupedDate (BRO-5073: six notes "Dec 2021", field 2022-12). The
 *   timing backtest reads the field, so a stale note hides a real dispute.
 *
 * Pure: no I/O.
 */

const DAY_MS = 86_400_000;

function indexShows(showsList) {
  const byKey = new Map();
  for (const s of showsList || []) {
    if (!s) continue;
    if (s.id) byKey.set(s.id, s);
    if (s.slug && !byKey.has(s.slug)) byKey.set(s.slug, s);
  }
  return byKey;
}

/**
 * @param {object} records - commercial.json `shows` map (slug -> record)
 * @param {object[]} showsList - shows.json `shows` array
 * @returns {Array<{slug, closingDate, daysClosed}>}
 */
function closedStillTbd(records, showsList, { now = Date.now(), minDays = 60 } = {}) {
  const byKey = indexShows(showsList);
  const out = [];
  for (const [slug, r] of Object.entries(records || {})) {
    if (!r || r.designation !== 'TBD') continue;
    const show = byKey.get(r.showId) || byKey.get(slug);
    if (!show || show.status !== 'closed' || !show.closingDate) continue;
    const daysClosed = Math.floor((now - Date.parse(show.closingDate)) / DAY_MS);
    if (daysClosed > minDays) out.push({ slug, closingDate: show.closingDate, daysClosed });
  }
  return out.sort((a, b) => b.daysClosed - a.daysClosed);
}

/** Records whose recouped flag disagrees with the model's modelRecouped. */
function recoupedModelDisagreements(records) {
  const out = [];
  for (const [slug, r] of Object.entries(records || {})) {
    if (!r || typeof r.recouped !== 'boolean' || typeof r.modelRecouped !== 'boolean') continue;
    const range = r.modelRecoupmentPct;
    if (Array.isArray(range) && range.length === 3 && range.every(Number.isFinite)) {
      const [low, , high] = range;
      if (r.recouped ? high >= 100 : low < 100) continue;
    }
    if (r.recouped !== r.modelRecouped) {
      out.push({ slug, recouped: r.recouped, modelRecouped: r.modelRecouped, modelDataQuality: r.modelDataQuality || null });
    }
  }
  return out;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_WORD = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// Past-tense recoup word, then up to 60 chars (no sentence break; "$1.5M" decimals allowed), then
// "Month [day,] year", "Month, year" or "Month day". "(May 2023)" parentheticals are allowed.
// A date followed by "opening"/"premiere" dates the opening, not the recoupment, so it is skipped.
const NOTE_RECOUP_MONTH = new RegExp(
  '\\brecoup(?:ed|ment)\\b(?:[^.;]|\\.(?=\\d)){0,60}?\\b' + MONTH_WORD + '\\.?,?\\s+' +
  '(?:(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+((?:19|20)\\d\\d))?|((?:19|20)\\d\\d))\\b(?!\\s+(?:opening|premiere|debut|first preview))',
  'gi');

/** Records whose notes date the recoupment to a different month than recoupedDate. */
function recoupedDateNoteConflicts(records) {
  const out = [];
  for (const [slug, r] of Object.entries(records || {})) {
    if (!r || typeof r.recoupedDate !== 'string' || typeof r.notes !== 'string') continue;
    const [year, month] = r.recoupedDate.split('-').map(Number);
    const hits = [...r.notes.matchAll(NOTE_RECOUP_MONTH)]
      .map((m) => ({ year: m[3] || m[4] ? Number(m[3] || m[4]) : null, month: MONTHS[m[1].slice(0, 3).toLowerCase()], text: m[0] }));
    // "Dec 28" with no year can only be checked on the month.
    const agrees = (h) => (h.year === null || h.year === year) && (!month || h.month === month);
    if (!hits.length || hits.some(agrees)) continue;
    out.push({ slug, recoupedDate: r.recoupedDate, note: hits.map((h) => h.text).join(' | ') });
  }
  return out;
}

module.exports = { closedStillTbd, recoupedModelDisagreements, recoupedDateNoteConflicts };
