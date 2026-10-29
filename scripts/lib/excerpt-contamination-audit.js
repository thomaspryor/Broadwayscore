/**
 * excerpt-contamination-audit.js — pure matching logic for
 * audit-cross-show-excerpt-contamination.js (BRO-461).
 *
 * BRO-115 found harry-potter-and-the-cursed-child-both-parts-west-end-2021/
 * london-theatre--unknown.json carrying a theStageExcerpt that was verbatim
 * Shadowlands content (wrong show entirely), byte-identical to the
 * wrongFullText already preserved on a sibling file that HAD been through the
 * fullText contentVerification LLM check. That check never runs on
 * excerpt-sourced fields (bwwExcerpt/dtliExcerpt/etc — see excerpt-fields.js),
 * so the same copy-into-wrong-show-dir failure mode is invisible to it.
 *
 * The detector here is deliberately simple: verbatim (post-normalization)
 * text duplication of a review's excerpt/fullText fields under a DIFFERENT
 * showId is itself the anomaly signal — a real, independently-written review
 * of Show A is never byte-identical to a real review of Show B. Near-miss
 * fuzzy matching is NOT attempted; the confirmed case (and the roundup
 * ingestion bug that causes this class) is exact-copy, not paraphrase.
 */

'use strict';

const { EXCERPT_FIELDS } = require('./excerpt-fields');
const { foldDiacritics } = require('./title-match');

// Below this normalized length, short matches are far more likely to be
// legitimate shared boilerplate (a pull-quote, a common turn of phrase) than
// genuine cross-attribution. Matches this short are still recorded for
// visibility but never auto-flagged.
const MIN_MATCH_LENGTH = 40;

// At this length, an exact cross-show text match is confident enough to
// surface as 'high' — matches audit-cross-attribution-by-critic.js's own
// judgment that longer content overlap is decisive.
const HIGH_CONFIDENCE_LENGTH = 80;

function normalizeExcerptText(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Strip year/market suffix so same-production revival-year collisions
 * (already owned by the URL-collision audit) can be told apart from genuine
 * cross-show contamination.
 */
function baseShowId(showId) {
  return String(showId || '')
    .replace(/-\d{4}$/, '')
    .replace(/-(?:off-)?(?:broadway|west-end|off-west-end)(?:-\d{4})?$/, '');
}

/**
 * True when two showIds are the same production filed under two slugs —
 * the exact "duplicate show entry" shape the real corpus run surfaced (e.g.
 * can-i-be-frank-off-broadway-2026 vs
 * morgan-bassichis-can-i-be-frank-off-broadway-2026). baseShowId() alone
 * only strips a trailing year/market suffix, so it misses this: one base is
 * a hyphen-bounded suffix of the other. That's a legitimate content match
 * (same real production, correctly reviewed), not cross-show contamination
 * — flagging it wrongShow would be actively wrong, not just noisy.
 */
function isDuplicateSlugPair(showIdA, showIdB) {
  const a = baseShowId(showIdA);
  const b = baseShowId(showIdB);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`-${b}`) || b.endsWith(`-${a}`);
}

/**
 * Extract {field, text} pairs worth indexing/matching from a review-text
 * record. fullText/wrongFullText are included so contamination is detected
 * against content already caught (and preserved) by the fullText
 * contentVerification path — exactly the shape of the confirmed case, where
 * the excerpt-only file's theStageExcerpt matched a sibling's wrongFullText.
 */
function extractIndexableFields(data) {
  const out = [];
  if (!data) return out;
  // Roundups/combined-reviews legitimately share content across multiple
  // show dirs by design (one article covering several shows) — matching
  // exact-attribution logic against them produces false positives.
  // audit-cross-attribution-by-critic.js excludes them for the same reason
  // (scripts/audit-cross-attribution-by-critic.js:334).
  if (data.isRoundupArticle || data.isCombinedReview) return out;
  for (const field of EXCERPT_FIELDS) {
    const val = data[field];
    if (typeof val === 'string' && val.trim()) out.push({ field, text: val });
  }
  if (typeof data.fullText === 'string' && data.fullText.trim()) {
    out.push({ field: 'fullText', text: data.fullText });
  }
  if (typeof data.wrongFullText === 'string' && data.wrongFullText.trim()) {
    out.push({ field: 'wrongFullText', text: data.wrongFullText });
  }
  return out;
}

