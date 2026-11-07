#!/usr/bin/env node
'use strict';

/**
 * BRO-7082: grade every recent opening (Broadway, Off-Broadway, West End,
 * Off-West End): did the pipeline get its reviews live on its own, or did a
 * person / Claude session step in? Logic in scripts/lib/opening-grade.js.
 *
 * Reads: data/shows.json, data/review-texts/** (files + git history),
 *        data/audit/press-night/*.json, data/audit/show-review-gap.json.
 * Writes: data/audit/opening-grades.json (single writer), or --out.
 *
 *   node scripts/grade-openings.js                       # openings of the last 14 days
 *   node scripts/grade-openings.js --from=2026-09-08 --to=2026-11-05 --out=data/audit/opening-grades-baseline.json
 *   --show=<id>   grade one show (with --from/--to covering its opening)
 *   --dry-run     print, do not write
 *
 * Advisory: exits 0 on success; 1 only on unusable input (no shows.json / no review-texts git).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pm = require('./lib/press-night-manual-actions');
const og = require('./lib/opening-grade');

const ROOT = path.join(__dirname, '..');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const flag = (k) => process.argv.includes(`--${k}`);
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function git(rtDir, args) {
  return execFileSync('git', ['-C', rtDir, ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 256 * 1024 * 1024 });
}

/** Earliest instant the review-texts history covers: null for a full clone, else the newest shallow boundary's commit time. */
function historyFrom(rtDir) {
  if (git(rtDir, ['rev-parse', '--is-shallow-repository']).trim() !== 'true') return null;
  const shallowFile = path.resolve(rtDir, git(rtDir, ['rev-parse', '--git-path', 'shallow']).trim());
  const shas = fs.readFileSync(shallowFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  let latest = 0;
  for (const sha of shas) {
    const t = Date.parse(git(rtDir, ['log', '-1', '--format=%cI', sha]).trim());
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest || Date.now(); // unreadable boundary: treat as covering nothing
}

/** Commits that can be hand evidence: non-bot authors, plus every `ingest-urls:` commit. */
function loadCommits(rtDir, sinceIso, untilIso) {
  const base = ['log', 'HEAD', `--since=${sinceIso}`, `--until=${untilIso}`, `--format=${pm.LOG_FORMAT}`, '--name-only', '--no-renames'];
  const human = pm.parseGitLog(git(rtDir, [...base, '--perl-regexp', '--author=^(?!GitHub Action|github-actions)']));
  const ingest = pm.parseGitLog(git(rtDir, [...base, '--grep=^ingest-urls:']));
  const bySha = new Map();
  for (const c of [...human, ...ingest]) bySha.set(c.sha, c);
  return [...bySha.values()];
}

function loadFiles(rtDir, showId) {
  const dir = path.join(rtDir, showId);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('_')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const j = readJson(path.join(dir, n), null);
    if (j && typeof j === 'object' && !Array.isArray(j)) out.push({ ...j, _file: `${showId}/${n}` });
  }
  return out;
}

function main() {
  const nowMs = Date.now();
  const toDate = arg('to') || ymd(nowMs);
  const fromDate = arg('from') || ymd(nowMs - 14 * DAY);
  const outPath = path.resolve(ROOT, arg('out') || 'data/audit/opening-grades.json');
  const rtDir = path.resolve(ROOT, arg('review-texts') || 'data/review-texts');

  const showsDoc = readJson(path.join(ROOT, 'data/shows.json'), null);
  const shows = Array.isArray(showsDoc) ? showsDoc : showsDoc && showsDoc.shows;
  if (!Array.isArray(shows)) { console.error('grade-openings: data/shows.json unreadable'); process.exit(1); }
  let openings = og.selectOpenings(shows, { fromDate, toDate });
  if (arg('show')) openings = openings.filter((s) => s.id === arg('show'));

  let hist;
  try { hist = historyFrom(rtDir); } catch (e) { console.error(`grade-openings: ${rtDir} is not a git checkout (${e.message.split('\n')[0]})`); process.exit(1); }

  const pnDir = path.join(ROOT, 'data/audit/press-night');
  const records = (fs.existsSync(pnDir) ? fs.readdirSync(pnDir) : []).filter((n) => n.endsWith('.json'))
    .map((n) => readJson(path.join(pnDir, n), null)).filter(Boolean);
  const gap = readJson(path.join(ROOT, 'data/audit/show-review-gap.json'), { results: [] });
  const gapById = new Map((gap.results || []).map((r) => [r.showId, r]));

  const sinceMs = Date.parse(`${fromDate}T00:00:00Z`) - (og.BEFORE_H + 24) * 3600000;
  const untilMs = Math.min(nowMs, Date.parse(`${toDate}T00:00:00Z`) + (og.AFTER_H + 48) * 3600000);
  const commits = openings.length ? loadCommits(rtDir, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()) : [];

  const grades = openings.map((show) => og.gradeOpening({
    show,
    files: loadFiles(rtDir, show.id),
    commits,
    historyFromMs: hist,
    pressNight: og.pickPressNight(records, show),
    gapResult: gapById.get(show.id) || null,
    nowMs,
  })).sort((a, b) => (b.openingDate.localeCompare(a.openingDate)) || a.showId.localeCompare(b.showId));

  const doc = {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    generator: 'scripts/grade-openings.js (BRO-7082)',
    from: fromDate,
    to: toDate,
    windowHours: { before: og.BEFORE_H, after: og.AFTER_H },
    historyFrom: hist == null ? 'full' : new Date(hist).toISOString(),
    commitsScanned: commits.length,
    summary: og.summarize(grades),
    grades,
  };
  for (const g of grades) console.log(`${g.verdict.padEnd(13)} ${g.showId}  ${og.gradeLine(g)}`);
  console.log(JSON.stringify(doc.summary));
  if (flag('dry-run')) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, outPath)} (${grades.length} openings)`);
}

if (require.main === module) main();
module.exports = { historyFrom, loadCommits, loadFiles };
