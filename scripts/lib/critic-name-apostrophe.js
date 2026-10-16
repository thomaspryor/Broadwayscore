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
