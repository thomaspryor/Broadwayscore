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

module.exports = { crossCheckCast, isEvidenceReview, loadEvidenceTexts, castNames, fold, MIN_TEXTS };