// Matches a corroborating flag set because the content isn't a review of
// ANY show ("domain for sale" parked-page junk, ad spam, showNotMentioned) —
// as opposed to being identifiably a review of a DIFFERENT, specific show.
// Verified against the real corpus: enron-2010/equus-2008/la-bete-2010's
// shared new-jersey-newsroom files and ink-2019/be-more-chill-2019's shared
// theater-news-online files are both ad-spam/parked-domain junk that reached
// wrongProduction/wrongShow=true for exactly this "not a review" reason, not
// because the text was traced to a specific other production. Corroboration
// from a flag set for this reason doesn't establish genuine cross-show
// attribution — it just means BOTH copies are garbage.
const NOT_REVIEW_REASON_PATTERN = /not a review|domain (?:name )?for sale|no information about the show|does not mention the show|not about the show/i;

function isGarbageNotReviewCorroboration(entry) {
  if (entry.showNotMentioned) return true;
  const reason = `${entry.wrongShowReason || ''} ${entry.wrongProductionReason || ''}`;
  return NOT_REVIEW_REASON_PATTERN.test(reason);
}

function verdictTextOf(data) {
  const parts = [data.wrongShowReason, data.wrongProductionReason, data.rejectionReason, data.rejectionReasoning];
  if (data.contentVerification) {
    try { parts.push(JSON.stringify(data.contentVerification)); } catch { /* ignore */ }
  }
  return parts.filter((p) => typeof p === 'string' && p).join(' ').slice(0, 4000);
}

/**
 * Build an in-memory index: normalizedText -> [{showId, file, field,
 * wrongShow, wrongProduction, criticName}]. `records` is an iterable of
 * {showId, file, data}.
 */
function buildExcerptIndex(records) {
  const index = new Map();
  for (const { showId, file, data } of records) {
    for (const { field, text } of extractIndexableFields(data)) {
      const norm = normalizeExcerptText(text);
      if (norm.length < MIN_MATCH_LENGTH) continue;
      let bucket = index.get(norm);
      if (!bucket) { bucket = []; index.set(norm, bucket); }
      bucket.push({
        showId,
        file,
        field,
        wrongShow: !!data.wrongShow,
        wrongProduction: !!data.wrongProduction,
        showNotMentioned: !!data.showNotMentioned,
        wrongShowReason: data.wrongShowReason || null,
        wrongProductionReason: data.wrongProductionReason || null,
        criticName: data.criticName || null,
        // BRO-4159: why the matched record's text was judged wrong. If that
        // reason names the TARGET show, the text is the target's own review.
        verdictText: verdictTextOf(data),
      });
    }
  }
  return index;
}

/**
 * For a single target file's excerpt/fullText fields, find cross-show
 * matches recorded in `index`. Returns one entry per (targetField,
 * indexEntry) pair whose showId differs from targetShowId.
 */
function findCrossShowMatches(targetShowId, targetFile, data, index, { titles = [] } = {}) {
  const matches = [];
  for (const { field, text } of extractIndexableFields(data)) {
    const norm = normalizeExcerptText(text);
    if (norm.length < MIN_MATCH_LENGTH) continue;
    const bucket = index.get(norm);
    if (!bucket) continue;
    for (const entry of bucket) {
      if (entry.showId === targetShowId) continue;
      matches.push({
        targetField: field,
        matchedShowId: entry.showId,
        matchedFile: entry.file,
        matchedField: entry.field,
        matchedWrongShow: entry.wrongShow,
        matchedWrongProduction: entry.wrongProduction,
        matchedCriticName: entry.criticName,
        matchLength: norm.length,
        sameBase: isDuplicateSlugPair(entry.showId, targetShowId),
        confidence: norm.length >= HIGH_CONFIDENCE_LENGTH ? 'high' : 'medium',
        isGarbageNotReview: isGarbageNotReviewCorroboration(entry),
        excerpt: text.slice(0, 300),
        matchedVerdictText: entry.verdictText || '',
      });
      const m = matches[matches.length - 1];
      m.targetOwnsText = targetOwnsMatchedText(m, targetShowId, titles, text);
    }
  }
  return matches;
}

