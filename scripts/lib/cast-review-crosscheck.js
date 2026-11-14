'use strict';
/**
 * cast-review-crosscheck — does the cast on file for a show appear in what the
 * critics actually wrote about it?
 *
 * Why (King of the Yees, Oct 2026): backfill-cast-web.js took the cast list from
 * profiletheatre.org (a different company's production of the same title) three
 * days before opening. shows.json then carried five actors who are not in the
 * Signature Theatre production, and nothing re-checked it after 13 reviews
 * arrived naming Francis Jue, Kelly Marie Tran, David Shih, Maureen Sebastian and
 * Jon Norman Schneider. The reviews are the independent evidence: with three or
 * more full reviews on file, a real cast list is named in at least one of them.
 *
 * Verdicts:
 *   contradicted  >=2 plausible names on file, >=3 full texts, ZERO names found
 *   suspect       fewer than 20% of >=6 names found (replacement casts and
 *                 long runs land here too: advisory only)
 *   ok            otherwise
 *   insufficient  not enough cast names or full-text reviews to judge
 *
 * A contradiction on an open long-running show is usually not a wrong cast
 * (BRO-5857): shows.json lists the company on stage today (enrich-cast-from-files
 * takes IBDB currentCast for open shows), while the reviews were written about
 * the opening company. explainContradiction returns 'current-cast' when the row
 * cast is the cast file's currentCast/replacements and the file's
 * openingNightCast IS named in the reviews (Operation Mincemeat 2025, Chicago
 * 1996). There is deliberately no excuse by run length alone: a long run is
 * where a same-title tour or regional cast is most likely to be scraped, and
 * West End long runs were fixed from their newest reviews instead.
 *
 * crossCheckCast is pure (CLAUDE.md §15); loadEvidenceTexts is the one fs reader, kept
 * here so the audit and the backfill read review files the same way.
 * Tests: cast-review-crosscheck.test.mjs.
 */

const fs = require('fs');
const path = require('path');

const MIN_TEXTS = 3;
const MIN_TEXT_CHARS = 1500;
const MIN_NAMES = 2;
const SUSPECT_MIN_NAMES = 6;
const SUSPECT_FRACTION = 0.2;

function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plausible person names only: two or more tokens, no role placeholders. */
function castNames(cast) {
  const out = [];
  for (const c of cast || []) {
    const n = fold(c && c.name);
    if (n.split(' ').length >= 2 && n.length >= 7) out.push({ raw: c.name, folded: n });
  }
  return out;
}

/** True when the folded text names this person (full name, or first and last name as words). */
function textNames(foldedText, name) {
  if (foldedText.includes(name)) return true;
  const parts = name.split(' ');
  const first = parts[0];
  const last = parts[parts.length - 1];
  const word = (w) => new RegExp(`(^|[^a-z0-9'-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9'-])`).test(foldedText);
  return word(first) && word(last);
}

/**
 * @param {Array<{name:string}>} cast  shows.json cast
 * @param {string[]} texts             full review texts (already filtered to includable reviews)
 * @returns {{verdict:string, named:string[], missing:string[], fraction:number|null, texts:number, names:number}}
 */
function crossCheckCast(cast, texts) {
  const names = castNames(cast);
  const full = (texts || []).map(fold).filter((t) => t.length >= MIN_TEXT_CHARS);
  if (names.length < MIN_NAMES || full.length < MIN_TEXTS) {
    return { verdict: 'insufficient', named: [], missing: names.map((n) => n.raw), fraction: null, texts: full.length, names: names.length };
  }
  const blob = full.join(' ');
  const named = names.filter((n) => textNames(blob, n.folded)).map((n) => n.raw);
  const missing = names.filter((n) => !named.includes(n.raw)).map((n) => n.raw);
  const fraction = named.length / names.length;
  let verdict = 'ok';
  if (named.length === 0) verdict = 'contradicted';
  else if (names.length >= SUSPECT_MIN_NAMES && fraction < SUSPECT_FRACTION) verdict = 'suspect';
  return { verdict, named, missing, fraction, texts: full.length, names: names.length };
}

/**
 * Open long runs whose row lists a company newer than any review, checked by hand
 * against cast announcements (BRO-5857). The reviews' casts are older still, so
 * swapping them in would make the row more stale. Each entry expires, and drops
 * as soon as the row no longer carries `rowHas` (someone updated the cast).
 */
const HAND_CHECKED = {
  'les-miserables-west-end-2021': { rowHas: 'Harry Hepple', until: '2027-01-31', why: 'row = Feb 2026 Sondheim company; newest naming review is 2025' },
  'the-mousetrap-west-end-2021': { rowHas: 'Gay Soper', until: '2027-01-31', why: 'row = a post-2021 St Martin\'s company; reviews name the May 2021 reopening company' },
};

/**
 * Why a `contradicted` cast may still be right. Pure.
 * @param {object} show       shows.json row (cast, status, openingDate)
 * @param {object|null} castFile  data/cast/<id>.json
 * @param {string[]} texts    the same evidence texts crossCheckCast saw
 * @param {string} [today]   YYYY-MM-DD, for HAND_CHECKED expiry
 * @returns {null|'current-cast'|'hand-checked'}  null = the contradiction stands
 */
function explainContradiction(show, castFile, texts, today = new Date().toISOString().slice(0, 10)) {
  const open = show && (show.status === 'open' || show.status === 'previews');
  if (!open) return null;
  const hand = HAND_CHECKED[show.id];
  if (hand && today <= hand.until && castNames(show.cast).some((n) => n.folded === fold(hand.rowHas))) return 'hand-checked';
  const obc = (castFile && castFile.openingNightCast) || [];
  if (!obc.length) return null;
  const later = new Set([...(castFile.currentCast || []), ...(castFile.replacements || [])].map((c) => fold(c && c.name)));
  const rowIsLater = castNames(show.cast).every((n) => later.has(n.folded));
  const obcCheck = crossCheckCast(obc, texts);
  return rowIsLater && obcCheck.verdict === 'ok' ? 'current-cast' : null;
}

/** A review file counts as evidence only if it is a live, full, about-this-production text. */
function isEvidenceReview(file) {
  if (!file || typeof file.fullText !== 'string') return false;
  if (file.contentTier !== 'complete') return false;
  if (file.rejectedAt || file.wrongProduction || file.wrongShow || file.isRoundupArticle) return false;
  return true;
}

/** Full texts of the live reviews filed under data/review-texts/<showId>/. */
function loadEvidenceTexts(showDir) {
  let names;
  try { names = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const texts = [];
  for (const f of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      if (isEvidenceReview(j)) texts.push(j.fullText);
    } catch { /* unreadable file is not evidence */ }
  }
  return texts;
}

/**
 * Exit code for audit-cast-vs-reviews.js (BRO-5860, run by check-corpus-drift.js):
 * 2 = could not run (nothing checkable: missing or empty review-texts would
 * otherwise read as a clean pass), 1 = --strict and any contradicted show
 * (hand-checked rows are excused upstream, see HAND_CHECKED), 0 otherwise.
 *
 * @param {{checked: number, contradicted: number, strict?: boolean, single?: boolean}} r
 * @returns {0|1|2}
 */
function auditExitCode({ checked, contradicted, strict = false, single = false }) {
  if (!single && checked === 0) return 2;
  if (strict && contradicted > 0) return 1;
  return 0;
}

module.exports = { crossCheckCast, explainContradiction, HAND_CHECKED, isEvidenceReview, loadEvidenceTexts, castNames, fold, MIN_TEXTS, auditExitCode };
