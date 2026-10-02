/**
 * outlet-mismatch-heal.js — rebuild-all-reviews.js's stale outlet-mismatch
 * cleanup (filename outlet prefix vs JSON outletId), shared with
 * scripts/heal-outlet-mismatch.js.
 *
 * Two gaps in that pass (2026-09-29):
 *
 *  1. URL edition ignored. A writer that derives outletId from the outlet
 *     NAME (sweep-we-aggregators.js writeReview, before this fix) filed a
 *     timeout.com/london review as outletId "timeout" (Time Out New York).
 *     The cleanup only compared filename vs JSON outletId, so nothing ever
 *     looked at the URL, and a rename alone would be undone next rebuild:
 *     the rename target is computed from the JSON outletId, and the scorer
 *     keeps reading the wrong tier from it. urlEditionCorrection() returns
 *     the path-split edition's outletId/outlet so the cleanup rewrites the
 *     JSON first, then lets the rename/merge proceed on it.
 *
 *  2. Flagged tombstones. mergeUniqueReviewFields refuses an exclusion-flagged
 *     source ('skip-flagged-source'), so a misnamed excluded file sat next to
 *     its correctly-named sibling forever. flaggedTombstoneDecision() allows
 *     deleting it ONLY when nothing can be lost (see its doc).
 *
 * Renames go through safeRenameReview (moves the llm-score sidecar) and
 * repoint every sibling pointer at the old name (ship-check 2026-09-29: a raw
 * rename of the-cherry-orchard-2016/the-answer-is--cherry-orchard.json broke
 * timeout--david-cote.json's duplicateTextOf).
 */

const path = require('path');
const {
  resolveOutletFromUrlIfPathInformed,
  normalizeOutlet,
  getOutletDisplayName,
} = require('./review-normalization');
const { hasOperatorAssertion, isTransferableField } = require('./merge-review-fields');
const { hasHumanAssertedFlag } = require('./contradicted-flag-basis');

/**
 * If the file's URL is on a declared path-split edition host (timeout.com
 * /london vs /newyork) and disagrees with outletId, return the correction;
 * null otherwise. _locked files are left alone (the write guard would refuse
 * the rewrite anyway, turning it into an error every rebuild).
 * @returns {{ outletId: string, outlet: string, from: string|null } | null}
 */
function urlEditionCorrection(data) {
  if (!data || typeof data.url !== 'string' || !data.url || data._locked) return null;
  const resolved = resolveOutletFromUrlIfPathInformed(data.url);
  if (!resolved || !resolved.outletId) return null;
  const current = normalizeOutlet(data.outletId || data.outlet || '');
  if (current === resolved.outletId) return null;
  return {
    outletId: resolved.outletId,
    outlet: getOutletDisplayName(resolved.outletId) || resolved.displayName || resolved.outletId,
    from: data.outletId || null,
  };
}

// Legitimate cross-publication relations (BRO-4402): the file's outlet
// publishes on the URL owner's host on purpose, so the URL is NOT evidence of
// a misfiling. Keys are the FILE's outletId; values the host-owner outlets it
// may legitimately sit on.
const CROSS_PUBLICATION_ALLOW = {
  observer: ['guardian'],            // Observer reviews live on theguardian.com
  'the-sun': ['times-uk'],           // News UK sister titles
  'sunday-times': ['times-uk'],
  'slash-film': ['film-festival-traveler'], // same critic, both sites
  'film-festival-traveler': ['slash-film'],
  'sunday-telegraph': ['telegraph'],
  'sunday-express': ['express-uk'],
  'daily-pilot': ['latimes'],        // LA Times community paper, hosted on latimes.com
  nippertown: ['the-daily-gazette'], // section of the Daily Gazette site
  'st-petersburg-times': ['tampa-bay-times'], // same paper, renamed
};
// Hosts that archive OTHER papers' reviews under the archive's own domain.
const ARCHIVE_HOSTS = new Set(['jasonraize.com', 'jasonraize.net']);
// Flags meaning "this is not this show's review at all": the fix is the
// wrongProduction/wrongShow/roundup flag, never a rename onto the host owner.
const NOT_A_REVIEW_FLAGS = ['wrongProduction', 'wrongShow', 'isRoundupArticle'];
const MIN_CRITIC_OUTLET_REVIEWS = 3;

