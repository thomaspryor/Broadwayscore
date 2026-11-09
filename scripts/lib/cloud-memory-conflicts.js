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

module.exports = { CONFLICT_DIR, REPORT_BASENAME, publishConflictReport, readConflictDigest };
