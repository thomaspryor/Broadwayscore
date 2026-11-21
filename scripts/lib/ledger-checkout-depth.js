'use strict';
// BRO-2388 (same class as task #466): a job that ends with the
// commit-scraper-spend-ledger composite (push-with-retry.sh) on a depth-1
// actions/checkout can hit "fetch could not restore ancestry to the shallow
// checkout's original boundary" when the job outlives the repo's ~150
// commits/hour churn. Pure analyzer + fixer, shared by the test and codemod.

const LEDGER_ACTION = 'commit-scraper-spend-ledger';
const EXEMPT_RE = /#\s*shallow-ledger-ok:\s*\S/;
const SHORT_JOB_MIN = 20; // jobs this short finish well inside the churn window

function requiredDepth(timeoutMin) {
  if (timeoutMin <= SHORT_JOB_MIN) return 0; // exempt
  return timeoutMin <= 120 ? 300 : 1000;
}

function indentOf(l) { return l.match(/^ */)[0].length; }

function splitJobs(lines) {
  const jobs = [];
  let inJobs = false, cur = null;
  lines.forEach((l, i) => {
    if (/^jobs:\s*$/.test(l)) { inJobs = true; return; }
    if (!inJobs) return;
    if (/^\S/.test(l) && !/^#/.test(l)) { inJobs = false; return; }
    const m = l.match(/^  ([\w-]+):\s*$/);
    if (m) { cur = { name: m[1], start: i, end: lines.length }; jobs.push(cur); }
    else if (cur) cur.end = i + 1;
  });
  return jobs;
}

// Returns [{job, line, timeout, need, hasWith, withEnd, withIndent}] for every
// same-repo checkout in a ledger-committing job whose fetch-depth is too small.
function findShallowLedgerCheckouts(text) {
  const lines = text.split('\n');
  const out = [];
  for (const job of splitJobs(lines)) {
    const body = lines.slice(job.start, job.end);
    if (!body.some((l) => l.includes(LEDGER_ACTION) && !/^\s*#/.test(l))) continue;
    const tm = body.map((l) => l.match(/^    timeout-minutes:\s*(\d+)/)).find(Boolean);
    const timeout = tm ? Number(tm[1]) : 360;
    const need = requiredDepth(timeout);
    if (!need) continue;
    for (let i = job.start; i < job.end; i++) {
      if (!/uses:\s*actions\/checkout@/.test(lines[i]) || /^\s*#/.test(lines[i])) continue;
      const isDash = /^\s*-\s+uses:/.test(lines[i]);
      const keyIndent = isDash ? indentOf(lines[i]) + 2 : indentOf(lines[i]);
      let j = i + 1, hasWith = false, withEnd = i, depth = null, depthLine = -1, repo = false, exempt = EXEMPT_RE.test(lines[i]);
      for (; j < job.end; j++) {
        const l = lines[j];
        if (l.trim() === '') continue;
        if (indentOf(l) < keyIndent || (indentOf(l) === keyIndent && /^\s*-\s/.test(l)) ) break;
        if (indentOf(l) <= keyIndent && !/^\s*#/.test(l) && !/^\s*with:/.test(l)) { if (!/^\s*(name|if|id|env|continue-on-error):/.test(l)) break; }
        if (/^\s*with:\s*$/.test(l)) hasWith = true;
        if (/^\s*fetch-depth:/.test(l)) { depthLine = j; const m = l.match(/fetch-depth:\s*(\d+)\s*(#.*)?$/); depth = m ? Number(m[1]) : Infinity; }
        if (/^\s*repository:/.test(l)) repo = true;
        if (EXEMPT_RE.test(l)) exempt = true;
        withEnd = j;
      }
      if (repo || exempt) continue;
      if (depth === 0 || (depth !== null && depth >= need)) continue;
      out.push({ job: job.name, line: i + 1, timeout, need, hasWith, withEnd, keyIndent, depthLine });
    }
  }
  return out;
}

function fixShallowLedgerCheckouts(text) {
  const lines = text.split('\n');
  const found = findShallowLedgerCheckouts(text).sort((a, b) => b.line - a.line);
  for (const f of found) {
    const ind = ' '.repeat(f.keyIndent + 2);
    const ins = [
      `${ind}# BRO-2388 (task #466 class): depth ${f.need} keeps push-with-retry.sh's shallow boundary an ancestor`,
      `${ind}# of main for this ${f.timeout}-min job's final ledger commit; depth-1 aborted when churn outran it.`,
      `${ind}fetch-depth: ${f.need}`,
    ];
    if (f.depthLine >= 0) { lines[f.depthLine] = lines[f.depthLine].replace(/fetch-depth:\s*\d+/, `fetch-depth: ${f.need}`); continue; }
    if (f.hasWith) lines.splice(f.withEnd + 1, 0, ...ins);
    else lines.splice(f.withEnd + 1, 0, `${' '.repeat(f.keyIndent)}with:`, ...ins);
  }
  return lines.join('\n');
}

module.exports = { findShallowLedgerCheckouts, fixShallowLedgerCheckouts, requiredDepth };
