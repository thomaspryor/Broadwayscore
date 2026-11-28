/**
 * reddit-review-check.js (BRO-5887): pure logic for the pre-send review check
 * that runs before a Reddit opening-post draft is emailed.
 *
 * Why: the owner ran a session per show after every draft and always found
 * 1-2 missing reviews and 1-2 wrong or missing critic names and dates. The
 * check runs the existing show-scoped recovery tools for each draft about to
 * be emailed (scripts/verify-reddit-draft-reviews.js does the spawning) and
 * this file decides what is due, what changed, what is still missing and how
 * to say so in the email. No fs writes, no network, no spawning here.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { dueEmails, resendEmails } = require('./reddit-post-email');

const MAX_SHOWS_PER_RUN = 3;
// A verification this fresh, taken at the draft's current numbers, is reused.
const FRESH_HOURS = 20;
const FLAG_KEYS = ['wrongProduction', 'wrongShow', 'isNotReview', 'isNonReview', 'isRoundupArticle', 'showNotMentioned', 'fabricatedEntry'];
// Stub / cut-off text: the page was blocked or only partly fetched.
const SHORT_TEXT_CHARS = 500;
const LIST_LIMIT = 5;

const isUnknownCritic = name => !String(name || '').trim() || /^unknown$/i.test(String(name).trim());

// ── What is due ──────────────────────────────────────────────────────────────

/** A check taken at the draft's current numbers in the last FRESH_HOURS is still good. */
function alreadyChecked(d, nowMs) {
  const v = d && d.verification;
  if (!v || !v.checkedAt || v.status === 'failed' || v.status === 'skipped') return false;
  if (v.score !== d.score || v.reviewCount !== d.reviewCount) return false;
  return (nowMs - Date.parse(v.checkedAt)) / 3600000 < FRESH_HOURS;
}

/**
 * Drafts to check before this run's emails: those due a 'new' or 'update'
 * email (reminders carry text the owner already has). `only` is the owner's
 * resend list: those drafts are checked whatever their email state.
 * Returns [{draft, kind}], at most `max`.
 */
function selectDueChecks(draftsFile, nowMs, { only = null, max = MAX_SHOWS_PER_RUN } = {}) {
  const due = only && only.length
    ? resendEmails(draftsFile, only).due
    : dueEmails(draftsFile, nowMs).filter(x => x.kind === 'new' || x.kind === 'update');
  // The cap bounds the unattended daily run; a list the owner named is checked in full.
  const cap = only && only.length ? Math.max(max, only.length) : max;
  const named = !!(only && only.length);
  return due.filter(x => named || !alreadyChecked(x.draft, nowMs)).slice(0, cap);
}

// ── Snapshots and what changed ───────────────────────────────────────────────

function compactRecord(r) {
  return {
    outlet: r.outlet || r.outletId || '',
    outletId: r.outletId || '',
    criticName: r.criticName || '',
    publishDate: r.publishDate || '',
    dateSource: r.dateSource || '',
    humanReviewedEarlyPublish: r.humanReviewedEarlyPublish === true,
    url: r.url || '',
    contentTier: r.contentTier || '',
    textLen: String(r.fullText || '').length,
    flags: FLAG_KEYS.filter(k => r[k]),
  };
}

/**
 * Compact view of a show's review-text files plus its _pending strand, keyed
 * by `<file>` and `_pending/<file>`. Unreadable files are skipped, never fatal.
 */
function snapshotShow(reviewTextsDir, showId) {
  const out = new Map();
  const read = (dir, prefix) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const f of names) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try { out.set(prefix + f, compactRecord(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))); } catch { /* skip */ }
    }
  };
  read(path.join(reviewTextsDir, showId), '');
  read(path.join(reviewTextsDir, '_pending', showId), '_pending/');
  return out;
}

/**
 * Diff two snapshots into the things worth telling the owner. A review file
 * that gets a critic name or a date is a metadata fix (it does not move the
 * count); a new file, recovered text or a cleared exclusion flag is something
 * the next rebuild and scoring pass has to pick up (`needsScoring`).
 */
