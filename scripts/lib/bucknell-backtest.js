'use strict';

/**
 * bucknell-backtest.js — compare our recoupment answers with an outside answer
 * key: Gutekunst, Kopac & Detsky's classification of every commercial Broadway
 * musical that opened 2008-2017 (Significance, 2025; snapshot in
 * data/analysis/bucknell-recoupment-2008-2017.json). BRO-6143.
 *
 * Their five labels fold into a verdict plus a strength: press reports and
 * "grossed less than its capitalization" are firm; the authors' own
 * Plausible/Unlikely judgments are soft.
 */

const VERDICT = {
  'Yes - Press': { recouped: true, firm: true },
  'No - Press': { recouped: false, firm: true },
  'No - Grosses below Cap': { recouped: false, firm: true },
  Plausible: { recouped: true, firm: false },
  Unlikely: { recouped: false, firm: false },
};

function studyVerdict(classification) {
  return VERDICT[String(classification || '').trim()] || null;
}

/** Lowercase title with articles, "the musical", revival years and punctuation removed. */
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[:\-–—!?.,'’"[\]()]/g, ' ')
    .replace(/\b(the musical|a new musical|musical)\b/g, ' ')
    .replace(/^\s*(the|a|an)\s+/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dayGap(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs(ta - tb) / 86400000;
}

/**
 * The shows.json record for one study row, first rule that hits:
 *  1. same normalized title, opening within 45 days (revivals share titles,
 *     so the date decides);
 *  2. same normalized title, closing within 45 days (the study merges two
 *     holiday runs into one row dated from the first, e.g. Elf);
 *  3. opening within 3 days and one title contains the other
 *     ("Cinderella" / "Rodgers + Hammerstein's Cinderella").
 * @returns {{ show: object, rule: 'opening'|'closing'|'contained' }|null}
 */
function matchShowDetailed(row, shows) {
  const want = normalizeTitle(row.title);
  const nearest = (pick) => {
    let best = null;
    for (const s of shows) {
      const gap = pick(s);
      if (gap !== null && gap <= 45 && (!best || gap < best.gap)) best = { show: s, gap };
    }
    return best ? best.show : null;
  };
  const sameTitle = (s) => normalizeTitle(s.title) === want;
  const tag = (show, rule) => (show ? { show, rule } : null);
  return tag(nearest((s) => (sameTitle(s) ? dayGap(s.openingDate, row.opening) : null)), 'opening')
    || (row.closing ? tag(nearest((s) => (sameTitle(s) ? dayGap(s.closingDate, row.closing) : null)), 'closing') : null)
    || tag(nearest((s) => {
      const t = normalizeTitle(s.title);
      if (!want || !t || !(t.includes(want) || want.includes(t))) return null;
      const gap = dayGap(s.openingDate, row.opening);
      return gap <= 3 ? gap : null;
    }), 'contained');
}

function matchShow(row, shows) {
  return matchShowDetailed(row, shows)?.show || null;
}

/** The study keeps musicals that closed in previews or before a planned opening; its notes say so. */
function neverOpened(row) {
  return /closed before opening/i.test(String(row.notes || ''));
}

/** The commercial.json record for a show: keyed by slug, id, or a record's _resolvedId. */
function commercialFor(show, commercialShows) {
  if (!show) return null;
  for (const key of [show.slug, show.id]) {
    if (key && commercialShows[key]) return { key, rec: commercialShows[key] };
  }
  for (const [key, rec] of Object.entries(commercialShows)) {
    if (rec && (rec._resolvedId === show.id || rec._resolvedId === show.slug)) return { key, rec };
  }
  return null;
}

function emptyMatrix() {
  return { tp: 0, fp: 0, fn: 0, tn: 0, unknown: 0 };
}

function tally(matrix, ours, theirs) {
  if (ours !== true && ours !== false) matrix.unknown++;
  else if (ours && theirs) matrix.tp++;
  else if (ours && !theirs) matrix.fp++;
  else if (!ours && theirs) matrix.fn++;
  else matrix.tn++;
}

/**
 * The full comparison.
 * @param {Array<object>} studyRows bucknell snapshot `shows`
 * @param {Array<object>} shows shows.json records
 * @param {Record<string, object>} commercialShows commercial.json `shows`
 */
function runBacktest(studyRows, shows, commercialShows) {
  const rows = [];
  const reported = { firm: emptyMatrix(), soft: emptyMatrix() };
  const model = { firm: emptyMatrix(), soft: emptyMatrix(), firmUnreported: emptyMatrix(), passthrough: 0 };
  const unlabeled = [];
  for (const row of studyRows) {
    const verdict = studyVerdict(row.classification);
    if (!verdict) { unlabeled.push(row.title); continue; }
    const match = matchShowDetailed(row, shows);
    const show = match?.show || null;
    const comm = commercialFor(show, commercialShows);
    const rec = comm?.rec || null;
    const ourReported = rec ? rec.recouped ?? null : null;
    // An ai-estimated record's modelRecouped is a copy of `recouped`
    // (merge-model-recoupment.js), so it says nothing about the model.
    const passthrough = rec?.modelMethod === 'ai-estimated';
    const ourModel = rec && !passthrough ? rec.modelRecouped ?? null : null;
    const strength = verdict.firm ? 'firm' : 'soft';
    if (rec) {
      tally(reported[strength], ourReported, verdict.recouped);
      if (passthrough) model.passthrough++;
      else {
        tally(model[strength], ourModel, verdict.recouped);
        if (verdict.firm && ourReported === null) tally(model.firmUnreported, ourModel, verdict.recouped);
      }
    }
    rows.push({
      title: row.title,
      opening: row.opening,
      classification: row.classification,
      studyRecouped: verdict.recouped,
      firm: verdict.firm,
      showId: show?.id || null,
      matchRule: match?.rule || null,
      neverOpened: neverOpened(row),
      commercialKey: comm?.key || null,
      designation: rec?.designation ?? null,
      ourReported,
      ourModel,
      modelMethod: rec?.modelMethod ?? null,
      modelPct: Array.isArray(rec?.modelRecoupmentPct) ? rec.modelRecoupmentPct[1] : rec?.modelRecoupmentPct ?? null,
      reportedConflict: rec ? (ourReported === true || ourReported === false) && ourReported !== verdict.recouped : false,
      modelConflict: rec ? (ourModel === true || ourModel === false) && ourModel !== verdict.recouped : false,
    });
  }
  return { rows, reported, model, unlabeled };
}

function accuracy(m) {
  const n = m.tp + m.fp + m.fn + m.tn;
  return n ? (m.tp + m.tn) / n : null;
}

/** Agreement a constant "did not recoup" answer would get on the same rows. */
function alwaysNoBaseline(m) {
  const n = m.tp + m.fp + m.fn + m.tn;
  return n ? (m.fp + m.tn) / n : null;
}

/**
 * Split study rows that have a page but no commercial record into open work and
 * shows documented as having no readable press source (BRO-6182). staleDoc lists
 * documented ids that no longer belong (they got a record, or lost their page).
 */
function splitNoCommercial(rows, documentedShows) {
  const doc = documentedShows || {};
  const noCommAll = rows.filter((r) => r.showId && !r.commercialKey);
  return {
    documented: noCommAll.filter((r) => doc[r.showId]),
    openRows: noCommAll.filter((r) => !doc[r.showId]),
    staleDoc: Object.keys(doc).filter((id) => !noCommAll.some((r) => r.showId === id)),
  };
}

module.exports = { splitNoCommercial, studyVerdict, normalizeTitle, matchShow, matchShowDetailed, neverOpened, commercialFor, runBacktest, accuracy, alwaysNoBaseline, VERDICT };
