'use strict';

// BRO-2557: session-stop can discard stderr. Publish an inventory alongside
// the mirror so its existing commit/push also carries it to the CI digest.
// No memo bodies or absolute local paths belong in this public report.
const fs = require('fs');
const path = require('path');

// Saved copies stay below the local source, outside the root-level *.md
// mirror, so they cannot be adopted back as ordinary memories.
const CONFLICT_DIR = '_conflicts';
const REPORT_BASENAME = 'sync-conflicts.json';
let reportSeq = 0;

function publishConflictReport({ src, dest, now = new Date() }) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(src, CONFLICT_DIR), { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    entries = [];
  }
  const paths = entries
    .filter(e => e.isFile() && /\.cloud-conflict-.+\.md$/.test(e.name))
    .map(e => `${CONFLICT_DIR}/${e.name}`).sort();
  const reportPath = path.join(dest, REPORT_BASENAME);
  let previous;
  try { previous = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  // Keep unresolved copies visible across quiet syncs. Do not dirty the
  // mirror on every session-stop, or introduce a report on a clean machine.
  if ((!previous && paths.length === 0 && !fs.existsSync(reportPath))
      || (previous?.version === 1 && previous.conflictCount === paths.length
        && JSON.stringify(previous.paths) === JSON.stringify(paths))) return;
  const report = { version: 1, generatedAt: now.toISOString(), conflictCount: paths.length, paths };
  const tmp = `${reportPath}.tmp-${process.pid}-${reportSeq++}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(report)}\n`);
    fs.renameSync(tmp, reportPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// BRO-7228: MEMORY.md is a hand-trimmed index (180 lines / 20KB, hook-enforced,
// "at cap: add => merge one"), so a saved mirror copy of it never needs a
// human, and must never be written back into it: appending a pointer could
// breach the byte cap or resurrect an entry the owner removed on purpose.
// Cloud sessions still reach unindexed memos through INDEX.txt. Five copies sat
// in _conflicts/ for six weeks and the morning digest flagged them daily, so
// each sync moves them to _conflicts/_resolved/. That is a subdirectory, which
// the report above never counts, and nothing is deleted: the copy survives.
// Copies of any other memo still wait for review.
const RESOLVED_DIR = '_resolved';
const COPY_RE = /^MEMORY\.cloud-conflict-.+\.md$/;

function archiveIndexConflictCopies({ src }) {
  const result = { archived: [] };
  const dir = path.join(src, CONFLICT_DIR);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && COPY_RE.test(e.name)).map(e => e.name).sort();
    if (names.length) fs.mkdirSync(path.join(dir, RESOLVED_DIR), { recursive: true });
  } catch (err) {
    if (err.code === 'ENOENT') return result;
    throw err;
  }
  for (const name of names) {
    try {
      // rename() silently replaces an existing file; keep both instead.
      if (fs.existsSync(path.join(dir, RESOLVED_DIR, name))) continue;
      fs.renameSync(path.join(dir, name), path.join(dir, RESOLVED_DIR, name));
      result.archived.push(name);
    } catch (err) {
      // A parallel session-stop already moved it: that is the goal state.
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return result;
}

// An unresolved conflict does not expire: it needs review even if the Mac
// has stopped syncing. Missing reports are normal before the first conflict.
function readConflictDigest(dest) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(dest, REPORT_BASENAME), 'utf8'));
    if (report?.version !== 1 || !Array.isArray(report.paths)
        || report.conflictCount !== report.paths.length
        || !report.paths.every(p => typeof p === 'string'
          && p.startsWith(`${CONFLICT_DIR}/`)
          && path.posix.dirname(p) === CONFLICT_DIR && p.endsWith('.md'))) {
      throw new Error('Invalid conflict report');
    }
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return {
      bannerText: 'Could not read the saved memory conflict report',
      items: [{ title: 'Memory conflict visibility needs checking', detail: `Check cloud-memory/${REPORT_BASENAME}.` }],
    };
  }
  if (report.conflictCount === 0) return null;
  return {
    generatedAt: report.generatedAt,
    bannerText: `${report.conflictCount} saved ${report.conflictCount === 1 ? 'copy needs' : 'copies need'} review`,
    items: report.paths.slice(0, 3).map(p => ({
      title: p,
      detail: 'Both versions were saved. Review this copy in the local memory directory, then move it out of _conflicts/.',
    })),
    moreCount: Math.max(0, report.conflictCount - 3),
  };
}

module.exports = {
  CONFLICT_DIR, REPORT_BASENAME, RESOLVED_DIR,
  publishConflictReport, readConflictDigest, archiveIndexConflictCopies,
};