const compactId = (id) => String(id || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

let _criticRegistry;
function criticOutletCount(criticName, outletId) {
  if (_criticRegistry === undefined) {
    try {
      _criticRegistry = JSON.parse(require('fs').readFileSync(path.join(__dirname, '../../data/critic-registry.json'), 'utf8')).critics || {};
    } catch { _criticRegistry = {}; }
  }
  const slug = String(criticName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const c = _criticRegistry[slug];
  return (c && c.outletCounts && c.outletCounts[outletId]) || 0;
}

/**
 * A review whose URL is on ANOTHER registry outlet's own domain is filed under
 * the wrong outletId (e.g. Brantley's theater.nytimes.com review under
 * about-entertainment, T3 0.35 instead of nytimes T1 1.0). Returns the
 * correction to the host owner, or null. Never corrects:
 *  - _locked / operator-asserted, rejected and pointer-marked duplicate files;
 *  - wrongProduction / wrongShow / roundup-flagged files (wrong flag, not rename);
 *  - a URL the current outlet itself owns (domain/domainAliases, wire services,
 *    edition pairs — isCrossOutletUrl), allow-listed sister/syndication pairs,
 *    archive hosts, aggregator hosts, or registry-duplicate ids of one outlet;
 *  - a critic with an established record at the CURRENT outlet and none at the
 *    host owner (the URL is then the wrong field, not the outlet).
 * @returns {{ outletId: string, outlet: string, from: string|null } | null}
 */
function publisherDomainCorrection(data, { ignoreDuplicateOf = false, ignoreRejection = false } = {}) {
  if (!data || typeof data.url !== 'string' || !data.url || data._locked) return null;
  if (NOT_A_REVIEW_FLAGS.some((k) => data[k])) return null;
  // A script's own duplicateClearReason breadcrumb (e.g. "audit-duplicate-of-url-mismatch.js")
  // matches the operator-text pattern but records only a pointer edit.
  if (carriesOperatorAssertion(ignoreDuplicateOf ? withoutScriptBreadcrumb(data) : data)) return null;
  // Already a pointer-marked duplicate of another file: excluded from scoring,
  // and relabelling it would only detach it from the file it duplicates.
  // BRO-4411: misfileHealPlan() opts in for a duplicateOf whose target is
  // itself excluded, where "excluded" leaves the source to be recovered live.
  if ((data.duplicateOf && !ignoreDuplicateOf) || data.duplicateTextOf || data.crossOutletDuplicate) return null;
  // Explicitly rejected (not_a_review, ...): excluded for its own reason, not
  // because of the outlet label, so a relabel changes nothing but a filename.
  if ((data.rejectedAt || data.rejectionReason) && !ignoreRejection) return null;
  const current = normalizeOutlet(data.outletId || data.outlet || '');
  if (!current) return null;
  let host;
  try { host = new URL(data.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
  if ([...ARCHIVE_HOSTS].some((h) => host === h || host.endsWith('.' + h))) return null;
  // News portals (AP copy on news.yahoo.com) never name the publisher (BRO-4502).
  if (require('./review-normalization').isSyndicationPortalHost(host)) return null;
  const { isCrossOutletUrl, resolveOutletFromUrl } = require('./review-normalization');
  if (!isCrossOutletUrl(current, data.url)) return null;
  const owner = resolveOutletFromUrl(data.url);
  if (!owner || !owner.outletId || owner.outletId === current) return null;
  if (compactId(owner.outletId) === compactId(current)) return null; // registry duplicate ids
  if ((CROSS_PUBLICATION_ALLOW[current] || []).includes(owner.outletId)) return null;
  const { AGGREGATOR_OUTLET_IDS } = require('./aggregator-domains');
  if (AGGREGATOR_OUTLET_IDS && AGGREGATOR_OUTLET_IDS.has && AGGREGATOR_OUTLET_IDS.has(owner.outletId)) return null;
  const atOwner = criticOutletCount(data.criticName, owner.outletId);
  const atCurrent = criticOutletCount(data.criticName, current);
  if (atOwner < MIN_CRITIC_OUTLET_REVIEWS && atCurrent >= MIN_CRITIC_OUTLET_REVIEWS) return null;
  return {
    outletId: owner.outletId,
    outlet: getOutletDisplayName(owner.outletId) || owner.displayName || owner.outletId,
    from: data.outletId || null,
    reason: 'publisher-domain',
  };
}


/** Strip a duplicateClearReason written by a script ("x-y.js ..." / "BRO-N: ...") — it records a pointer edit, not a human decision. */
function withoutScriptBreadcrumb(data) {
  const v = data && data.duplicateClearReason;
  if (typeof v !== 'string' || !/^([\w.-]+\.js\b|BRO-\d+:)/.test(v.trim())) return data;
  const { duplicateClearReason: _b, ...rest } = data;
  return rest;
}

const alnum = (t) => (typeof t === 'string' ? t.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '') : '');

/** True when `source`'s text adds nothing to `target`: empty, or contained (ignoring punctuation/whitespace, e.g. "-" vs "--", a URL prefix). */
function textCovered(source, target) {
  const a = alnum(source && source.fullText);
  if (!a) return true;
  const b = alnum(target && target.fullText);
  if (b.includes(a)) return true;
  // Same article, different extraction (photo captions, boilerplate): >=90% of
  // the misfile's 40-char windows, sampled every 40, appear in the target.
  if (a.length < 400) return false;
  let hit = 0, n = 0;
  for (let i = 0; i + 40 <= a.length; i += 40, n++) if (b.includes(a.slice(i, i + 40))) hit++;
  // The conclusion (verdict) must survive too: the sampled windows skip the tail.
  return n > 0 && hit / n >= 0.9 && b.includes(a.slice(-60));
}

/**
 * BRO-4411: a publisher-domain misfile that the standard relabel skips but the
 * rebuild still scores under the WRONG outlet (15 NYT reviews live as "About
 * Entertainment"). Returns a plan, or null (file left for the normal path).
 *
 *  - 'cycle': the misfile is a duplicateOf an EXCLUDED file, and that file's
 *    only exclusion is a stale isSyndicatedDuplicate pointing back at the
 *    misfile (detect-syndicated-duplicates picked the misfile as "primary").
 *    Neither scores by rule, so the rebuild recovers the misfile. Fix: keep the
 *    correctly-filed target, clear its stale mark, fold the misfile into it.
 *  - 'cycle-swap': as 'cycle', but the misfile carries the fuller extraction of the
 *    article (target holds paywall boilerplate): the target is replaced by the
 *    relabelled misfile instead, via the excluded-target swap.
 *  - 'drop-pointer': the duplicateOf target is excluded for its own reason and
 *    is not the corrected file; the pointer is dropped and the file relabelled.
 *  - 'twin': no pointer; a stale rejection marker on the misfile (explainExclusion
 *    says it scores today) and a live, same-article file already at the
 *    corrected name: two live rows for one article. The misfile is deleted.
 * Every kind needs: same article (sameArticlePath), no operator assertion or
 * wrongShow on either side (a script's own duplicateClearReason breadcrumb about
 * the pointer being resolved is not an assertion), the misfile's text covered by
 * the target's, and no score/excerpt data the target lacks.
 * @returns {{ kind: string, fix: object, stripped: object, ptr: string, target: object, cleared?: object } | null}
 */
function misfileHealPlan({ data, file, io, explain }) {
  if (!data || data.duplicateTextOf || data.crossOutletDuplicate) return null;
  const hasPtr = !!data.duplicateOf;
  const stale = !hasPtr && !!(data.rejectedAt || data.rejectionReason) && !explain(data, file);
  if (!hasPtr && !stale) return null;
  const fix = publisherDomainCorrection(data, { ignoreDuplicateOf: true, ignoreRejection: true });
  if (!fix) return null;
  const stripped = { ...data };
  delete stripped.duplicateOf;
  delete stripped.duplicateReason;
  if (carriesOperatorAssertion(withoutScriptBreadcrumb(stripped))) return null;
  const { generateReviewFilename } = require('./review-normalization');
  const expected = generateReviewFilename(fix.outletId, data.criticName || 'Unknown');
  const ptr = hasPtr ? data.duplicateOf : expected;
  if (typeof ptr !== 'string' || ptr.includes('/') || !io.exists(ptr)) return null;
  const target = io.read(ptr);
  if (carriesOperatorAssertion(target) || target.wrongShow || !sameArticlePath(data.url, target.url)) return null;
  const targetWhy = explain(target, ptr);
  if (!hasPtr) { // twin
    if (targetWhy || uniqueScoreDataFields(stripped, target).length || !textCovered(stripped, target)) return null;
    return { kind: 'twin', fix, stripped, ptr, target };
  }
  if (!targetWhy) return null; // target scores: an ordinary duplicate, leave alone
  if (expected !== ptr) {
    if (explain(stripped, file)) return null;
    return { kind: 'drop-pointer', fix, stripped, ptr, target };
  }
  const primary = typeof target.syndicatedPrimaryFile === 'string' ? path.basename(target.syndicatedPrimaryFile) : null;
  if (target.isSyndicatedDuplicate !== true || primary !== file) return null;
  const covered = textCovered(stripped, target) && !uniqueScoreDataFields(stripped, target).length;
  // Different extractions of the same article (paywall boilerplate vs body): keep the fuller one.
  const fuller = !covered && !explain(stripped, file) && alnum(stripped.fullText).length > alnum(target.fullText).length;
  if (!covered && !fuller) return null;
  // The misfile may itself be excluded (rejected as garbage): it is being deleted, not scored.
  if (explain(stripped, file) && !(stripped.rejectedAt || stripped.rejectionReason)) return null;
  // false/null, not delete: the write guard's merge mode restores any key
  // the incoming write leaves undefined.
  const cleared = { ...target, isSyndicatedDuplicate: false, syndicatedPrimaryFile: null, syndicationSimilarity: null };
  if (explain(cleared, ptr)) return null; // still excluded for another reason: nothing to gain
  return { kind: covered ? 'cycle' : 'cycle-swap', fix, stripped, ptr, target, cleared };
}

/** Apply the URL-edition or publisher-domain correction in place; returns it or null. */
function applyUrlEditionCorrection(data, today = new Date().toISOString().slice(0, 10), opts = {}) {
  const fix = urlEditionCorrection(data) ? { ...urlEditionCorrection(data), reason: 'url-edition' } : publisherDomainCorrection(data, opts);
  if (!fix) return null;
  data.outletIdCorrectedFrom = fix.from;
  data.outletIdCorrectedReason = `${fix.reason}: ${data.url} resolves to ${fix.outletId} (${today})`;
  data.outletId = fix.outletId;
  data.outlet = fix.outlet;
  return fix;
}

/** Same article on the same publisher, ignoring host prefix (theater. vs www.), scheme and query. */
function sameArticlePath(a, b) {
  try {
    const { resolveOutletFromUrl } = require('./review-normalization');
    const A = new URL(a), B = new URL(b);
    const ra = resolveOutletFromUrl(a), rb = resolveOutletFromUrl(b);
    if (!ra || !rb || ra.outletId !== rb.outletId) return false;
    const p = (u) => u.pathname.replace(/\/+$/, '');
    return p(A).length > 1 && p(A) === p(B);
  } catch { return false; }
}

/**
 * Publisher-domain relabel whose correctly-labelled file already exists but is
 * EXCLUDED (garbage/truncated text, wrongProduction, a duplicate stub of this
 * very file) while the misfiled source is a live copy of the same article: the
 * merge path would fold the live source into the excluded stub and delete it,
 * losing the review. Replace the stub with the relabelled source instead.
 * Never when either side carries an operator assertion or the stub is wrongShow.
 */
function excludedTargetSwapAllowed({ source, target, sourceExcluded, targetExcluded, otherPointersAtTarget = 0 }) {
  if (sourceExcluded || !targetExcluded || otherPointersAtTarget) return false;
  if (carriesOperatorAssertion(source) || carriesOperatorAssertion(target)) return false;
  if (target.wrongShow) return false;
  return sameArticlePath(source.url, target.url);
}

function sameReviewUrl(a, b) {
  const { canonicalizeUrlForDedup } = require('./review-guards');
  const norm = (u) => canonicalizeUrlForDedup(u).replace(/^https?:\/\/(www\.)?/, '');
  const na = norm(a);
  return !!na && na === norm(b);
}

const OPERATOR_TEXT = /^\s*(manual|human|audit)/i;

/**
 * Broader than merge-review-fields' hasOperatorAssertion: also any
 * *Override / *ManualClear, any manual* / human* field, _locked, or a
 * reason/note/provenance/by string an operator wrote (manual-*, human-*,
 * audit-*). Deleting a file carrying any of these silently discards a human
 * decision, so the tombstone rule keeps it.
 */
function carriesOperatorAssertion(data) {
  if (!data) return false;
  if (hasOperatorAssertion(data) || hasHumanAssertedFlag(data)) return true;
  if (data._locked) return true;
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === false || v === '') continue;
    if (/(Override|ManualClear)$/.test(k)) return true;
    if (/^(manual|human)/i.test(k)) return true;
    if (/(Reason|Note|Provenance|By|Source|Detail)$/i.test(k)) {
      const vals = Array.isArray(v) ? v : [v];
      if (vals.some((x) => typeof x === 'string' && OPERATOR_TEXT.test(x))) return true;
    }
  }
  return false;
}

/**
 * Sibling files whose duplicate pointers reference `sourceFile`.
 * @param {string} sourceFile
 * @param {Array<{file: string, data: object}>} siblings  other files in the show dir
 */
function siblingsPointingAt(sourceFile, siblings) {
  return siblings.filter(({ file, data }) => file !== sourceFile && data && (
    data.duplicateOf === sourceFile ||
    data.duplicateTextOf === sourceFile ||
    (data.crossOutletDuplicate === true && typeof data.crossOutletPrimaryFile === 'string' &&
      path.basename(data.crossOutletPrimaryFile) === sourceFile)
  ));
}

// Score / excerpt data. An EXCLUDED source's score or excerpt may be the very
// thing that is contaminated, so it never moves onto the target; a source that
// holds such data the target lacks is kept instead (re-review 2026-09-29).
const SCORE_DATA_KEY = /^(llmScore|ensembleData|assignedScore|adjudicatedScore|originalScore.*|excerpt|.*Excerpt.*|.*Stars.*|aggregatorStars.*|bucket.*|.*Bucket|thumb.*|.*Thumb.*|.*Score)$/i;
// Pure provenance that may move: urls, discovery source, timestamps.
const PROVENANCE_KEY = /^(url|.*Url|.*Urls|source|discoverySource|urlDiscoveryMethod|.*DiscoveredAt|.*At|publishDate|.*Date)$/;

/** Score/excerpt keys the source holds (non-null) that the target lacks. */
function uniqueScoreDataFields(source, target) {
  return Object.keys(source || {}).filter((k) => SCORE_DATA_KEY.test(k) && source[k] != null && target[k] == null);
}

/** Provenance fields the source holds that the target lacks — the only fields a tombstone hands over. */
function uniqueTransferableFields(source, target) {
  const out = {};
  for (const [k, v] of Object.entries(source || {})) {
    // _-prefixed keys are bookkeeping about THAT file (_mergedInto, _scoreNote…).
    if (!isTransferableField(k) || v == null || k.startsWith('_')) continue;
    if (SCORE_DATA_KEY.test(k) || !PROVENANCE_KEY.test(k)) continue;
    if (target[k] == null) out[k] = v;
  }
  return out;
}

const normText = (t) => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '');

