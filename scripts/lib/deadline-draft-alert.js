'use strict';

/**
 * Owner email for an opening-night draft created past its deadline over QA
 * findings (opening-night-broadcast.yml "Page owner: deadline draft", BRO-7297).
 *
 * The owner is not technical. The old inline step read the checklist JSON's
 * `checks` key, but scripts/opening-night-checklist.js writes `results`, so
 * every email said "the checklist reported errors but none could be read
 * back" and named no review (Blueberries, 2026-11-10). It also used show slugs,
 * check names and an action line that told the owner to beat a deadline that
 * had already passed. Everything here is pure so a test can feed it the real
 * checklist shape.
 */

const RESEND_BROADCASTS_URL = 'https://resend.com/broadcasts';
const MAX_LINES_PER_CHECK = 5;

/** Failed error-severity results from a checklist JSON (shows[].results). */
function readChecklistErrors(json) {
  const out = [];
  for (const s of (json && json.shows) || []) {
    // `checks` is tolerated so an older writer cannot silently empty the list again.
    for (const r of s.results || s.checks || []) {
      // Severity alone, matching the summary's error count (opening-night-checks/index.js).
      if (r && r.severity === 'error') out.push(r);
    }
  }
  return out;
}

function defaultOutletName(outletId) {
  try {
    return require('./review-normalization').getOutletDisplayName(outletId) || outletId;
  } catch {
    return outletId;
  }
}

function criticPhrase(name) {
  const n = String(name || '').trim();
  return n && !/^unknown$/i.test(n) ? ` by ${n}` : '';
}

/** Plain-English lines for one failed checklist result. */
function plainFindings(result, { outletName = defaultOutletName } = {}) {
  const d = (result && result.details) || {};
  if (result.name === 'cv-wrongproduction-unhandled' && Array.isArray(d.violations) && d.violations.length) {
    const lines = d.violations.slice(0, MAX_LINES_PER_CHECK).map((v) =>
      `The ${outletName(v.outletId)} review${criticPhrase(v.criticName)} looks like it is about a different production of this show (for example an earlier run), but it is counted in the score.`);
    if (d.violations.length > MAX_LINES_PER_CHECK) lines.push(`${d.violations.length - MAX_LINES_PER_CHECK} more reviews have the same problem.`);
    return lines;
  }
  if (result.name === 'review-cards-complete') {
    return ['At least one review in the draft is missing its outlet name or its quote.'];
  }
  if (result.name === 't1-outlets-scored') {
    return [`A major outlet's review is missing from the score. ${firstSentence(result.message)}`.trim()];
  }
  const what = result.description || result.name;
  return [`${what}. ${firstSentence(result.message)}`.replace(/\.\s*\.$/, '.').trim()];
}

function firstSentence(text) {
  const t = String(text || '').split('\n')[0].trim();
  const m = t.match(/^(.{1,200}?[.!?])(\s|$)/);
  return (m ? m[1] : t.slice(0, 200)).trim();
}

function showTitle(id, showsById, fromChecklist) {
  const s = showsById && showsById[id];
  return (s && s.title) || (fromChecklist && fromChecklist[id]) || id;
}

// send-opening-night-broadcast.js stores draftUrl (and draftId) per show; several
// shows can share one draft, so the links are de-duplicated.
function draftUrlsFor(ids, sentTracker) {
  const shows = (sentTracker && (sentTracker.shows || sentTracker)) || {};
  const urls = new Set();
  for (const id of ids) {
    const rec = shows[id];
    if (rec && rec.draftUrl) urls.add(rec.draftUrl);
    else if (rec && rec.draftId) urls.add(`${RESEND_BROADCASTS_URL}/${rec.draftId}`);
  }
  return urls.size ? [...urls] : [RESEND_BROADCASTS_URL];
}

/**
 * @param {object} p
 * @param {string[]} p.checklistIds - shows whose checklist gate was overridden
 * @param {string[]} p.driftIds - shows whose review-count drift gate was overridden
 * @param {string[]} p.orphanEntries - "<showId>:<action>" from the orphan gate
 * @param {object} p.showsById
 * @param {(id:string)=>object|null} p.readChecklist - parsed checklist JSON, or null if missing
 * @param {object} [p.sentTracker] - data/opening-night-sent.json
 * @returns {{ids:string[], title:string, description:string, url:string}}
 */
function buildDeadlineDraftAlert({ checklistIds = [], driftIds = [], orphanEntries = [], showsById = {}, readChecklist, sentTracker, outletName } = {}) {
  const byShow = new Map();
  const titleFromChecklist = {};
  const add = (id, line) => {
    if (!byShow.has(id)) byShow.set(id, []);
    byShow.get(id).push(line);
  };

  for (const id of checklistIds) {
    let json = null;
    try { json = readChecklist ? readChecklist(id) : null; } catch { json = null; }
    if (!json) {
      add(id, 'The quality check could not run, so none of the reviews were checked. Read through the reviews in the draft before sending.');
      continue;
    }
    for (const s of json.shows || []) {
      if (s && s.show && s.show.id && s.show.title) titleFromChecklist[s.show.id] = s.show.title;
    }
    const errs = readChecklistErrors(json);
    if (!errs.length) {
      add(id, 'The quality check flagged a problem but did not say which review. Read through the reviews in the draft before sending.');
      continue;
    }
    for (const r of errs) for (const line of plainFindings(r, { outletName })) add(id, line);
  }
  for (const id of driftIds) {
    add(id, 'A scored review may be missing from the draft, so the score in it could be slightly off.');
  }
  for (const entry of orphanEntries) {
    const [id, action] = String(entry).split(':');
    if (action === 'error' || !['in-flight', 'wait', 'dispatch', 'alert'].includes(action)) {
      add(id, 'The check that every review has a score did not finish, so the score in the draft may not include every review.');
    } else {
      add(id, 'At least one review was still waiting for its score, so the score in the draft may change slightly.');
    }
  }

  const ids = [...byShow.keys()].sort();
  const titles = ids.map((id) => showTitle(id, showsById, titleFromChecklist));
  const urls = draftUrlsFor(ids, sentTracker);
  const count = [...byShow.values()].reduce((n, l) => n + l.length, 0);
  const title = `${titles.join(' and ')} email draft is ready in Resend: check ${count === 1 ? 'one thing' : `${count} things`} before you send`;
  const sections = ids.map((id) => {
    const lines = byShow.get(id).map((l) => `- ${l}`).join('\n');
    return ids.length > 1 ? `${showTitle(id, showsById, titleFromChecklist)}:\n${lines}` : lines;
  });
  const description = [
    `The opening-night email for ${titles.join(' and ')} is waiting in Resend as a draft. Nothing has gone to subscribers.`,
    `The automatic checks found ${count === 1 ? 'this' : 'these'}:`,
    sections.join('\n\n'),
    "Don't send yet if any of these look wrong. Tell Claude which ones; once they are fixed the draft updates on its own.",
    urls.length === 1 ? `Open the draft: ${urls[0]}` : `Open the drafts:\n${urls.map((u) => `- ${u}`).join('\n')}`,
  ].join('\n\n');

  return { ids, title, description, url: urls[0] };
}

module.exports = { readChecklistErrors, plainFindings, buildDeadlineDraftAlert, RESEND_BROADCASTS_URL };