/**
 * Conservative auto-flag gate: only exact matches of substantial length,
 * against a genuinely different production (not a duplicate-slug pair or a
 * same-title revival-year collision — those are legitimate content matches,
 * not contamination; the revival case is the existing URL-collision audit's
 * job), corroborated by the matched entry's field being `wrongFullText`
 * specifically. wrongFullText is ONLY populated when the fullText
 * contentVerification LLM check has already verified THIS EXACT text is
 * wrong-show content (see excerpt-fields.js/scorable-text.js) — that's a
 * much stronger, more specific signal than a bare wrongProduction/wrongShow
 * boolean, which could be true for a reason unrelated to the matched text
 * (e.g. a different field on the same file was flagged). Requiring the
 * corroborating field itself ties the flag to verified-wrong CONTENT, not
 * just a flagged FILE, closing the coincidental-boilerplate-match risk a
 * bare boolean check would leave open. This is exactly the confirmed BRO-115
 * case's shape: the "unknown" excerpt-only file's theStageExcerpt matched a
 * sibling's wrongFullText, AND that sibling has wrongProduction/wrongShow
 * set. wrongFullText alone is NOT sufficient corroboration — it can also
 * hold plain scraper-quality garbage (ad/parked-domain junk) with no
 * wrongProduction/wrongShow flag at all (verified against the real corpus:
 * enron-2010 and equus-2008's new-jersey-newsroom files both carry the
 * identical ad-spam wrongFullText with wrongProduction/wrongShow undefined —
 * that's showNotMentioned/partial_text scraper failure, not cross-show
 * content, and flagging it wrongShow would be wrong). Both signals are
 * required together. Matches without that corroboration still get reported
 * but require manual verification before flagging (per BRO-461's acceptance
 * criteria on false positives).
 */
