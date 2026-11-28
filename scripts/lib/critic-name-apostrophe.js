'use strict';
/**
 * critic-name-apostrophe.js (BRO-5444): a criticName cut at an apostrophe or a
 * surname particle. "Holly O'" and "Holly O" are what a byline pattern like
 * [A-Za-z]+ leaves of "Holly O'Mahony"; "Ian Mc" of "Ian McKellen".
 */

function isCutAtApostrophe(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n) return false;
  if (/['’]$/.test(n)) return true;
  // A multi-word name ending in a bare O / D / L / Mc particle (never a whole
  // English surname on its own).
  return /\s(?:O|D|L|Mc)$/.test(n);
}

module.exports = { isCutAtApostrophe };

// BRO-5420: a criticName that is not a person's name at all: OCR residue from
// Theatre Record scans (":3!-:eridan t1!~rle,,'", "AleksSierz ^ . •'"), a one-
// letter fragment, or an all-caps run of 4+ letters glued to other text.
// Letters (any script), spaces and . ' ’ - only; "Unknown" and real names pass.
function isGarbageCriticName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n) return false;
  if (n.replace(/[^\p{L}]/gu, '').length < 2) return true;
  if (/[^\p{L}\s.'’-]/u.test(n)) return true;
  if (/\p{Ll}\p{Lu}{2,}|\p{Lu}{4,}\p{Ll}/u.test(n)) return true;
  return false;
}

module.exports.isGarbageCriticName = isGarbageCriticName;
