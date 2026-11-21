#!/usr/bin/env node
/**
 * sweep-websearch-bylines.js — check the scored rows only the deleted LLM
 * 'web-search' step vouched for, whose stored text is summary length: does
 * the url exist and does the page name the stored critic? (BRO-5259)
 *
 * Candidate rule and verdicts: scripts/lib/byline-sweep.js. Each row goes
 * through check-byline-evidence.js checkOne (live page, then Wayback, then the
 * paid fetchPage chain with --scrape). Prints one `SWEEP {json}` line per row
 * (urls, author names and the verdict; never review text).
 *
 * Usage:
 *   node scripts/sweep-websearch-bylines.js                       # list candidates (no network)
 *   node scripts/sweep-websearch-bylines.js --check [--offset=N] [--limit=N] [--scrape] [--out=FILE]
 *   node scripts/sweep-websearch-bylines.js --report=FILE         # summarize + plan edits
 *
 * --out appends each result to FILE as JSONL and skips rows already in it, so
 * a stopped run resumes where it left off. Through cloud-run-script.js (which
 * discards written files) shard with --offset/--limit and save the SWEEP lines
 * locally; --report reads either form.
 * --show=SLUG limits to one show.
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { isSweepCandidate, criticPattern, classifyEvidence, planEdits, deadUrlPatch } = require('./lib/byline-sweep');

function argVal(argv, name) {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

function listCandidates(dir, show) {
  const { listShowDirs } = require('./lib/list-show-dirs');
  const { isReviewTextFile } = require('./lib/review-text-sidecars');
  const out = [];
  const shows = show ? [show] : listShowDirs(dir, { silent: true });
  for (const s of shows.slice().sort()) {
    let files; try { files = fs.readdirSync(path.join(dir, s)).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
    for (const f of files) {
      if (!isReviewTextFile(f)) continue;
      let row; try { row = JSON.parse(fs.readFileSync(path.join(dir, s, f), 'utf8')); } catch { continue; }
      if (isSweepCandidate(row)) out.push({ key: `${s}/${f}`, row });
    }
  }
  return out;
}

/** Results keyed by row, from a JSONL file or saved stdout with SWEEP lines. */
function readResults(file) {
  const m = new Map();
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return m; }
  for (const line of txt.split('\n')) {
    const j = line.replace(/^.*?SWEEP\s+/, '').trim();
    if (!j.startsWith('{')) continue;
    try { const r = JSON.parse(j); if (r.key) m.set(r.key, r); } catch { /* partial line */ }
  }
  return m;
}

async function check(cands, opts) {
  const { checkOne } = require('./check-byline-evidence');
  const done = opts.out ? readResults(opts.out) : new Map();
  const slice = cands.slice(opts.offset, opts.limit ? opts.offset + opts.limit : undefined);
  const tally = {};
  for (const { key, row } of slice) {
    if (done.has(key)) { tally.resumed = (tally.resumed || 0) + 1; continue; }
    const pat = criticPattern(row.criticName);
    let ev;
    try {
      ev = await checkOne(`${row.url}|${pat || ''}`, { scrape: opts.scrape, year: null });
    } catch (e) {
      ev = { url: row.url, via: 'none', statusLive: null, authors: [], matches: [], error: String(e && e.message || e).slice(0, 120) };
    }
    const v = classifyEvidence(row, ev);
    const rec = {
      key, url: row.url, critic: row.criticName, outletId: row.outletId,
      verdict: v.verdict, note: v.note, evidenceUrl: v.evidenceUrl, via: ev.via, statusLive: ev.statusLive,
      authors: (ev.authors || []).slice(0, 5), checkedAt: new Date().toISOString(),
    };
    console.log(`SWEEP ${JSON.stringify(rec)}`);
    // a thrown error or timeout is not a result: do not checkpoint it, so a resumed run retries it
    const transient = ev.error || (v.verdict === 'unread' && !ev.statusLive);
    if (opts.out && !transient) fs.appendFileSync(opts.out, `${JSON.stringify(rec)}\n`);
    tally[v.verdict] = (tally[v.verdict] || 0) + 1;
    await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  console.log(`sweep-websearch-bylines: checked ${slice.length} of ${cands.length} candidates ${JSON.stringify(tally)}`);
}

function report(cands, file) {
  const res = readResults(file);
  const byKey = new Map(cands.map((c) => [c.key, c.row]));
  const tally = {};
  const edits = [];
  const dead = [];
  let unchecked = 0;
  for (const { key } of cands) if (!res.has(key)) unchecked++;
  for (const [key, r] of res) {
    const row = byKey.get(key);
    if (!row) { tally.noLongerCandidate = (tally.noLongerCandidate || 0) + 1; continue; }
    tally[r.verdict] = (tally[r.verdict] || 0) + 1;
    edits.push(...planEdits(key, row, r));
    if (r.verdict === 'url-dead' && deadUrlPatch(row, r.statusLive)) dead.push(key);
  }
  console.log(JSON.stringify({ candidates: cands.length, checked: res.size, unchecked, verdicts: tally }, null, 1));
  console.log(`url-dead rows flag-legacy-web-search-rows.js --probe would flag: ${dead.length}`);
  for (const k of dead) console.log(`  DEAD ${k}`);
  console.log(`plan edits (${edits.length}): pass each as --review-edit='...' to new-fix-plan.js (it splits at 25)`);
  for (const e of edits) console.log(`  EDIT ${e}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
  const dir = resolveReviewTextsDir();
  const cands = listCandidates(dir, argVal(argv, 'show'));
  const reportFile = argVal(argv, 'report');
  if (reportFile) return report(cands, reportFile);
  if (argv.includes('--check')) {
    const nums = ['offset', 'limit', 'delay-ms'].filter((k) => argVal(argv, k) != null && !Number.isFinite(Number(argVal(argv, k))));
    if (nums.length) { console.error(`bad number for --${nums.join(', --')}`); process.exit(2); }
    if (argv.includes('--scrape') && !argVal(argv, 'limit')) { console.error('--scrape needs --limit (paid fetches are capped per run)'); process.exit(2); }
    return check(cands, {
      offset: Number(argVal(argv, 'offset') || 0),
      limit: Number(argVal(argv, 'limit') || 0),
      scrape: argv.includes('--scrape'),
      out: argVal(argv, 'out'),
      delayMs: Number(argVal(argv, 'delay-ms') || 1500),
    });
  }
  const by = {};
  for (const { row } of cands) by[row.outletId] = (by[row.outletId] || 0) + 1;
  console.log(JSON.stringify({ candidates: cands.length, byOutlet: by }, null, 1));
  for (const { key } of cands) console.log(`  ${key}`);
}

if (require.main === module) {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}

module.exports = { listCandidates, readResults };
