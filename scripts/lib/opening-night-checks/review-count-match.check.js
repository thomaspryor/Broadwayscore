'use strict';

const fs = require('fs');
const path = require('path');

const name = 'review-count-match';
const description = 'Local review-texts file count matches reviews.json count (exclusion drift detection)';

const WARN_THRESHOLD = 1;
const ERROR_THRESHOLD = 5;

/**
 * Read today's and yesterday's exclusion JSONL and return a map of
 * filename → { reason, details } for the given show. Balusters postmortem meta-fix:
 * without per-file reasons the check's remediation hint is "go grep the rebuild log" —
 * during a live opening-night review this was invisible. Now every ghost review is
 * named with its exclusion reason up-front.
 */
function loadExclusionIndex(showId, now) {
  const auditDir = path.join(__dirname, '..', '..', '..', 'data', 'audit');
  const dayKeys = [];
  const dayNow = new Date(now);
  const dayPrev = new Date(now.getTime() - 86400000);
  dayKeys.push(dayNow.toISOString().slice(0, 10));
  dayKeys.push(dayPrev.toISOString().slice(0, 10));
  const index = new Map(); // basename → { reason, details }
  for (const day of dayKeys) {
    const p = path.join(auditDir, `exclusions-${day}.jsonl`);
    if (!fs.existsSync(p)) continue;
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.showId !== showId) continue;
      if (!rec.file || rec.file === '-') continue;
      // Prefer newer exclusions; overwrite older
      const prev = index.get(rec.file);
      if (!prev || (prev.ts && rec.ts && rec.ts > prev.ts)) {
        index.set(rec.file, { reason: rec.reason || 'unknown', ts: rec.ts, details: rec.details });
      }
    }
  }
  return index;
}

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  const showDir = path.join(context.reviewTextsRoot, show.id);

  if (!fs.existsSync(showDir)) {
    // No review-texts dir yet — normal pre-opening
    return { ok: true, severity: 'ok', message: 'No review-texts directory yet — skipping count check' };
  }

  let localFiles;
  try {
    localFiles = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  } catch (err) {
    return { ok: true, severity: 'ok', message: `Could not read review-texts dir: ${err.message}` };
  }

  const localCount = localFiles.length;
  const reviewsForShow = context.reviewsDoc[show.id] || [];
  const builtCount = reviewsForShow.length;
  const gap = localCount - builtCount;

  if (gap <= 0) {
    return {
      ok: true,
      severity: 'ok',
      message: `review-texts (${localCount}) matches reviews.json (${builtCount}) — no exclusion drift`,
    };
  }

  // gap > 0: local files exist that were excluded from rebuild.
  // Balusters postmortem meta-fix — load today's exclusion log and name each ghost.
  const exclusionIndex = loadExclusionIndex(show.id, context.now || new Date());
  // Build set of review-text filenames that are represented in reviews.json so we can
  // find the absentees (files on disk not in reviews.json).
  const filenamesInBuild = new Set();
  for (const r of reviewsForShow) {
    if (r.__sourceFile) filenamesInBuild.add(r.__sourceFile);
    if (r.sourceFile) filenamesInBuild.add(r.sourceFile);
    // Synthesize expected filename pattern outlet--critic.json for dedup
    if (r.outletId && r.criticName) {
      const slug = String(r.criticName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      filenamesInBuild.add(`${r.outletId}--${slug}.json`);
    }
  }
  const absentees = localFiles.filter(f => !filenamesInBuild.has(f));
  const reasons = {};
  const named = [];
  for (const f of absentees) {
    const info = exclusionIndex.get(f);
    const reason = info ? info.reason : 'not-logged';
    reasons[reason] = (reasons[reason] || 0) + 1;
    named.push({ file: f, reason });
  }

  const severity = gap >= ERROR_THRESHOLD ? 'error' : 'warning';
  const cmd = `node scripts/rebuild-all-reviews.js --show=${show.id} --verbose 2>&1 | grep EXCLUSION`;
  const reasonSummary = Object.entries(reasons)
    .map(([r, c]) => `${r}=${c}`)
    .sort()
    .join(', ');
  const top = named.slice(0, 8)
    .map(n => `  - ${n.file} (${n.reason})`)
    .join('\n');

  return {
    ok: false,
    severity,
    message: `${gap} local review file(s) excluded from reviews.json (${localCount} local vs ${builtCount} built).\n  By reason: ${reasonSummary || '(no audit log today)'}\n${top}${named.length > 8 ? `\n  ... and ${named.length - 8} more` : ''}\n  Full inspect: ${cmd}`,
    details: { localCount, builtCount, gap, showId: show.id, reasons, ghosts: named },
  };
}

module.exports = { name, description, run, loadExclusionIndex };
