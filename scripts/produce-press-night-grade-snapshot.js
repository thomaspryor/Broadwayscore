#!/usr/bin/env node
/**
 * produce-press-night-grade-snapshot.js (BRO-6645)
 *
 * Grades each opening night of the last 48h in one plain-English line (reviews live, email drafts ready) and
 * writes data/audit/press-night-grade-snapshot.json, which the morning digest renders as "Last night's
 * openings". With --file, every miss also files one fix card per show-night (P1 when a review missed, P2 when
 * only email drafts did); data/audit/press-night-grade-filed.json is the ledger that keeps it to one card, and
 * a later miss on the same night is a comment on that card. Logic: scripts/lib/press-night-digest-line.js.
 *
 * Needs the private core data (shows.json, opening-night-sent.json). Runs after the press-night probe's record
 * job (press-night-probe.yml) and in daily-digest.yml, which grades the emails the morning after.
 *
 *   node scripts/produce-press-night-grade-snapshot.js                    write the snapshot
 *   node scripts/produce-press-night-grade-snapshot.js --file             also file and comment fix cards
 *   node scripts/produce-press-night-grade-snapshot.js --dry-run [--now=ISO]  print lines and planned cards, write nothing
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('./lib/cli-help').exitOnHelp(module);
const lib = require('./lib/press-night-digest-line');
const { readShowNumbers } = require('./lib/broadcast-refresh');

const REPO = path.join(__dirname, '..');
const AUDIT_DIR = path.join(REPO, 'data', 'audit');
const RECORDS_DIR = path.join(AUDIT_DIR, 'press-night');
const SNAPSHOT_FILE = path.join(AUDIT_DIR, 'press-night-grade-snapshot.json');
const LEDGER_FILE = path.join(AUDIT_DIR, 'press-night-grade-filed.json');
const LINEAR_BRAIN = path.join(REPO, 'scripts', 'linear-brain.js');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function outletName(id) {
  try {
    const n = require('./lib/review-normalization').getOutletDisplayName(id);
    if (n && n !== id) return n;
  } catch { /* fall through */ }
  return lib.humanizeId(id);
}

function fileCard({ title, priority, notes }) {
  const out = execFileSync('node', [LINEAR_BRAIN, 'create', title, '--priority', String(priority), '--notes', notes,
    '--dedupe-opt-out', 'press-night-grade', '--dispatch'], { cwd: REPO, encoding: 'utf8', timeout: 90000 });
  const m = out.match(/"identifier":\s*"([A-Z]+-\d+)"/);
  if (!m) throw new Error(`linear-brain create printed no identifier: ${out.slice(0, 200)}`);
  return m[1];
}

function commentCard(card, text) {
  execFileSync('node', [LINEAR_BRAIN, 'update', card, '--comment', text], { cwd: REPO, encoding: 'utf8', timeout: 90000 });
}

function writeJson(file, obj) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const file = argv.includes('--file') && !dryRun;
  const nowArg = (argv.find((a) => a.startsWith('--now=')) || '').slice(6);
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`bad --now: ${nowArg}`);

  const showsJson = readJson(path.join(REPO, 'data', 'shows.json'));
  if (!showsJson) throw new Error('data/shows.json is not readable (core data missing?)');
  const shows = Array.isArray(showsJson) ? showsJson : showsJson.shows;
  const sent = readJson(path.join(REPO, 'data', 'opening-night-sent.json'));
  const reddit = readJson(path.join(AUDIT_DIR, 'reddit-post-drafts.json'));

  const entries = lib.gradeOpenings({
    shows,
    readRecord: (id, night) => readJson(path.join(RECORDS_DIR, `${id}-${night}.json`)),
    readNumbers: (id) => readShowNumbers(id),
    sentShows: sent && sent.shows ? sent.shows : null,
    redditDrafts: (reddit && reddit.drafts) || {},
    nowMs,
    outletName,
  });
  let recordFiles = [];
  try { recordFiles = fs.readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json')); } catch { /* no records yet */ }
  const board = lib.scoreboard(recordFiles.map((f) => readJson(path.join(RECORDS_DIR, f))).filter(Boolean));
  const snapshot = {
    generatedAt: new Date(nowMs).toISOString(),
    scoreboard: board,
    items: entries.map(({ showId, night, title, verdict, line, emails, quiet, misses }) => ({ showId, night, title, verdict, line, emails, quiet, missKeys: misses.map((m) => m.key) })),
  };

  const ledger = readJson(LEDGER_FILE) || lib.emptyLedger();
  const actions = lib.planFiling(entries, ledger);
  console.log(board.line);
  for (const e of entries) console.log(`${e.verdict.padEnd(7)} ${e.line}`);
  if (!entries.length) console.log('No opening nights in the last 48 hours.');
  for (const a of actions) console.log(`${dryRun || !file ? 'WOULD ' : ''}${a.type === 'create' ? `file P${a.priority} "${a.title}"` : `comment on ${a.card}`} (${a.missKeys.join(', ')})`);
  if (dryRun) return 0;

  writeJson(SNAPSHOT_FILE, snapshot);
  console.log(`Wrote ${path.relative(REPO, SNAPSHOT_FILE)} (${entries.length} night(s))`);
  if (!file || !actions.length) return 0;

  const { results } = await lib.applyFiling(actions, ledger, { fileCard, commentCard, save: (l) => writeJson(LEDGER_FILE, l) });
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`${r.type === 'create' ? 'Filed' : 'Commented on'} ${r.card} for ${r.key}`);
    else { failed++; console.error(`::warning::could not ${r.type} the fix card for ${r.key}: ${r.error}`); }
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(`produce-press-night-grade-snapshot: ${err.message}`); process.exit(1); });
}

module.exports = { main, outletName };
