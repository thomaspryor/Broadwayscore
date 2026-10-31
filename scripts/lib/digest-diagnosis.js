/**
 * Why is a behind-pace show behind? Used by send-opening-digest.js so the
 * "Needs help" section only lists shows where a person has to act.
 *
 * Inputs are existing pipeline state, nothing new is collected:
 *   - data/audit/t1-silent-gaps.json  (reviews found but never scored / empty body)
 *   - data/audit/poller-backoff/<id>.json  (when the opening-night poller last ran)
 *
 * Returns null when there is no signal (fail open: the row keeps today's
 * "Needs help" treatment), otherwise { state: 'waiting' | 'stuck', reason }.
 */
const fs = require('fs');
const path = require('path');

const STALE_CHECK_HOURS = 72;     // poller-backoff push is non-critical, so allow slack
const STALE_GAPS_HOURS = 48;      // ignore a silent-gaps file the audit stopped refreshing

function hoursSince(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 36e5 : null;
}

function ago(hours) {
  return hours < 48 ? `${Math.max(1, Math.round(hours))}h ago` : `${Math.round(hours / 24)}d ago`;
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function loadSilentGaps(file, now = new Date()) {
  if (!file || !Array.isArray(file.gaps)) return null;
  const h = hoursSince(file.generatedAt, now);
  if (h === null || h > STALE_GAPS_HOURS) return null;
  return file.gaps;
}

function loadBackoff(dir, showId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${showId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function outletList(gaps) {
  return [...new Set(gaps.map(g => g.outletId))].slice(0, 3).join(', ');
}

function diagnoseShow({ row, backoff, silentGaps, backoffAvailable, now = new Date() }) {
  const gaps = (silentGaps || []).filter(g => g.showId === row.id);
  const unscored = gaps.filter(g => g.type === 'unscored');
  const empty = gaps.filter(g => g.type === 'empty-body');
  if (unscored.length) {
    return { state: 'stuck', reason: `${plural(unscored.length, 'found review')} not scored yet (${outletList(unscored)})` };
  }
  if (empty.length) {
    return { state: 'stuck', reason: `${plural(empty.length, 'found review')} with no text loaded (${outletList(empty)})` };
  }
  if (row.broadcastOverdue && row.qualifies) {
    return { state: 'stuck', reason: 'ready to broadcast but not sent, check the broadcast job' };
  }
  if (!backoffAvailable) return null;
  const last = backoff && backoff.lastRunAt;
  if (!last) return { state: 'stuck', reason: 'no review check on record' };
  const h = hoursSince(last, now);
  if (h === null || h > STALE_CHECK_HOURS) {
    return { state: 'stuck', reason: `review checker last ran ${h === null ? 'at an unknown time' : ago(h)}` };
  }
  const short = row.qualifyGap ? ` (short: ${row.qualifyGap})` : '';
  return { state: 'waiting', reason: `waiting on critics, checked ${ago(h)}${short}` };
}

module.exports = { diagnoseShow, loadSilentGaps, loadBackoff, STALE_CHECK_HOURS, STALE_GAPS_HOURS };
