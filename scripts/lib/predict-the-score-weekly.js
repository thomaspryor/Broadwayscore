'use strict';
// BRO-7463: numbers and wording for the owner's Friday "Predict the Score" email.
// Pure functions only (no I/O) so the test can require() the real thing.
//
// Privacy: buildReport() takes raw score_calls rows (it has to, to count distinct
// people) but its output holds counts and averages only. No user id, no email, and
// no individual prediction leaves this module.

const DAY_MS = 86400000;
const ADMIN_URL = 'https://broadwayscorecard.com/admin/forecasts';

/**
 * @param {Array<{user_id:string, show_id:string, called_score:number, locked_at:string}>} calls
 * @param {{ownerUserIds?: Iterable<string>, titles?: Record<string,string>, now?: Date}} opts
 */
function buildReport(calls, { ownerUserIds = [], titles = {}, now = new Date() } = {}) {
  const owners = new Set(ownerUserIds);
  const cutoff = now.getTime() - 7 * DAY_MS;
  const others = [];
  let ownerPredictions = 0;
  for (const c of calls || []) {
    if (!c || !c.user_id) continue;
    if (owners.has(c.user_id)) { ownerPredictions++; continue; }
    others.push(c);
  }

  const firstCall = new Map(); // user -> earliest locked_at (ms)
  const byShow = new Map();    // show -> {count, sum}
  let newPredictions = 0;
  for (const c of others) {
    const t = Date.parse(c.locked_at);
    if (Number.isFinite(t)) {
      if (t >= cutoff) newPredictions++;
      const prev = firstCall.get(c.user_id);
      if (prev === undefined || t < prev) firstCall.set(c.user_id, t);
    } else if (!firstCall.has(c.user_id)) {
      firstCall.set(c.user_id, -Infinity);
    }
    const s = byShow.get(c.show_id) || { count: 0, sum: 0 };
    s.count++;
    s.sum += Number(c.called_score) || 0;
    byShow.set(c.show_id, s);
  }

  let newPeople = 0;
  for (const t of firstCall.values()) if (t >= cutoff) newPeople++;

  const perShow = [...byShow.entries()].map(([showId, s]) => ({
    showId,
    title: titleFor(showId, titles),
    count: s.count,
    average: Math.round((s.sum / s.count) * 10) / 10,
  })).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));

  return {
    people: firstCall.size,
    predictions: others.length,
    newPeople,
    newPredictions,
    ownerPredictions,
    perShow,
  };
}

function titleFor(showId, titles) {
  if (titles && titles[showId]) return titles[showId];
  return String(showId).replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** @returns {{subject:string, text:string}} */
function renderEmail(r) {
  const subject = r.people === 0
    ? 'Predict the Score: no one has predicted yet'
    : `Predict the Score: ${plural(r.people, 'person', 'people')} so far (+${r.newPeople} this week)`;

  const lines = [];
  if (r.people === 0) {
    lines.push('No one other than you has made a prediction on Predict the Score yet.');
  } else {
    lines.push(`${plural(r.people, 'person has', 'people have')} made a prediction on Predict the Score so far, and ${r.newPeople} of them started this week.`);
    lines.push('');
    lines.push(`Predictions: ${r.predictions} in total, ${r.newPredictions} in the last 7 days.`);
  }
  if (r.ownerFound === false) lines.push('Your own account was not found, so these counts may include you.');
  else lines.push(`These counts leave out your own account (${plural(r.ownerPredictions, 'prediction', 'predictions')} from you).`);

  if (r.perShow.length) {
    lines.push('');
    lines.push('By show (predictions, average prediction):');
    for (const s of r.perShow) lines.push(`${s.title}: ${s.count}, ${s.average}`);
  }

  lines.push('');
  lines.push('Claude');
  lines.push('');
  lines.push(ADMIN_URL);
  return { subject, text: lines.join('\n') };
}

/** Hour (0-23) in New York for a Date. Used to pick the DST-correct one of two crons. */
function easternWeekday(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
}

function easternHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(d)) % 24;
}

module.exports = { buildReport, renderEmail, easternHour, easternWeekday, titleFor, ADMIN_URL };
