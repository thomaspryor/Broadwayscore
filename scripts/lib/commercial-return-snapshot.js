'use strict';

const { TRICKLE_MAX_MULTIPLE, MODEST_RETURN_DESIGNATIONS } = require('./commercial-designations');

// BRO-6333: dated return evidence, independent of modelLastRun/lastUpdated.
// Month/year-only evidence ages from the end of its stated period.
function dateBounds(value) {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value || '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2] || 1);
  const day = Number(match[3] || 1);
  const start = Date.UTC(year, month - 1, day);
  const date = new Date(start);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const end = match[3] ? start : match[2] ? Date.UTC(year, month, 0) : Date.UTC(year, 11, 31);
  return { start, end };
}

function returnSnapshotDate(entry, now = new Date()) {
  if (!entry || entry.recouped !== true) return null;
  // The public card receives the date selected from the full source record.
  if (dateBounds(entry.returnSnapshotAsOf)?.start <= Number(now)) return entry.returnSnapshotAsOf;
  // Recoupment establishes Trickle's 1x floor, never a Windfall. Do not
  // attach that earlier date to a later profit label without return evidence.
  const dates = entry.designation === 'Windfall' ? [] : [entry.recoupedDate];
  for (const [range, date] of [[entry.analystRecoupPct, entry.analystRecoupAsOf], [entry.estimatedRecoupmentPct, entry.estimatedRecoupmentDate]]) {
    // A pre-recoupment estimate cannot date a recouped label.
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 100 || range[1] < range[0]) continue;
    if (entry.designation === 'Windfall' && range[0] < TRICKLE_MAX_MULTIPLE * 100) continue;
    if (MODEST_RETURN_DESIGNATIONS.includes(entry.designation) && range[1] >= TRICKLE_MAX_MULTIPLE * 100) continue;
    dates.push(date);
  }
  return dates.filter(d => dateBounds(d)?.start <= Number(now))
    .sort((a, b) => dateBounds(b).end - dateBounds(a).end)[0] || null;
}

function isRunningReturn(show, now = new Date()) {
  return show?.status === 'open' && !(show.closingDate && Date.parse(show.closingDate) < Number(now));
}

function returnSnapshotLabel(entry, show, now = new Date()) {
  if (!isRunningReturn(show, now) || ![...MODEST_RETURN_DESIGNATIONS, 'Windfall'].includes(entry?.designation)) return null;
  const asOf = returnSnapshotDate(entry, now);
  if (!asOf) return null;
  // A year-only source does not supply a month to print.
  const label = asOf.length === 4 ? asOf : new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(dateBounds(asOf).start);
  return `as of ${label}`;
}

module.exports = { dateBounds, returnSnapshotDate, isRunningReturn, returnSnapshotLabel };
