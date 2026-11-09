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

// BRO-7228: MEMORY.md is an index of pointer lines, so a saved mirror copy of
// it never needs a human. Five of them sat in _conflicts/ for six weeks and
// the morning digest flagged them daily. A copy is settled automatically:
//   - pointers the local index already links  -> nothing to carry over
//   - pointers to a memo that exists locally but is unlinked -> appended to the
//     local index, as long as the index stays within its hard line cap
//   - pointers to a memo that no longer exists -> dead, dropped
// Settled copies move to _conflicts/_resolved/ (a subdirectory, so the report
// above never counts them) and are never deleted. A copy that would push the
// index past the cap stays put, because choosing what to trim is a judgment.
const RESOLVED_DIR = '_resolved';
const INDEX_NAME = 'MEMORY.md';
const INDEX_LINE_CAP = 180;
const COPY_RE = /^MEMORY\.cloud-conflict-.+\.md$/;
const POINTER_RE = /^\s*[-*]\s+\[[^\]]*\]\(([^)\s]+\.md)\)/;

function pointerTarget(line) {
  const m = POINTER_RE.exec(line);
  // A link out of the memory dir is not a memo pointer; never follow it.
  return m && !m[1].includes('/') && !m[1].includes('..') ? m[1] : null;
}

function autoResolveIndexConflicts({ src }) {
  const result = { resolved: [], kept: [], appended: [], indexChanged: false };
  const dir = path.join(src, CONFLICT_DIR);
  const indexPath = path.join(src, INDEX_NAME);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && COPY_RE.test(e.name)).map(e => e.name).sort();
    if (!fs.statSync(indexPath).isFile()) return result;
  } catch (err) {
    if (err.code === 'ENOENT') return result;
    throw err;
  }
  for (const name of names) {
    const copyPath = path.join(dir, name);
    let local = fs.readFileSync(indexPath, 'utf8');
    const localLines = local.replace(/\n$/, '').split('\n');
    const linked = new Set(localLines.map(pointerTarget).filter(Boolean));
    const add = [];
    for (const line of fs.readFileSync(copyPath, 'utf8').split('\n')) {
      const target = pointerTarget(line);
      if (!target || linked.has(target) || !fs.existsSync(path.join(src, target))) continue;
      linked.add(target);
      add.push(line.replace(/\s+$/, ''));
    }
    if (localLines.length + add.length > INDEX_LINE_CAP) {
      result.kept.push(name);
      continue;
    }
    if (add.length) {
      // Re-read nothing here: this runs synchronously, so the index cannot
      // change between the read above and this write.
      const tmp = `${indexPath}.tmp-${process.pid}-${reportSeq++}`;
      try {
        fs.writeFileSync(tmp, `${local.replace(/\n*$/, '\n')}${add.join('\n')}\n`);
        fs.renameSync(tmp, indexPath);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      result.appended.push(...add);
      result.indexChanged = true;
    }
    fs.mkdirSync(path.join(dir, RESOLVED_DIR), { recursive: true });
    fs.renameSync(copyPath, path.join(dir, RESOLVED_DIR, name));
    result.resolved.push(name);
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
  CONFLICT_DIR, REPORT_BASENAME, INDEX_NAME, INDEX_LINE_CAP, RESOLVED_DIR,
  publishConflictReport, readConflictDigest, autoResolveIndexConflicts,
};
