/**
 * Cross-outlet duplicate pointers (BRO-5348).
 *
 * A duplicateTextOf / duplicateOf pointer that crosses outlets is a claim that
 * this row is a copy of ANOTHER outlet's review. When the target is a misfetch
 * (the-lion-king-1997: vulture--john-simon.json held Variety's text, so the
 * real Variety row was pointed at it), the impostor stays live and the real
 * owner is hidden. detect-cross-outlet-duplicates.js used to skip every
 * pointer row, so it never compared such a pair. It now keeps them and reports
 * them for review, without auto-flagging (its tier/length pick of a primary
 * would entrench the impostor).
 *
 * Pure: the caller supplies readSibling(file) -> parsed record or null.
 */
'use strict';

const { normalizeOutlet } = require('./review-normalization');

const outletOfFile = (data, file) =>
  normalizeOutlet((data && (data.outletId || data.outlet)) || String(file || '').split('--')[0]);

/** @returns {{field: string, target: string, targetOutlet: string} | null} */
function crossOutletPointer(data, file, readSibling) {
  if (!data) return null;
  const own = outletOfFile(data, file);
  for (const field of ['duplicateTextOf', 'duplicateOf']) {
    const target = data[field];
    if (!target || typeof target !== 'string' || target === file) continue;
    const t = readSibling(target);
    if (!t) continue;
    const targetOutlet = outletOfFile(t, target);
    if (targetOutlet && own && targetOutlet !== own) return { field, target, targetOutlet };
  }
  return null;
}

/**
 * Should the cross-outlet audit skip this row as already handled?
 * Syndication flags and same-outlet (or dangling) pointers: yes.
 * A pointer to another outlet's file: no, compare it.
 */
function skipAsAlreadyFlagged(data, file, readSibling) {
  if (!data) return true;
  if (data.isSyndicatedDuplicate) return true;
  if (!data.duplicateOf && !data.duplicateTextOf) return false;
  return !crossOutletPointer(data, file, readSibling);
}

module.exports = { crossOutletPointer, skipAsAlreadyFlagged, outletOfFile };