/**
 * May the rebuild delete a misnamed, exclusion-flagged source whose
 * correctly-named target already exists? Only when nothing can be lost:
 *  - the target is excluded TODAY (explainExclusion, which honours the
 *    stale-flag exceptions isExclusionFlagged ignores), for the same URL;
 *  - the source is excluded today and carries no operator assertion;
 *  - the source's fullText is empty or identical to the target's;
 *  - the source holds no score/excerpt data the target lacks (an excluded
 *    file's score or excerpt may be the contaminated thing — never moved);
 *  - folding its unique provenance (urls, discovery source, timestamps —
 *    returned as `transfer`) into the target still leaves the target excluded;
 *  - the target does not point at the source (other pointers get repointed).
 *
 * @param {object} p
 * @param {object} p.source            parsed source JSON
 * @param {object} p.target            parsed target JSON
 * @param {string} p.sourceFile        source basename
 * @param {string} p.targetFile        target basename
 * @param {Array<{file: string, data: object}>} p.siblings  every other file in the dir
 * @param {(data: object, file: string) => string|null} p.explain  explainExclusion bound to the show dir
 * @returns {{ delete: boolean, reason: string, repoint: Array<{file: string, data: object}>, transfer: object }}
 */
function flaggedTombstoneDecision({ source, target, sourceFile, targetFile, siblings, explain }) {
  const keep = (reason) => ({ delete: false, reason, repoint: [], transfer: {} });
  if (!explain(target, targetFile)) return keep('target-not-excluded');
  if (!sameReviewUrl(source && source.url, target && target.url)) return keep('different-url');
  if (!explain(source, sourceFile)) return keep('source-not-excluded');
  if (carriesOperatorAssertion(source)) return keep('source-operator-assertion');
  const srcText = normText(source.fullText);
  if (srcText && srcText !== normText(target.fullText)) return keep('source-unique-fulltext');
  const pointing = siblingsPointingAt(sourceFile, siblings || []);
  if (pointing.some((s) => s.file === targetFile)) return keep('target-points-at-source');
  if (uniqueScoreDataFields(source, target).length) return keep('source-has-unique-score-data');
  const transfer = uniqueTransferableFields(source, target);
  if (Object.keys(transfer).length && !explain({ ...target, ...transfer }, targetFile)) {
    return keep('merge-would-include-target');
  }
  return { delete: true, reason: 'flagged-tombstone-same-url', repoint: pointing, transfer };
}

