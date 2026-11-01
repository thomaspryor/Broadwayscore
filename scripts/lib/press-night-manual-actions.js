'use strict';

/**
 * BRO-6661: auto-log hand fixes made during a press night from the review-texts git history.
 *
 * BRO-6652 added rec.manualActions, but entries only came from a human running
 * `press-night-record.js --log-manual`. A hand ingest nobody logged made the night count as "passed on its own".
 * review-texts commits are the evidence nobody has to remember to write: an `ingest-urls:` commit (the
 * ingest-urls.yml dispatch and the CLI both use that subject) or any commit by a non-bot author that touches the
 * show's directory inside the night window is a hand fix.
 *
 * Pure: parsing and selection only. The caller runs git and writes the record.
 */

const HOUR = 3600000;
const SEP = '\x1e'; // record separator between commits in the git log output
// `git -C data/review-texts log --format=<LOG_FORMAT> --name-only -- <show>/`
const LOG_FORMAT = `${SEP}%H|%aI|%an|%s`;

const toMs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

function isBotAuthor(name) {
  return /\[bot\]|^github-actions|^dependabot/i.test(String(name || ''));
}

/** Parse `git log --format=LOG_FORMAT --name-only` output into [{ sha, at, author, subject, files }]. */
function parseGitLog(raw) {
  const out = [];
  for (const chunk of String(raw || '').split(SEP)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const m = /^([0-9a-f]{7,40})\|([^|]+)\|([^|]*)\|(.*)$/.exec(lines[0]);
    if (!m) continue;
    out.push({ sha: m[1], at: m[2], author: m[3], subject: m[4].trim(), files: lines.slice(1).map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

/** `<outletId>--<critic>.json` (under `<show>/`) -> outletId, else null. */
function outletIdFromFile(file, showId) {
  const m = /^([^/]+)\/([^/]+?)--[^/]*\.json$/.exec(String(file || ''));
  return m && m[1] === showId ? m[2] : null;
}

/**
 * Hand-fix entries for one night. One entry per (commit, outlet); a commit that touches no outlet file still logs
 * one entry with outletId null. Matches addManualAction's argument shape.
 */
function manualActionsFromCommits(commits, { showId, embargoAt, nightStartH = 4, endH = 6 }) {
  const embMs = toMs(embargoAt);
  if (embMs == null || !showId) return [];
  const lo = embMs - nightStartH * HOUR;
  const hi = embMs + endH * HOUR;
  const out = [];
  for (const c of commits || []) {
    const at = toMs(c.at);
    if (at == null || at < lo || at > hi) continue;
    const ingest = /^ingest-urls:/i.test(c.subject || '');
    if (!ingest && isBotAuthor(c.author)) continue;
    const touched = (c.files || []).filter((f) => f.startsWith(`${showId}/`));
    if (!touched.length) continue;
    const source = `${String(c.sha).slice(0, 8)} ${c.subject}`;
    const ids = [...new Set(touched.map((f) => outletIdFromFile(f, showId)).filter(Boolean))];
    const base = { at: new Date(at).toISOString(), kind: 'hand-fix', source };
    if (!ids.length) out.push({ ...base, outletId: null, outlet: null });
    else for (const id of ids) out.push({ ...base, outletId: id, outlet: id });
  }
  return out;
}

/** True when rec.manualActions already holds this fix (same outlet within 30 min, or the same short sha in a source), e.g. a human logged it first. */
function alreadyLogged(rec, a) {
  const sha = String(a.source || '').split(' ')[0];
  return (rec.manualActions || []).some((m) => (sha && String(m.source || '').includes(sha))
    || ((m.outletId || null) === (a.outletId || null) && Math.abs(Date.parse(m.at) - Date.parse(a.at)) <= 30 * 60000));
}

module.exports = { alreadyLogged, LOG_FORMAT, SEP, isBotAuthor, parseGitLog, outletIdFromFile, manualActionsFromCommits };
