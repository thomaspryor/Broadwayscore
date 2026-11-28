/**
 * BRO-7162 F01: dedupe for opening-night discovery by ARTICLE identity first.
 *
 * Before: `fs.existsSync(outlet--unknown.json)` vetoed every later URL from that outlet before the page
 * could reveal its byline, so the second review of a show from one outlet (two Everything Theatre reviews of
 * one Off-West End show, both headline-nameless) was dropped without a fetch.
 *
 * Now: a URL already on disk is a duplicate; a NAMED critic already in the slot is a duplicate (identity
 * confirmed); an UNKNOWN-critic slot proves nothing about a different URL, so the caller prefetches the byline
 * and re-asks with the resolved name via {@link decideAfterPrefetch}.
 */
const fs = require('fs');
const path = require('path');

const urlKey = (u) => String(u || '').toLowerCase().replace(/\/+$/, '');

function readDir(showDir) {
  try { return fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); } catch { return []; }
}

/** Find a file whose stored url is this url, or the file occupying the outlet+critic slot. */
function scanShowDir(showDir, { url, canonicalOutletId, criticName }, norm) {
  const files = readDir(showDir);
  const criticSlug = norm.normalizeCritic(criticName);
  let urlOwner = null;
  let slotFile = null;
  let slotUrl = null;
  for (const f of files) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch { /* unreadable: filename still counts for the slot */ }
    if (!urlOwner && data && data.url && urlKey(data.url) === urlKey(url)) urlOwner = f;
    const m = f.match(/^(.+?)--(.+)\.json$/);
    if (!slotFile && m && norm.normalizeOutlet(m[1]) === canonicalOutletId && m[2] === criticSlug) {
      slotFile = f;
      slotUrl = data && data.url ? data.url : null;
    }
  }
  return { urlOwner, slotFile, slotUrl, criticSlug };
}

/**
 * First-pass decision, before any fetch.
 * @returns {{action:'skip', reason:string, file:string}|{action:'prefetch-byline', slotFile:string}|{action:'proceed'}}
 */
function decideBeforePrefetch(showDir, input, norm) {
  const s = scanShowDir(showDir, input, norm);
  if (s.urlOwner) return { action: 'skip', reason: 'url-dupe', file: s.urlOwner };
  if (s.slotFile) {
    if (s.criticSlug !== 'unknown') return { action: 'skip', reason: 'slot-dupe', file: s.slotFile };
    return { action: 'prefetch-byline', slotFile: s.slotFile };
  }
  return { action: 'proceed' };
}

/**
 * Second-pass decision with the byline the prefetch resolved.
 * @returns {{action:'skip', reason:string, file:string}|{action:'proceed'}|{action:'unresolved-collision', slotFile:string}}
 */
function decideAfterPrefetch(showDir, input, resolvedCriticName, norm, unknownSlotFile = null) {
  const s = scanShowDir(showDir, { ...input, criticName: resolvedCriticName }, norm);
  if (s.urlOwner) return { action: 'skip', reason: 'url-dupe', file: s.urlOwner };
  if (!s.slotFile) {
    // A named byline with no named file yet, but the outlet's "--unknown" slot holds a DIFFERENT url: the writer's
    // merge matcher lets a named critic claim an unknown-critic file, so proceeding would fold this article into
    // that one. Surface it instead (ship-check 2026-11-08).
    if (unknownSlotFile && s.criticSlug !== 'unknown') return { action: 'unresolved-collision', slotFile: unknownSlotFile };
    return { action: 'proceed' };
  }
  if (s.criticSlug !== 'unknown') return { action: 'skip', reason: 'slot-dupe', file: s.slotFile };
  // Still no byline and the unknown slot holds a DIFFERENT url: the writer would merge this url into that
  // file. Surface it loudly instead of silently dropping or clobbering.
  return { action: 'unresolved-collision', slotFile: s.slotFile };
}

module.exports = { decideBeforePrefetch, decideAfterPrefetch };