function summarizeChanges(before, after) {
  const added = [];
  const named = [];
  const dated = [];
  const recovered = [];
  const flagCleared = [];
  let pendingAdded = 0;
  for (const [file, a] of after) {
    if (file.startsWith('_pending/')) { if (!before.has(file)) pendingAdded++; continue; }
    const b = before.get(file);
    if (!b) { added.push({ file, outlet: a.outlet, critic: a.criticName, url: a.url }); continue; }
    // unknown -> named, or the outlet's own name -> a person: any move onto a real name
    if (b.criticName !== a.criticName && !isUnknownCritic(a.criticName)) named.push({ file, outlet: a.outlet, from: b.criticName, to: a.criticName });
    if (!b.publishDate && a.publishDate) dated.push({ file, outlet: a.outlet, date: a.publishDate });
    if (b.textLen < SHORT_TEXT_CHARS && a.textLen >= SHORT_TEXT_CHARS) recovered.push({ file, outlet: a.outlet });
    const cleared = b.flags.filter(k => !a.flags.includes(k));
    if (cleared.length) flagCleared.push({ file, outlet: a.outlet, flags: cleared });
  }
  const pendingResolved = [...before.keys()].filter(f => f.startsWith('_pending/') && !after.has(f)).length;
  const needsScoring = added.length > 0 || recovered.length > 0 || flagCleared.length > 0;
  const changed = added.length + named.length + dated.length + recovered.length + flagCleared.length + pendingResolved + pendingAdded > 0;
  return { added, named, dated, recovered, flagCleared, pendingResolved, pendingAdded, needsScoring, changed };
}

// ── The census gaps that are left ────────────────────────────────────────────

const normUrl = u => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

/** The audit's census verdict for one show: { verdict, missing:[{outlet, url}] } or null. */
function censusFromAudit(audit, showId) {
  const row = audit && Array.isArray(audit.results) ? audit.results.find(r => r.showId === showId) : null;
  const cv = row && row.censusVerdict;
  if (!cv) return null;
  return {
    verdict: cv.verdict || 'unknown',
    missing: (cv.missing || []).map(m => ({ outlet: m.outlet || m.outletId || '', outletId: m.outletId || '', url: m.url || '' })),
  };
}

/**
 * Why each census-missing review is still not counted, in the owner's words.
 * `snapshot` is the show's files after the recovery tools ran. `ownerOf(url)`
 * (optional) names another show whose folder already holds that URL: one
 * article reviewing two shows is filed under only one of them (BRO-5924), so
 * it is "filed under another show", not "not found yet".
 */
