#!/usr/bin/env node
/**
 * Flag reviews as wrongProduction when the URL date falls clearly outside
 * the show's date window. Backstop for cases where publishDate is missing
 * but the URL contains an obviously-out-of-window date (e.g. /2023/02/28/).
 *
 * Complements flag-wrong-production-by-date.js which uses publishDate.
 * Only flags if URL date is >30 days outside the [previewStart-21d, close+30d] window.
 *
 * Usage:
 *   node scripts/flag-wrong-production-by-url-date.js              # dry run
 *   node scripts/flag-wrong-production-by-url-date.js --apply      # write flags
 *   node scripts/flag-wrong-production-by-url-date.js --show=ID    # one show
 */
const fs = require('fs');
const path = require('path');
const { shouldSkipWrongProductionAudit } = require('./lib/review-guards');
const { isWithinPriorRun } = require('./lib/wrong-production-autoclear');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const APPLY = process.argv.includes('--apply');
const ONLY_SHOW = (process.argv.find(a => a.startsWith('--show=')) || '').split('=')[1];

const SHOWS = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = Array.isArray(SHOWS.shows) ? SHOWS.shows : Object.values(SHOWS.shows || SHOWS);
const showMap = {};
for (const s of shows) showMap[s.id] = s;

// Word-month map so Guardian-style /YYYY/monthname/DD/ URLs are matched.
// Mirrors URL_MONTH_NAMES in scripts/lib/review-guards.js.
const URL_MONTH_NAMES = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

const dirs = fs.readdirSync(REVIEW_DIR).filter(d => fs.statSync(path.join(REVIEW_DIR, d)).isDirectory());

let flagged = 0;
const flaggedDetails = [];

for (const showId of dirs) {
  if (ONLY_SHOW && showId !== ONLY_SHOW) continue;
  const show = showMap[showId];
  if (!show) continue;
  const earliestStr = show.previewDate || show.previewsStartDate || show.openingDate;
  if (!earliestStr) continue;

  const windowStart = new Date(earliestStr);
  windowStart.setDate(windowStart.getDate() - 21);
  const closing = show.closingDate ? new Date(show.closingDate) : new Date('2099-01-01');
  closing.setDate(closing.getDate() + 30);

  const files = fs.readdirSync(path.join(REVIEW_DIR, showId)).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const fp = path.join(REVIEW_DIR, showId, f);
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (d.wrongProduction || d.wrongShow || d.manualClear || d.allowEarlyDate || d.allowLateDate) continue;
    if (shouldSkipWrongProductionAudit(d)) continue;
    if (!d.assignedScore && !d.llmScore?.score) continue;

    const url = d.url || '';
    // Match numeric months /YYYY/MM/ and Guardian word months /YYYY/monthname/
    const m = url.match(/\/(20\d{2})\/([a-z]{3,4}|\d{2})(?:\/(\d{1,2}))?\//i);
    if (!m) continue;
    const rawMonth = m[2].toLowerCase();
    const month = /^\d{2}$/.test(rawMonth) ? rawMonth : URL_MONTH_NAMES[rawMonth];
    if (!month) continue;
    const dayPart = m[3] ? String(m[3]).padStart(2, '0') : '15';
    const urlDate = new Date(`${m[1]}-${month}-${dayPart}`);
    if (isNaN(urlDate.getTime())) continue;
    const daysBefore = Math.round((windowStart - urlDate) / 86400000);
    const daysAfter = Math.round((urlDate - closing) / 86400000);
    if (daysBefore <= 30 && daysAfter <= 30) continue;

    // Production-continuity exemption: URL date falls inside a declared priorRuns
    // window — legitimate coverage of an earlier run of THIS production.
    if (isWithinPriorRun(urlDate, show.priorRuns)) continue;

    const reason = daysBefore > 30
      ? `URL date ${urlDate.toISOString().slice(0,10)} is ${daysBefore} days before show window starts (${windowStart.toISOString().slice(0,10)}). Likely review of an earlier production.`
      : `URL date ${urlDate.toISOString().slice(0,10)} is ${daysAfter} days after show closed. Likely review of a later production/revival/tour.`;

    flaggedDetails.push({ showId, file: f, urlDate: urlDate.toISOString().slice(0,10), score: d.assignedScore });
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
