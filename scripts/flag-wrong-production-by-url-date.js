#!/usr/bin/env node
/**
 * Flag reviews as wrongProduction when the URL date falls clearly outside
 * the show's date window. Backstop for cases where publishDate is missing
 * but the URL contains an obviously-out-of-window date (e.g. /2023/02/28/).
 *
 * Complements flag-wrong-production-by-date.js which uses publishDate.
 *
 * The window/exemption decision itself is NOT reimplemented here — it calls
 * getWrongProductionReasonFromUrl (scripts/lib/review-guards.js), the same
 * canonical URL-date guard getWrongProductionReasonForUnknownCritic and
 * getWrongProductionReasonForBww wrap for their own ingest-time callers.
 * BRO-3509: this script used to hand-roll its own copy of that window math
 * (a 30d-before/30d-after tolerance layered on top of an already-shifted
 * [previewStart-21d, close+30d] window — effectively ~51d lead / ~60d trail,
 * with no off-broadway widening) and wrote a reason string that didn't start
 * with "Auto-flagged:", so wrong-production-autoclear.js's DATE_GUARD_PREFIXES
 * match never recognized flags this script wrote as auto-clear-eligible.
 * Delegating here fixes both: single source of truth for the window (30d/180d
 * lead, 30d trail, priorRuns/tourLegs-aware), and the reason text now always
 * carries the "Auto-flagged:" prefix the autoclear guard checks for.
 *
 * Usage:
 *   node scripts/flag-wrong-production-by-url-date.js              # dry run
 *   node scripts/flag-wrong-production-by-url-date.js --apply      # write flags
 *   node scripts/flag-wrong-production-by-url-date.js --show=ID    # one show
 */
const fs = require('fs');
const path = require('path');
const { shouldSkipWrongProductionAudit, getWrongProductionReasonFromUrl } = require('./lib/review-guards');
const { listShowDirs } = require('./lib/list-show-dirs');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const APPLY = process.argv.includes('--apply');
const ONLY_SHOW = (process.argv.find(a => a.startsWith('--show=')) || '').split('=')[1];

const SHOWS = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = Array.isArray(SHOWS.shows) ? SHOWS.shows : Object.values(SHOWS.shows || SHOWS);
const showMap = {};
for (const s of shows) showMap[s.id] = s;

const dirs = listShowDirs(REVIEW_DIR);

let flagged = 0;
const flaggedDetails = [];

for (const showId of dirs) {
  if (ONLY_SHOW && showId !== ONLY_SHOW) continue;
  const show = showMap[showId];
  if (!show) continue;

  const files = fs.readdirSync(path.join(REVIEW_DIR, showId)).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const fp = path.join(REVIEW_DIR, showId, f);
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (d.wrongProduction || d.wrongShow || d.manualClear || d.allowEarlyDate || d.allowLateDate) continue;
    if (shouldSkipWrongProductionAudit(d)) continue;
    if (!d.assignedScore && !d.llmScore?.score) continue;

    const reason = getWrongProductionReasonFromUrl(d.url, show);
    if (!reason) continue;

    const urlDateMatch = reason.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    flaggedDetails.push({ showId, file: f, urlDate: urlDateMatch ? urlDateMatch[1] : null, score: d.assignedScore });
    if (APPLY) {
      d.wrongProduction = true;
      d.wrongProductionReason = reason;
      d.wrongProductionFlaggedAt = new Date().toISOString();
      d.wrongProductionFlaggedBy = 'script:flag-wrong-production-by-url-date.js';
      fs.writeFileSync(fp, JSON.stringify(d, null, 2));
    }
    flagged++;
  }
}

console.log(APPLY ? 'APPLIED' : 'DRY RUN');
console.log('Flagged:', flagged);
flaggedDetails.forEach(x => console.log(' ', x.showId, '|', x.file, '|', x.urlDate, '| score:', x.score));