/**
 * Repoint duplicateOf / duplicateTextOf / crossOutletPrimaryFile from
 * fromFile to toFile, in place on each sibling's data. Returns changed files.
 */
function repointSiblingRefs(pointing, fromFile, toFile, showId, why = 'renamed') {
  const changed = [];
  for (const s of pointing) {
    const d = s.data;
    if (d.duplicateOf === fromFile) d.duplicateOf = toFile;
    if (d.duplicateTextOf === fromFile) d.duplicateTextOf = toFile;
    if (d.crossOutletDuplicate === true && typeof d.crossOutletPrimaryFile === 'string' &&
        path.basename(d.crossOutletPrimaryFile) === fromFile) {
      d.crossOutletPrimaryFile = showId ? `${showId}/${toFile}` : toFile;
    }
    d.duplicateRepointReason = `repointed: ${fromFile} ${why} ${toFile}`;
    changed.push(s.file);
  }
  return changed;
}

/**
 * File I/O for one show dir. Apply mode goes through the write guard
 * (writeReviewOrThrow; safeRenameReview, which also moves the llm-score
 * sidecar). Dry-run keeps an in-memory overlay so later steps of the same run
 * see the simulated writes/renames/deletes, and the plan equals the apply.
 */
function makeDirIO(sDir, dryRun) {
  const fs = require('fs');
  const { writeReviewOrThrow, safeRenameReview } = require('./review-write-guard');
  const { cascadeClearDuplicateRefs } = require('./cascade-clear-duplicate-refs');
  const { BLOCKLIST_FILENAME } = require('./poller-blocklist');
  const virt = dryRun ? new Map() : null; // filename -> data, or null once deleted
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const isReview = (x) => x.endsWith('.json') && x !== BLOCKLIST_FILENAME;
  const io = {
    list() {
      const set = new Set(fs.readdirSync(sDir).filter(isReview));
      if (virt) for (const [f, d] of virt) { if (d === null) set.delete(f); else set.add(f); }
      return [...set].sort();
    },
    exists: (f) => (virt && virt.has(f) ? virt.get(f) !== null : fs.existsSync(path.join(sDir, f))),
    read: (f) => (virt && virt.has(f) ? clone(virt.get(f)) : JSON.parse(fs.readFileSync(path.join(sDir, f), 'utf8'))),
    write(f, d) {
      if (virt) virt.set(f, clone(d));
      else writeReviewOrThrow(path.join(sDir, f), d);
    },
    rename(f, g, d) {
      if (io.exists(g)) throw new Error(`rename target ${g} exists — source kept`);
      if (virt) { virt.set(g, clone(d)); virt.set(f, null); return; }
      const r = safeRenameReview(path.join(sDir, f), path.join(sDir, g), { newData: d });
      if (!r || !r.wrote) {
        const err = new Error(`rename ${f} -> ${g} did not land (${(r && r.skipped) || 'no result'}) — source kept`);
        if (r && r.skipped === 'locked') err.code = 'LOCKED';
        throw err;
      }
    },
    unlink(f) {
      if (virt) { virt.set(f, null); return; }
      cascadeClearDuplicateRefs(sDir, f);
      fs.unlinkSync(path.join(sDir, f));
    },
    siblings(except) {
      const out = [];
      for (const x of io.list()) {
        if (x === except) continue;
        try { out.push({ file: x, data: io.read(x) }); } catch { /* unreadable sibling: skip */ }
      }
      return out;
    },
  };
  return io;
}