function phraseOf(s) {
  return ` ${foldDiacritics(String(s || '').normalize('NFKC')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * Title phrases that identify a show: its id with year/market stripped
 * (hyphens as spaces), the same without a leading "the", and any titles the
 * caller knows (shows.json). Phrases under 4 chars are dropped as too generic.
 */
function targetShowPhrases(showId, titles = []) {
  const base = baseShowId(showId).replace(/-/g, ' ');
  const out = new Set();
  for (const t of [showId.replace(/-/g, ' '), base, base.replace(/^the /, ''), ...titles]) {
    const p = phraseOf(t).trim();
    if (p.length >= 4) out.add(p);
    const noThe = p.replace(/^the /, '');
    if (noThe.length >= 4) out.add(noThe);
  }
  return [...out];
}

/**
 * BRO-4159 (review finding): another show's wrongFullText can be the TARGET
 * show's real review (HP's quarantined copy of a Shadowlands review vs the
 * Shadowlands file's own excerpt). Flagging the target then removes a genuine
 * review. True when the matched record's verdict (wrongShowReason etc.) names
 * the target show, or the matched text itself names the target's title: the
 * match is then left for manual review, never auto-flagged.
 */
function targetOwnsMatchedText(match, targetShowId, titles = [], fullText = '') {
  const hay = phraseOf(`${match.matchedVerdictText || ''} ${fullText || match.excerpt || ''}`);
  const idHay = String(match.matchedVerdictText || '').toLowerCase();
  if (idHay.includes(String(targetShowId).toLowerCase())) return true;
  return targetShowPhrases(targetShowId, titles).some((p) => hay.includes(` ${p} `));
}

/**
 * BRO-5622: a match found through the TARGET record's own wrongFullText says
 * nothing about the text that scores it. wrongFullText is already quarantined
 * (never scored), so junk-vs-junk collisions (parked-domain pages, site
 * chrome copied into dozens of records) land here. On the 2026-10-29 corpus
 * run every one of the 28 auto-flag-eligible rows fired this way and none
 * through an excerpt, and 61 of the 148 scored, unflagged manual-review rows
 * matched only through it. Such matches are reported, never flagged.
 */
function isQuarantinedTargetMatch(match) {
  return !!match && match.targetField === 'wrongFullText';
}

function shouldAutoFlag(match) {
  return (
    match.confidence === 'high' &&
    !isQuarantinedTargetMatch(match) &&
    !match.sameBase &&
    match.matchedField === 'wrongFullText' &&
    (match.matchedWrongProduction || match.matchedWrongShow) &&
    !match.isGarbageNotReview &&
    // BRO-4159: the quarantined text may be the target show's own review.
    !match.targetOwnsText
  );
}

/**
 * True when a record is STILL excerpt-only per BRO-115's own definition
 * (excerpt-backfill-eligibility.js): no fullText at all. A record that has
 * since been re-collected with real fullText already runs through the
 * fullText contentVerification LLM check on every enrich-reviews.yml pass —
 * that's the standing safety net BRO-461 exists because excerpt-only records
 * DON'T get. Matching a re-collected record's now-vestigial excerpt fields
 * (left over from before the re-collection) produces false positives: the
 * excerpt field can carry stale wrong-show text while fullText — the text
 * actually driving the current score — is a genuine, correct review.
 */
function stillExcerptOnly(data) {
  return !(data && data.fullText && data.fullText.trim());
}

/**
 * Underscore dirs (_pending, _superseded-misattributed) are holding areas, not
 * shows: a superseded copy "matches" its own original under another id and
 * would surface as cross-show noise (13 such rows on the 2026-10-18 run).
 */
function isAuditableShowDir(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('_');
}

/**
 * BRO-4159: which files the audit checks. BRO-461 shipped with a fixed
 * 259-file backlog list as the only target (a list that lived on one Mac), so
 * contamination outside it (the Book of Mormon West End Guardian row filled
 * from Brigadoon's WestEndTheatre.com roundup) was never looked at. The
 * default is now the whole corpus; --list and --file narrow it.
 *   files: explicit "<show>/<file>.json" targets (wins when non-empty)
 *   list:  backlog lines (used when given and no files)
 *   else:  every record in the corpus, sorted for a stable report
 */
function selectAuditTargets(records, { files = [], list = null } = {}) {
  if (files && files.length > 0) return { mode: 'files', targets: [...files] };
  if (Array.isArray(list)) return { mode: 'list', targets: [...list] };
  const targets = records.map((r) => `${r.showId}/${r.file}`).sort();
  return { mode: 'corpus', targets };
}

/**
 * One review-field-edit action (execute-approved-fix.js) that sets wrongShow
 * on a file whose excerpt matched verified wrong-show text under another
 * show. Data changes go through approved-fix plans, never a direct --apply on
 * the shared review-texts repo from a worker.
 */
function buildWrongShowFlagAction(rel, match, oldValue = null) {
  return {
    type: 'review-field-edit',
    file: rel,
    field: 'wrongShow',
    oldValue: oldValue === undefined ? null : oldValue,
    newValue: true,
    description: `BRO-4159 cross-show excerpt audit: ${match.targetField} (${match.matchLength} chars) is verbatim the text ${match.matchedShowId}/${match.matchedFile} holds as ${match.matchedField}, already verified wrong-show content (matched file wrongShow=${!!match.matchedWrongShow}, wrongProduction=${!!match.matchedWrongProduction}).`,
  };
}

/**
 * Turn the audit's auto-flag-eligible rows ({rel, match}) into pending-fix
 * plans, chunked to the executor's action cap. Returns [{name, plan}] where
 * name is the data/pending-fixes file basename (bro-4159, bro-4159-b, ...).
 */
// execute-approved-fix.js accepts plan ids matching this (ISSUE_NUMBER check).
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]*$/i;

/** Part 0 is the issue id itself; later parts are <issue>-p2, -p3, ... (no 26-part ceiling). */
function planName(issue, i) {
  if (!PLAN_ID_RE.test(String(issue))) throw new Error(`invalid plan issue id: ${issue}`);
  return i === 0 ? String(issue) : `${issue}-p${i + 1}`;
}

function buildFlagPlans(eligible, { issue = 'bro-4159', maxActions = 25, createdAt = new Date().toISOString(), makeId } = {}) {
  const rows = [...eligible].sort((a, b) => a.rel.localeCompare(b.rel));
  const chunks = [];
  for (let i = 0; i < rows.length; i += maxActions) chunks.push(rows.slice(i, i + maxActions));
  return chunks.map((chunk, i) => {
    const name = planName(issue, i);
    const shows = [...new Set(chunk.map((r) => r.match.matchedShowId))];
    return {
      name,
      plan: {
        issueNumber: name,
        planId: makeId ? makeId(name) : null,
        status: 'pending',
        createdAt,
        submitter: { name: null, email: null },
        plan: {
          summary: `${String(issue).toUpperCase()} (part ${i + 1} of ${chunks.length}): flag wrongShow on ${chunk.length} excerpt-only review(s) whose excerpt text is verbatim content already verified as wrong-show elsewhere (audit-cross-show-excerpt-contamination.js corpus-wide run, shouldAutoFlag bar). Matched against: ${shows.slice(0, 8).join(', ')}${shows.length > 8 ? ', ...' : ''}.`,
          steps: chunk.map((r) => `Flag ${r.rel} wrongShow (matches ${r.match.matchedShowId}/${r.match.matchedFile}).`),
          riskLevel: 'Low',
          actions: chunk.map((r) => buildWrongShowFlagAction(r.rel, r.match, r.oldValue ?? null)),
        },
      },
    };
  });
}

module.exports = {
  PLAN_ID_RE,
  planName,
  targetShowPhrases,
  targetOwnsMatchedText,
  isAuditableShowDir,
  selectAuditTargets,
  buildWrongShowFlagAction,
  buildFlagPlans,
  MIN_MATCH_LENGTH,
  HIGH_CONFIDENCE_LENGTH,
  normalizeExcerptText,
  baseShowId,
  isDuplicateSlugPair,
  isGarbageNotReviewCorroboration,
  extractIndexableFields,
  buildExcerptIndex,
  findCrossShowMatches,
  shouldAutoFlag,
  isQuarantinedTargetMatch,
  stillExcerptOnly,
};
