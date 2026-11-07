'use strict';
// BRO-5963: pure helpers for the monthly backup restore drill
// (.github/workflows/backup-restore-drill.yml). Counts and names only: nothing
// here ever returns or logs a row, an email address or a secret.
const fs = require('fs');
const path = require('path');

const WEEKLY_FILES = [
  'broadwayscore-web.bundle.gpg',
  'broadway-review-texts.bundle.gpg',
  'broadway-scorecard-data.bundle.gpg',
  'broadwayscorecard-app.bundle.gpg',
  'MANIFEST.sha256',
];
const DAILY_FILES = ['supabase-data.tar.gz.gpg', 'MANIFEST.sha256', 'BACKUP_MANIFEST.json'];
const MAX_AGE_DAYS = { weekly: 8, daily: 2 };

// Sort key for a run folder: run-<id> or run-<id>-<attempt>; none sorts first.
function runOrder(runDir) {
  const m = runDir && runDir.match(/^run-(\d+)(?:-(\d+))?$/);
  return m ? Number(m[1]) * 1000 + Number(m[2] || 1) : 0;
}

// `listing` is the output of `aws s3 ls --recursive s3://bucket/<kind>/` (or bare keys).
// Returns the newest complete set as { prefix, date, files }, newest by (date, run id).
function pickLatestSet(kind, listing, now = new Date()) {
  const expected = kind === 'weekly' ? WEEKLY_FILES : kind === 'daily' ? DAILY_FILES : null;
  if (!expected) throw new Error(`unknown kind: ${kind}`);
  // BRO-6132: the R2 bucket lock refuses overwrites, so every run writes under its own
  // run-<id>[-<attempt>] folder. Weekly sets from before that change have no run folder.
  const re = kind === 'weekly'
    ? /^weekly\/(\d{4}-\d{2}-\d{2})\/(?:(run-\d+(?:-\d+)?)\/)?([^/]+)$/
    : /^daily\/(\d{4}-\d{2}-\d{2})\/(run-\d+(?:-\d+)?)\/([^/]+)$/;
  const sets = new Map();
  for (const line of String(listing).split('\n')) {
    const key = line.trim().split(/\s+/).pop();
    const m = key && key.match(re);
    if (!m) continue;
    const [, date, runDir, file] = m;
    const prefix = runDir ? `${kind}/${date}/${runDir}` : `${kind}/${date}`;
    if (!sets.has(prefix)) sets.set(prefix, { prefix, date, run: runOrder(runDir), files: new Set() });
    sets.get(prefix).files.add(file);
  }
  const complete = [...sets.values()]
    .filter((s) => expected.every((f) => s.files.has(f)))
    .sort((a, b) => (a.date === b.date ? b.run - a.run : a.date < b.date ? 1 : -1));
  if (!complete.length) throw new Error(`no complete ${kind} backup set found (${sets.size} partial prefixes seen)`);
  const best = complete[0];
  const ageDays = (now.getTime() - Date.parse(`${best.date}T00:00:00Z`)) / 86400000;
  if (ageDays > MAX_AGE_DAYS[kind]) {
    throw new Error(`newest complete ${kind} set ${best.prefix} is ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS[kind]}); backups have stopped`);
  }
  return { prefix: best.prefix, date: best.date, files: [...best.files].sort() };
}

// Count non-empty lines of an ndjson file without holding it in memory.
function countLines(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let n = 0; let lineHasData = false; let read;
  try {
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i++) {
        const b = buf[i];
        if (b === 10) { if (lineHasData) n++; lineHasData = false; } else if (b !== 13 && b !== 32) lineHasData = true;
      }
    }
  } finally { fs.closeSync(fd); }
  return lineHasData ? n + 1 : n;
}

// Recount an unpacked Supabase export against its BACKUP_MANIFEST.json.
// Returns { counts: {dataset: n}, problems: [string] }. Used by the drill and by
// supabase-backup-verify.js so there is one parser.
function recountExport(dir, outerManifest) {
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'BACKUP_MANIFEST.json'), 'utf8'));
  const counts = {};
  const names = Object.keys(manifest.tables || {});
  if (!names.length) problems.push('manifest lists no tables');
  for (const name of names) {
    const file = path.join(dir, 'tables', `${name}.ndjson`);
    if (!fs.existsSync(file)) { problems.push(`${name}: table file missing`); continue; }
    counts[name] = countLines(file);
    if (counts[name] !== manifest.tables[name].rows) problems.push(`${name}: file has ${counts[name]} rows, manifest says ${manifest.tables[name].rows}`);
  }
  const authFile = path.join(dir, 'auth_users.ndjson');
  counts.auth_users = fs.existsSync(authFile) ? countLines(authFile) : 0;
  if (counts.auth_users === 0) problems.push('auth_users.ndjson is missing or empty');
  if (counts.auth_users !== manifest.auth_users) problems.push(`auth_users: file has ${counts.auth_users}, manifest says ${manifest.auth_users}`);
  if (outerManifest) {
    const outer = JSON.parse(fs.readFileSync(outerManifest, 'utf8'));
    if (JSON.stringify(outer) !== JSON.stringify(manifest)) problems.push('uploaded BACKUP_MANIFEST.json differs from the one inside the encrypted archive');
  }
  return { counts, problems };
}

module.exports = { WEEKLY_FILES, DAILY_FILES, MAX_AGE_DAYS, pickLatestSet, countLines, recountExport };