/**
 * Rename a review file and repoint every sibling pointer at the old name, so
 * a rename never leaves a broken duplicateOf/duplicateTextOf/
 * crossOutletPrimaryFile (validate-review-texts broken_duplicate_ref) or an
 * orphaned llm-score sidecar. Returns the repointed sibling filenames.
 */
function renameAndRepoint(io, fromFile, toFile, data, showId) {
  // Collected BEFORE the rename: safeRenameReview's sister-store update
  // repoints some pointers itself, and the report must not depend on that.
  const pointing = siblingsPointingAt(fromFile, io.siblings(fromFile)).map((s) => s.file);
  io.rename(fromFile, toFile, data);
  for (const file of pointing) {
    const fresh = [{ file, data: io.read(file) }];
    if (!siblingsPointingAt(fromFile, fresh).length) continue; // already repointed by the rename
    repointSiblingRefs(fresh, fromFile, toFile, showId, 'renamed to');
    io.write(file, fresh[0].data);
  }
  return pointing;
}

/**
 * The rebuild's stale outlet-mismatch pass: when a file's outlet prefix
 * doesn't match the outletId in its JSON, rename it, or merge it into the
 * correctly-named file and delete it. URL edition is applied to the JSON
 * first; flagged tombstones are deleted per flaggedTombstoneDecision.
 * BLOCKLIST_FILENAME is skipped (BRO-1011: it is not a review and would
 * otherwise be renamed to unknown--unknown.json).
 *
 * @param {object} p
 * @param {string} p.reviewTextsDir
 * @param {string[]} p.showDirs
 * @param {Object<string, object>} p.showById  for explainExclusion
 * @param {boolean} [p.dryRun]  simulate in memory; the reported plan equals what an apply does
 * @param {(msg: string) => void} [p.log]
 * @param {Function} [p.explainFn]  explainExclusion(data, show, filePath) override (tests)
 */