function explainGaps(missing, snapshot, fixedFiles = new Set(), ownerOf = null, facts = null) {
  const { nonReviewPageReason } = require('./reddit-review-judge');
  const files = [...snapshot.entries()].filter(([f]) => !f.startsWith('_pending/'));
  const out = [];
  for (const m of missing) {
    const urlHit = files.find(([, r]) => normUrl(r.url) && normUrl(r.url) === normUrl(m.url));
    // A hub page, or a pre-opening feature we hold under that URL, is not a missing review (BRO-6634).
    if (nonReviewPageReason({ url: m.url }, null) || (urlHit && nonReviewPageReason(urlHit[1], facts))) continue;
    const hit = urlHit
      || files.find(([, r]) => m.outletId && r.outletId === m.outletId);
    const name = m.outlet || m.outletId || m.url;
    // Released or recovered by this very check: no longer a gap, it is "being scored".
    if (hit && fixedFiles.has(hit[0])) continue;
    if (!hit) {
      const owner = ownerOf && m.url ? ownerOf(m.url) : null;
      out.push({ outlet: name, reason: owner ? 'filed under another show (one article reviewing both)' : 'not found yet' });
      continue;
    }
    const r = hit[1];
    if (r.flags.length) out.push({ outlet: name, reason: `held back as ${r.flags.includes('wrongProduction') ? 'another production' : 'not a review'} (needs a look)` });
    else if (r.textLen < SHORT_TEXT_CHARS) out.push({ outlet: name, reason: 'page blocked, only part of the text came through' });
    else if (isUnknownCritic(r.criticName)) out.push({ outlet: name, reason: 'critic not named yet' });
    else out.push({ outlet: name, reason: 'we have it; the aggregator lists it under a different name' });
  }
  return out;
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * `git status --porcelain` lines from the review-texts checkout must stay
 * inside the folders of the shows checked so far in this run (and their
 * _pending folders; earlier shows' edits stay uncommitted until the push
 * step). Anything else means a tool wrote somewhere it should not have.
 */
function guardChangedPaths(showIds, porcelainLines) {
  const ids = [].concat(showIds);
  const ok = new RegExp(`^(${ids.map(escapeRe).join('|')}|_pending/(${ids.map(escapeRe).join('|')}))/`);
  const violations = [];
  for (const line of porcelainLines || []) {
    const p = String(line).slice(3).trim().replace(/^"|"$/g, '');
    if (!p) continue;
    // A rename shows as "old -> new": both ends must be inside.
    if (!p.split(' -> ').every(x => ok.test(x))) violations.push(p);
  }
  return { ok: violations.length === 0, violations };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── The record stored on the draft ───────────────────────────────────────────

/**
 * status: 'clean'   checked, nothing needed fixing, nothing missing
 *         'fixed'   we changed review data (maybe still being scored), nothing left missing
 *         'gaps'    reviews are still missing or held back after the tools ran
 *         'failed'  the check could not finish (reason in `error`)
 *         'skipped' report-only or switched off
 */
function buildVerification({ draft, nowIso, mode, snapshotBefore, snapshotAfter, census, error = null, durationMs = 0, tools = [], judge = null, previous = null, ownerOf = null, facts = null }) {
  const base = {
    checkedAt: nowIso, mode, score: draft.score, reviewCount: draft.reviewCount, durationMs, tools,
    ...(judge ? { judge: { asked: judge.asked, applied: judge.applied.length, rejected: judge.rejected.length, ...(judge.error ? { error: String(judge.error).slice(0, 200) } : {}) } } : {}),
  };
  // A failed or later check must not forget reviews an earlier check added that are still being scored.
  const carried = !!(previous && previous.pendingScoring);
  if (error) return { ...base, status: 'failed', error: String(error).slice(0, 300), pendingScoring: carried, addedThisCheck: false };
  const changes = summarizeChanges(snapshotBefore, snapshotAfter);
  const fixedFiles = new Set([...changes.added, ...changes.flagCleared, ...changes.recovered].map(x => x.file));
  const gaps = census ? explainGaps(census.missing, snapshotAfter, fixedFiles, ownerOf, facts) : [];
  const incomplete = !!census && census.verdict !== 'complete' && gaps.length > 0;
  const status = mode !== 'apply' ? 'skipped' : incomplete ? 'gaps' : changes.changed ? 'fixed' : 'clean';
  return {
    ...base,
    status,
    filesChecked: [...snapshotAfter.keys()].filter(f => !f.startsWith('_pending/')).length,
    // What the tools could not fix: said plainly so "checked" never reads as "all correct".
    // Only files the site counts: names and dates on excluded files (another production, news columns) change nothing posted.
    unnamedLeft: [...snapshotAfter.entries()].filter(([f, r]) => !f.startsWith('_pending/') && !r.flags.length && isUnknownCritic(r.criticName)).length,
    undatedLeft: [...snapshotAfter.entries()].filter(([f, r]) => !f.startsWith('_pending/') && !r.flags.length && !r.publishDate).length,
    pendingLeft: [...snapshotAfter.keys()].filter(f => f.startsWith('_pending/')).length,
    added: changes.added.map(x => ({ outlet: x.outlet })),
    named: changes.named.map(x => ({ outlet: x.outlet, name: x.to })),
    dated: changes.dated.map(x => ({ outlet: x.outlet })),
    recovered: changes.recovered.map(x => ({ outlet: x.outlet })),
    flagCleared: changes.flagCleared.map(x => ({ outlet: x.outlet })),
    pendingResolved: changes.pendingResolved,
    gaps,
    // Counts and the score only move after a rebuild and scoring pass: the
    // update email (BRO-5879) must fire on any count change, not just 3+.
    // pendingScoring stays on across checks until an update email goes out
    // (afterSend); addedThisCheck is what THIS check added, so an update that
    // follows this very check keeps the watch for those new reviews.
    addedThisCheck: mode === 'apply' && changes.needsScoring,
    pendingScoring: carried || (mode === 'apply' && changes.needsScoring),
    pushFailed: false,
  };
}

// ── What the email says ──────────────────────────────────────────────────────

const list = (items, fmt) => {
  const shown = items.slice(0, LIST_LIMIT).map(fmt);
  return shown.join(', ') + (items.length > LIST_LIMIT ? `, and ${items.length - LIST_LIMIT} more` : '');
};

/**
 * Plain-English lines for the "Reviews checked" note and an optional banner.
 * Returns null for a draft that was never checked (older drafts, check off).
 */
const NOTE_FRESH_HOURS = 36;

/**
 * Plain-English lines for the "Reviews checked" note and an optional banner.
 * Returns null for a draft that was never checked (older drafts, check off) and
 * for a note too old to describe today's draft. `d` (the draft) and `nowMs` let a
 * note that predates a number change drop the "numbers can move" line.
 */
function describeVerification(v, d = null, nowMs = Date.now()) {
  if (!v || !v.status) return null;
  if (v.status === 'skipped') return null;
  if (v.checkedAt && (nowMs - Date.parse(v.checkedAt)) / 3600000 > NOTE_FRESH_HOURS) return null;
  if (v.status === 'failed') {
    return { banner: 'The review check did not finish, so this draft may be missing reviews or have wrong names or dates.', lines: [] };
  }
  const lines = [];
  if (v.status === 'clean') lines.push(`Checked ${v.filesChecked} reviews against the aggregator lists. Nothing missing.`);
  if (v.added && v.added.length) lines.push(`Added ${v.added.length} missing review${v.added.length > 1 ? 's' : ''}: ${list(v.added, x => x.outlet)}.`);
  if (v.recovered && v.recovered.length) lines.push(`Recovered the full text for ${list(v.recovered, x => x.outlet)}.`);
  if (v.named && v.named.length) lines.push(`Named ${v.named.length} critic${v.named.length > 1 ? 's' : ''}: ${list(v.named, x => `${x.name} (${x.outlet})`)}.`);
  if (v.dated && v.dated.length) lines.push(`Filled in ${v.dated.length} missing date${v.dated.length > 1 ? 's' : ''}.`);
  if (v.flagCleared && v.flagCleared.length) lines.push(`Released ${list(v.flagCleared, x => x.outlet)} from a wrong flag.`);
  if (v.pushFailed) lines.push('I could not save these fixes to the review data, so they are not live yet. The hourly audit will find them again.');
  else if (v.pendingScoring && (!d || (v.score === d.score && v.reviewCount === d.reviewCount))) lines.push('Those are being scored now, so the score and review count above can move. An updated draft follows on its own when they land.');
  if (v.unnamedLeft || v.undatedLeft) {
    const bits = [];
    if (v.unnamedLeft) bits.push(`${v.unnamedLeft} without a critic name`);
    if (v.undatedLeft) bits.push(`${v.undatedLeft} without a date`);
    lines.push(`Still on file: ${bits.join(', ')}.`);
  }
  if (v.gaps && v.gaps.length) lines.push(`Still not counted: ${list(v.gaps, g => `${g.outlet} (${g.reason})`)}.`);
  return { banner: null, lines };
}

/**
 * The push of this run's review-texts failed: the fixes are not saved anywhere.
 * Marks the drafts checked in this run so the email does not say "being scored".
 * Returns the ids it changed.
 */
function markPushFailed(draftsFile, nowMs, withinHours = 4) {
  const changed = [];
  for (const [id, d] of Object.entries((draftsFile && draftsFile.drafts) || {})) {
    const v = d && d.verification;
    if (!v || v.mode !== 'apply' || !v.checkedAt || (nowMs - Date.parse(v.checkedAt)) / 3600000 > withinHours) continue;
    const touched = [v.added, v.named, v.dated, v.recovered, v.flagCleared].some(a => a && a.length);
    if (!touched || v.pushFailed) continue;
    d.verification = { ...v, pushFailed: true, pendingScoring: false, addedThisCheck: false };
    changed.push(id);
  }
  return changed;
}

module.exports = {
  MAX_SHOWS_PER_RUN, FRESH_HOURS, SHORT_TEXT_CHARS, FLAG_KEYS,
  alreadyChecked, selectDueChecks, snapshotShow, summarizeChanges,
  censusFromAudit, explainGaps, guardChangedPaths, buildVerification, describeVerification, markPushFailed,
};
