/**
 * Finds a counter bumped right after a safeWriteReview() whose result is
 * ignored (BRO-5995). safeWriteReview returns { wrote: false, skipped } when
 * it refuses, so `safeWriteReview(...); written++` over-reports in summaries.
 */
'use strict';

const fs = require('fs');
const path = require('path');

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

/** Scans scripts/*.js (top level) and returns every hit. CLI: `node scripts/lib/unchecked-write-counters.js` exits 1 on hits. */
function scan(dir = path.join(__dirname, '..')) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    for (const h of findUncheckedWriteCounters(fs.readFileSync(path.join(dir, name), 'utf8'))) out.push({ file: `scripts/${name}`, ...h });
  }
  return out;
}

if (require.main === module) {
  const hits = scan();
  for (const h of hits) console.log(`${h.file}:${h.line}  ${h.call}  ->  ${h.counter}`);
  console.log(`${hits.length} counter-after-unchecked-write site(s)`);
  process.exit(hits.length ? 1 : 0);
}

module.exports = { findUncheckedWriteCounters, scan };
