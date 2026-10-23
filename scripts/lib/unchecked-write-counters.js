/**
 * Finds a counter bumped right after a safeWriteReview() whose result is
 * ignored (BRO-5995). safeWriteReview returns { wrote: false, skipped } when
 * it refuses, so `safeWriteReview(...); written++` over-reports in summaries.
 */
'use strict';

const BARE_CALL_RE = /^\s*safeWriteReview\(.*\);\s*(?:\/\/.*)?$/;
const COUNTER_RE = /^\s*[A-Za-z_][\w.]*\+\+;|^\s*[A-Za-z_][\w.]*\s*\+=\s*1;/;

/** @returns {{line:number,call:string,counter:string}[]} 1-based line of the unchecked call. */
function findUncheckedWriteCounters(source) {
  const lines = String(source).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!BARE_CALL_RE.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      if (!lines[j].trim()) continue;
      if (COUNTER_RE.test(lines[j])) hits.push({ line: i + 1, call: lines[i].trim(), counter: lines[j].trim() });
      break;
    }
  }
  return hits;
}

module.exports = { findUncheckedWriteCounters };
