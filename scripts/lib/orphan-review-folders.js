'use strict';
/**
 * Orphan review-text folders (BRO-4317).
 *
 * rebuild-all-reviews.js skips any data/review-texts/<dir> whose name is not a
 * shows.json id ("show dir not in shows.json"), so every review in such a
 * folder silently never reaches the site. fix-orphan-show-ids.js could not see
 * them because it reads reviews.json, which is built AFTER that skip. This
 * module scans the folders themselves, and proposes a home for each file by
 * publish date against each candidate production's run window (never by URL,
 * CLAUDE.md §3).
 */
const fs = require('fs');
const path = require('path');
const { stripIdSuffix } = require('./market-slug');

const DAY = 86400000;
// Window around a run: reviews of previews land before opening, late reviews after closing.
const BEFORE_OPENING_DAYS = 45;
const AFTER_CLOSING_DAYS = 30;

/** Folder names that are not show folders (repo plumbing). */
function isShowFolderName(name) {
  return !!name && !name.startsWith('.') && !name.startsWith('_');
}

/**
 * List folders under reviewTextsDir whose name is not in showIds, with their .json file names.
 * @returns {{ folder: string, files: string[] }[]}
 */
function findOrphanReviewFolders(reviewTextsDir, showIds) {
  const known = showIds instanceof Set ? showIds : new Set(showIds);
  if (!fs.existsSync(reviewTextsDir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(reviewTextsDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !isShowFolderName(ent.name) || known.has(ent.name)) continue;
    const files = fs.readdirSync(path.join(reviewTextsDir, ent.name))
      .filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json')
      .sort();
    out.push({ folder: ent.name, files });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

function toMs(d) {
  if (!d || typeof d !== 'string') return null;
  const t = Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d);
  return Number.isFinite(t) ? t : null;
}

/** Base used to pair a folder with shows: id minus market/year suffixes, minus a leading "the-". */
function baseKey(id) {
  return stripIdSuffix(String(id || '')).replace(/-(?:bway|broadway|tour)$/, '').replace(/^the-/, '');
}

function slugTitle(title) {
  return String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .replace(/^the-/, '');
}

/** Same id or slug base: the folder is this show's id with a market/year suffix changed or dropped. */
function isExactCandidate(folder, show) {
  const fb = baseKey(folder);
  return !!fb && (baseKey(show.id) === fb || (!!show.slug && baseKey(show.slug) === fb));
}

/**
 * Shows that could own a folder: same id base, same slug base (exact, see
 * isExactCandidate), or a title whose slug, its part before a colon, or a
 * subtitle-free prefix equals the folder base (loose: needs a human look).
 */
function candidateShows(folder, shows) {
  const fb = baseKey(folder);
  if (!fb) return [];
  return shows.filter((s) => {
    if (isExactCandidate(folder, s)) return true;
    const t = slugTitle(s.title);
    if (t === fb) return true;
    const head = slugTitle(String(s.title || '').split(/[:(]/)[0]);
    if (head && head === fb) return true;
    // "doubt-a-parable" folder vs "Doubt" title: folder base starts with the full title slug plus a subtitle.
    return !!t && t.length >= 4 && fb.startsWith(`${t}-`) && fb.split('-').length - t.split('-').length <= 3;
  });
}

function runWindow(show, nowMs = Date.now()) {
  const start = toMs(show.previewsStartDate) ?? toMs(show.openingDate);
  const open = toMs(show.openingDate) ?? start;
  if (open == null) return null;
  const from = Math.min(start ?? open, open - BEFORE_OPENING_DAYS * DAY);
  const close = toMs(show.closingDate);
  const to = (close ?? Math.max(nowMs, open)) + AFTER_CLOSING_DAYS * DAY;
  return { from, to };
}

function inWindow(dateMs, show, nowMs) {
  const w = runWindow(show, nowMs);
  return !!w && dateMs != null && dateMs >= w.from && dateMs <= w.to;
}

function normalizeUrl(u) {
  return String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/[?#].*$/, '').replace(/\/+$/, '');
}

module.exports = {
  findOrphanReviewFolders,
  candidateShows,
  isExactCandidate,
  runWindow,
  inWindow,
  baseKey,
  normalizeUrl,
  toMs,
  BEFORE_OPENING_DAYS,
  AFTER_CLOSING_DAYS,
};