function runOutletMismatchCleanup({ reviewTextsDir, showDirs, showById = {}, dryRun = false, log = console.log, explainFn = null }) {
  const { generateReviewFilename } = require('./review-normalization');
  const { mergeUniqueReviewFields } = require('./merge-review-fields');
  const { explainExclusion } = require('./review-guards');
  const out = {
    renamedCount: 0, mergedCount: 0, errorCount: 0, skippedFlaggedCount: 0, skippedLockedCount: 0,
    editionFixedCount: 0, tombstoneDeletedCount: 0, actions: [], kept: {},
  };
  const act = (msg) => { out.actions.push(msg); log(`  [outlet-mismatch]${dryRun ? ' (dry-run)' : ''} ${msg}`); };
  const keep = (reason, ref) => { out.skippedFlaggedCount++; (out.kept[reason] = out.kept[reason] || []).push(ref); };

  for (const sid of showDirs) {
    const sDir = path.join(reviewTextsDir, sid);
    const io = makeDirIO(sDir, dryRun);
    const explain = (data, file) => (explainFn || explainExclusion)(data, showById[sid], path.join(sDir, file));
    for (const f of io.list()) {
      try {
        if (!io.exists(f)) continue; // renamed/deleted earlier in this pass
        const fileOutlet = f.split('--')[0];
        let d = io.read(f);
        const plan = misfileHealPlan({ data: d, file: f, io, explain });
        if (plan) d = { ...plan.stripped, ...(plan.kind === 'twin' ? {} : { duplicateClearReason: `BRO-4411: publisher-domain misfile; ${plan.ptr} is excluded (${plan.kind})` }) };
        const editionFix = applyUrlEditionCorrection(d, undefined, plan ? { ignoreDuplicateOf: true, ignoreRejection: true } : {});
        // A publisher-domain relabel is only persisted once the rename/merge
        // it needs lands (BRO-4402): a kept tombstone must stay untouched, not
        // become a mislabelled file that re-reports every run.
        const deferWrite = !!editionFix && editionFix.reason === 'publisher-domain';
        const announceFix = () => {
          out.editionFixedCount++;
          act(`${sid}/${f}: outletId ${editionFix.from} -> ${editionFix.outletId} (${editionFix.reason})`);
        };
        if (editionFix && !deferWrite) { io.write(f, d); announceFix(); }
        const jsonOutlet = normalizeOutlet(d.outletId || d.outlet);
        if (!jsonOutlet || !fileOutlet || jsonOutlet === fileOutlet) {
          if (deferWrite) { io.write(f, d); announceFix(); }
          continue;
        }
        const expectedFilename = generateReviewFilename(jsonOutlet, d.criticName || 'Unknown');
        if (expectedFilename === f) { if (deferWrite) { io.write(f, d); announceFix(); } continue; }
        if (!io.exists(expectedFilename)) {
          const repointed = renameAndRepoint(io, f, expectedFilename, d, sid);
          if (deferWrite) announceFix();
          out.renamedCount++;
          act(`${sid}/${f}: renamed -> ${expectedFilename}${repointed.length ? `; repointed ${repointed.join(', ')}` : ''}`);
          continue;
        }
        // Named file exists — merge unique fields, delete stale. An
        // exclusion-flagged source never folds into its target (totoro
        // contamination, Notion 39b637c5-416f-815e); it is deleted only as a
        // same-URL tombstone of an equally excluded target.
        const existingData = io.read(expectedFilename);
        if (plan && plan.kind === 'cycle-swap' && expectedFilename === plan.ptr) {
          if (siblingsPointingAt(expectedFilename, io.siblings(expectedFilename)).some((x) => x.file !== f)) {
            keep('misfile-target-has-other-pointers', `${sid}/${f}`); continue;
          }
          // The swap deletes the target: first carry over every field it holds that
          // the fuller copy lacks (aggregator excerpts, urls, provenance).
          for (const [k, v] of Object.entries(existingData)) {
            if (d[k] == null && v != null && !k.startsWith('_') && !/^(isSyndicatedDuplicate|syndicat|duplicate)/.test(k) && isTransferableField(k)) d[k] = v;
          }
          io.unlink(expectedFilename);
          try {
            renameAndRepoint(io, f, expectedFilename, d, sid);
          } catch (e) {
            io.write(expectedFilename, existingData); // restore the target; nothing lost
            throw e;
          }
          announceFix();
          out.renamedCount++;
          act(`${sid}/${f}: replaced ${expectedFilename} (stale syndication mark, shorter text) with relabelled fuller copy`);
          continue;
        }
        if (plan && (plan.kind === 'cycle' || plan.kind === 'twin') && expectedFilename === plan.ptr) {
          // Keep the correctly-filed file (its text/score), fold the misfile's
          // unique provenance in, clear the stale syndication mark ('cycle').
          // One scored row, no double count.
          const tgt = plan.kind === 'cycle' ? plan.cleared : existingData;
          if (plan.kind === 'cycle') tgt.syndicationClearedReason = `BRO-4411: stale isSyndicatedDuplicate of misfiled ${f}`;
          Object.assign(tgt, uniqueTransferableFields(d, tgt));
          if (explain(tgt, expectedFilename)) { keep('misfile-target-still-excluded', `${sid}/${f}`); continue; }
          const pointing = siblingsPointingAt(f, io.siblings(f)).filter((x) => x.file !== expectedFilename);
          repointSiblingRefs(pointing, f, expectedFilename, sid, 'merged into');
          io.write(expectedFilename, tgt);
          for (const s of pointing) io.write(s.file, s.data);
          io.unlink(f);
          announceFix();
          out.mergedCount++;
          act(`${sid}/${f}: misfiled ${plan.kind} folded into ${expectedFilename} and deleted`);
          continue;
        }
        if (deferWrite && excludedTargetSwapAllowed({
          source: d, target: existingData,
          sourceExcluded: !!explain(d, f), targetExcluded: !!explain(existingData, expectedFilename),
          // Siblings (other than the source) that treat the stub as their primary
          // would be un-flagged by the unlink's cascade clear: refuse then.
          otherPointersAtTarget: siblingsPointingAt(expectedFilename, io.siblings(expectedFilename)).filter((x) => x.file !== f).length,
        })) {
          io.unlink(expectedFilename);
          try {
            renameAndRepoint(io, f, expectedFilename, d, sid);
          } catch (e) {
            io.write(expectedFilename, existingData); // restore the stub; nothing lost
            throw e;
          }
          announceFix();
          out.renamedCount++;
          act(`${sid}/${f}: replaced excluded ${expectedFilename} with relabelled live copy`);
          continue;
        }
        const mergeResult = mergeUniqueReviewFields(existingData, d);
        if (mergeResult.action === 'skip-flagged-source') {
          const decide = () => flaggedTombstoneDecision({
            source: io.read(f), target: io.read(expectedFilename), sourceFile: f, targetFile: expectedFilename,
            siblings: io.siblings(f), explain,
          });
          const decision = decide();
          if (!decision.delete) { keep(decision.reason, `${sid}/${f}`); continue; }
          // Re-validate on a fresh read BEFORE any write, so a failed recheck
          // leaves nothing partial: same verdict, same transfer, same repoints.
          const recheck = decide();
          const sig = (x) => JSON.stringify([x.delete, x.transfer, x.repoint.map(s => s.file)]);
          if (sig(recheck) !== sig(decision)) { keep('revalidation-failed', `${sid}/${f}`); continue; }
          const moved = Object.keys(recheck.transfer);
          if (moved.length) io.write(expectedFilename, { ...io.read(expectedFilename), ...recheck.transfer });
          repointSiblingRefs(recheck.repoint, f, expectedFilename, sid, 'deleted as flagged tombstone of');
          for (const s of recheck.repoint) io.write(s.file, s.data);
          io.unlink(f);
          if (deferWrite) announceFix();
          out.tombstoneDeletedCount++;
          act(`${sid}/${f}: deleted flagged tombstone (same URL as excluded ${expectedFilename})`
            + `${moved.length ? `; moved ${moved.join(',')}` : ''}`
            + `${decision.repoint.length ? `; repointed ${decision.repoint.map(s => s.file).join(', ')}` : ''}`);
          continue;
        }
        if (mergeResult.action !== 'merged') { keep(mergeResult.action, `${sid}/${f}`); continue; }
        if (mergeResult.changed) io.write(expectedFilename, existingData);
        io.unlink(f);
        if (deferWrite) announceFix();
        out.mergedCount++;
        act(`${sid}/${f}: merged into ${expectedFilename} and deleted`);
      } catch (e) {
        // A _locked file refusing the rename is a decision, not a failure —
        // counted on its own so the summary surfaces it.
        if (e.code === 'LOCKED') { out.skippedLockedCount++; (out.kept.locked = out.kept.locked || []).push(`${sid}/${f}`); continue; }
        out.errorCount++;
        console.warn(`  [outlet-mismatch] Error processing ${sid}/${f}: ${e.message}`);
      }
    }
  }
  return out;
}

module.exports = {
  runOutletMismatchCleanup,
  renameAndRepoint,
  makeDirIO,
  urlEditionCorrection,
  publisherDomainCorrection,
  misfileHealPlan,
  excludedTargetSwapAllowed,
  sameArticlePath,
  applyUrlEditionCorrection,
  sameReviewUrl,
  carriesOperatorAssertion,
  siblingsPointingAt,
  uniqueTransferableFields,
  uniqueScoreDataFields,
  flaggedTombstoneDecision,
  repointSiblingRefs,
};
