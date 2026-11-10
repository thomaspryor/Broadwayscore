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

// One plain sentence per flagged review, for every error-severity check in
// scripts/lib/opening-night-checks/. `who` is "The <Outlet> review[ by <critic>]".
// Never echo a check's own description or message: those are written for
// engineers (slugs, file names, task numbers). BRO-7297.
const CHECK_LINES = {
  'cv-wrongproduction-unhandled': { list: 'violations', line: (who) => `${who} looks like it is about a different production of this show (for example an earlier run), but it is counted in the score.` },
  'slug-mismatch': { list: 'mismatches', line: (who) => `${who} has a web link that does not mention this show, so it may belong to a different show.` },
  'fulltext-mentions-show': { list: 'violations', line: (who) => `${who} never mentions the show by name, so it may be about a different show.` },
  'assigned-score-schema': { list: 'violations', line: (who) => `${who} has a score that is not a number, so it may be counted wrong.` },
  'publish-date-pre-opening': { list: 'violations', line: (who, v) => `${who} is dated ${friendlyDate(v.publishDate)}, before this show opened, so it may be about an earlier production.` },
  'wrong-production-bww': { list: 'problems', line: (who) => `${who} is dated well before this show opened, so it may be about an earlier production.` },
};

function friendlyDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 'earlier';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function reviewPhrase(v, outletName) {
  const outlet = v && v.outletId ? outletName(v.outletId) : '';
  if (!outlet) return 'One review';
  return `${/^the\s/i.test(outlet) ? outlet : `The ${outlet}`} review${criticPhrase(v.criticName)}`;
}

/** Plain-English lines for one failed checklist result. */
function plainFindings(result, { outletName = defaultOutletName } = {}) {
  const r = result || {};
  const d = r.details || {};
  if (/^check threw:/.test(String(r.message || ''))) {
    return ['One of the automatic checks broke while it ran, so part of the review list was not checked. Read through the reviews in the draft before sending.'];
  }
  const spec = CHECK_LINES[r.name];
  const items = spec && Array.isArray(d[spec.list]) ? d[spec.list] : [];
  if (items.length) {
    const lines = items.slice(0, MAX_LINES_PER_CHECK).map((v) => spec.line(reviewPhrase(v, outletName), v));
    if (items.length > MAX_LINES_PER_CHECK) lines.push(`${items.length - MAX_LINES_PER_CHECK} more reviews have the same problem.`);
    return lines;
  }
  if (r.name === 'review-cards-complete') {
    return ['At least one review in the draft is missing its outlet name or its quote.'];
  }
  if (r.name === 't1-outlets-scored') {
    return ["A review from a major outlet (such as The New York Times) is missing from the score."];
  }
  return ['One of the automatic checks flagged a review but could not say which one in plain words. Ask Claude what it found before sending.'];
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
    } else if (action === 'alert') {
      add(id, 'At least one review never got its score after several tries, so the score in the draft leaves it out.');
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
    "Don't send yet if any of these look wrong. Tell Claude which ones, and wait until Claude says the draft is fixed.",
    urls.length > 1 ? `Open the drafts:\n${urls.map((u) => `- ${u}`).join('\n')}`
      : urls[0] === RESEND_BROADCASTS_URL ? `Open your drafts in Resend (it is the newest one): ${urls[0]}`
        : `Open the draft: ${urls[0]}`,
  ].join('\n\n');

  return { ids, title, description, url: urls[0] };
}

module.exports = { readChecklistErrors, plainFindings, buildDeadlineDraftAlert, RESEND_BROADCASTS_URL, CHECK_LINES };
