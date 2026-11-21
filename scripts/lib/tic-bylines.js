'use strict';
/**
 * Pure planner for backfill-tic-bylines.js (BRO-6518): which review files should take
 * the critic theatreinchicago.com (TIC) lists for the same review.
 *
 * TIC is right where the page has no usable byline, but it has its own typos and
 * truncations ("Carey Sullivan", "Allie Bugajsk"), so it never replaces a real name
 * read off the page unless the page's name is a site-wide account or the article
 * text names TIC's critic and not the stored one. Joint bylines and hand-set names
 * are left alone. A review matches a TIC row only on the same site.
 */

const { JOINT_BYLINE_RE: JOINT_RE } = require('./ingest-url-line');
const GENERIC_SEGMENTS = new Set(['review', 'reviews', 'theatre-review', 'theater-review', 'index', 'amp']);

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// Some outlets moved their reviews (Third Coast Review → /stages/...), so a stored
// URL can be the redirect target of the listed one: fall back to the last path
// segment on the same site, when it is specific enough to identify one review.
function lastSegment(url) {
  let p;
  try { p = new URL(String(url)).pathname; } catch { return null; }
  const seg = p.split('/').filter(Boolean).pop() || '';
  if (seg.length < 12 || GENERIC_SEGMENTS.has(seg.toLowerCase())) return null;
  return seg.toLowerCase();
}

/** Whether the listed critic should replace the stored one. */
function shouldTakeListed({ stored, listed, text, siteWide, normalizeCritic, isSiteWideAuthorAccount = () => true }) {
  if (!listed || JOINT_RE.test(listed)) return false;
  const ls = normalizeCritic(listed);
  if (!ls || ls === 'unknown') return false;
  const ss = normalizeCritic(stored || '');
  if (ls === ss) return false;
  // "Written by", "Submitted by", "Paul's World": a scraped label, not a name.
  const { isPlausiblePersonName } = require('./byline-recovery');
  if (!ss || ss === 'unknown' || !isPlausiblePersonName(stored)) return true;
  if (siteWide && isSiteWideAuthorAccount(stored)) return true;
  const body = String(text || '').toLowerCase();
  const has = (name) => body.includes(String(name).toLowerCase());
  return has(listed) && !has(stored);
}

/**
 * @param files  [{ basename, data }] review files in one show dir
 * @param source [{ critic, url }] TIC reviews for the show
 * @param deps   { normalizeCritic, normalizeUrl, isSiteWideAuthorSource, isSiteWideAuthorAccount }
 * @returns { fixes: [{ basename, data, from, critic, dstBasename }], unmatched }
 */
function planTicBylineFixes(files, source, { normalizeCritic, normalizeUrl, isSiteWideAuthorSource, isSiteWideAuthorAccount }) {
  const byUrl = new Map(), bySeg = new Map();
  for (const s of source || []) {
    if (!s || !s.url || !s.critic) continue;
    const nu = normalizeUrl(s.url);
    const prev = byUrl.get(nu);
    byUrl.set(nu, prev === undefined ? s : (prev && prev.critic === s.critic ? prev : null)); // two critics on one URL → no match
    const seg = lastSegment(s.url), host = hostOf(s.url);
    if (!seg || !host) continue;
    const k = `${host}|${seg}`;
    bySeg.set(k, bySeg.has(k) ? null : s); // ambiguous on this site → no match
  }
  const fixes = [];
  let unmatched = 0;
  for (const { basename, data } of files) {
    if (!data || !data.url) continue;
    if (data.criticNameManual || data._locked === true) continue;
    let row = byUrl.get(normalizeUrl(data.url)) || null;
    if (row && hostOf(row.url) !== hostOf(data.url)) row = null;
    if (!row) { const seg = lastSegment(data.url), host = hostOf(data.url); row = seg && host ? bySeg.get(`${host}|${seg}`) : null; }
    if (!row) { unmatched++; continue; }
    const siteWide = isSiteWideAuthorSource({ url: data.url, outletId: data.outletId });
    if (!shouldTakeListed({ stored: data.criticName, listed: row.critic, text: data.fullText, siteWide, normalizeCritic, isSiteWideAuthorAccount })) continue;
    const outletPart = basename.split('--')[0];
    fixes.push({ basename, data, from: data.criticName || null, critic: row.critic, dstBasename: `${outletPart}--${normalizeCritic(row.critic)}.json` });
  }
  return { fixes, unmatched };
}

module.exports = { planTicBylineFixes, shouldTakeListed, lastSegment, hostOf };
