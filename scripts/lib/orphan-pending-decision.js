/**
 * Pure decision function for scripts/clean-orphan-pending.js.
 *
 * Extracted so tests can require() the real function (CLAUDE.md §15).
 * No filesystem access — takes data objects, returns a decision.
 *
 * Decision actions:
 *   'delete'  — pending file is cruft, remove it
 *   'promote' — pending has richer content than main; copy over and delete pending
 *               (only emitted when opts.allowPromote is true; otherwise 'keep' with
 *               a manual-review reason)
 *   'keep'    — preserve pending file (legitimate unenriched OR needs manual review)
 */

const CONTENT_TIER_RANK = {
  complete: 5,
  truncated: 4,
  excerpt: 3,
  stub: 2,
  invalid: 1,
};

function tierRank(tier) {
  return CONTENT_TIER_RANK[tier] ?? 0;
}

function normalizeUrlFragment(url) {
  if (!url || typeof url !== 'string') return null;
  // Strip query, trailing slash, lowercase. Intentionally NOT stripping path
  // segments — two files with /reviews/ vs /news/ but same article ID are
  // technically different paths and should be treated as distinct URLs here
  // (the content-fingerprint check below catches same-article-different-url).
  return url.split('?')[0].split('#')[0].toLowerCase().replace(/\/+$/, '');
}

/**
 * Two reviews likely cover the same underlying article if they share any of:
 *   - First 200 chars of fullText (dedup-worthy textual match)
 *   - Same trailing article ID in a Variety-style URL (1236726809)
 *   - Identical pullQuote (if both non-empty)
 */
function looksLikeSameArticle(pending, candidate) {
  const pa = (pending.fullText || '').slice(0, 200).trim();
  const ca = (candidate.fullText || '').slice(0, 200).trim();
  if (pa && ca && pa === ca) return true;

  const pq = (pending.pullQuote || '').trim();
  const cq = (candidate.pullQuote || '').trim();
  if (pq && cq && pq === cq) return true;

  // Variety/THR/Deadline trailing numeric article ID (6+ digits).
  const extractArticleId = (u) => {
    if (!u) return null;
    const m = String(u).match(/-(\d{6,})\/?$/);
    return m ? m[1] : null;
  };
  const pid = extractArticleId(pending.url);
  const cid = extractArticleId(candidate.url);
  if (pid && cid && pid === cid) return true;

  return false;
}

// Outlets with multiple staff critics who may file independent same-day reviews.
// Rule 3 (outlet-dup for fuzzy sources) is NOT permitted to auto-delete at these
// outlets — the pending file might be a legit second critic whose byline failed
// extraction. Content fingerprint must match before deletion.
const MULTI_CRITIC_OUTLETS = new Set([
  'nytimes',
  'nysr',
  'new-york-stage-review',
  'vulture',
  'theatrely',
  'variety',
  'nytg',
  'new-york-theatre-guide',
  'theatermania',
  'thewrap',
  'ew',
  'nyt-theater',
  'one-minute-critic',
]);

// Discovery sources that produce fuzzy URL matches and are the common strand-producer
// when byline extraction fails. Explicitly NOT including 'serp-discovery' — those
// files are expected to reach collect-review-texts AUTHOR ENRICHMENT and be promoted
// with a named critic later, so we don't treat them as disposable duplicates.
const FUZZY_SOURCES = new Set([
  'rss-discovery',
  'site-search',
  'bww-roundup',
]);

/**
 * @param {string} showId                 The show directory name
 * @param {Object} pendingData            Parsed JSON of the _pending file
 * @param {Array<{filename,data}>} mainFiles  Named-critic / other main-dir files
 * @param {{has: Function}} showsIndex    Set-like object (shows.json ID index)
 * @param {Object} opts                   { onlySynthetic, allowPromote }
 * @returns {{action, reason, target?}}   target is the main file for 'promote'
 */
function decide(showId, pendingData, mainFiles, showsIndex, opts = {}) {
  // Rule 1: show not in shows.json → synthetic test scaffold
  if (!showsIndex.has(showId)) {
    return { action: 'delete', reason: 'synthetic-test-show' };
  }

  if (opts.onlySynthetic) {
    return { action: 'keep', reason: 'not-synthetic (--only-synthetic mode)' };
  }

  const pendingUrl = normalizeUrlFragment(pendingData.url);
  const pendingOutlet = pendingData.outletId;
  const pendingTier = tierRank(pendingData.contentTier);

  // Rule 2: URL collision with a main file — compare content tier
  if (pendingUrl) {
    const urlMatch = mainFiles.find(m => {
      const mu = normalizeUrlFragment(m.data.url);
      return mu && mu === pendingUrl;
    });
    if (urlMatch) {
      const mainTier = tierRank(urlMatch.data.contentTier);
      if (pendingTier > mainTier) {
        if (opts.allowPromote) {
          return { action: 'promote', reason: `url-match: pending tier ${pendingData.contentTier} > main tier ${urlMatch.data.contentTier} (--allow-promote)`, target: urlMatch };
        }
        return { action: 'keep', reason: `url-match: pending has richer content than main (${pendingData.contentTier} > ${urlMatch.data.contentTier}) — manual review needed, re-run with --allow-promote to auto-promote` };
      }
      return { action: 'delete', reason: `url-match: main file ${urlMatch.filename} has same-or-better contentTier` };
    }
  }

  // Rule 3: Unknown-critic file from a fuzzy source at an outlet that already
  // has a named-critic main file. Multi-critic outlets (NYT, Variety, etc.)
  // require a content-fingerprint match before we're willing to delete —
  // otherwise we'd lose a legitimate second-critic review whose byline failed
  // extraction.
  if (pendingOutlet && FUZZY_SOURCES.has(pendingData.source)) {
    const criticName = (pendingData.criticName || '').toString().toLowerCase().trim();
    if (criticName === 'unknown' || !criticName) {
      const namedCritic = mainFiles.find(m => {
        if (m.data.outletId !== pendingOutlet) return false;
        const mc = (m.data.criticName || '').toString().toLowerCase().trim();
        return mc && mc !== 'unknown';
      });
      if (namedCritic) {
        // Preserve if pending has fullText that named file lacks — don't lose content
        const namedTier = tierRank(namedCritic.data.contentTier);
        if (pendingTier > namedTier && pendingData.fullText && !namedCritic.data.fullText) {
          return { action: 'keep', reason: `outlet-dup but pending has fullText that named file lacks — preserve for manual review` };
        }
        // Multi-critic outlets: demand content fingerprint match before delete.
        if (MULTI_CRITIC_OUTLETS.has(pendingOutlet)) {
          if (looksLikeSameArticle(pendingData, namedCritic.data)) {
            return { action: 'delete', reason: `outlet-dup (fuzzy ${pendingData.source}, multi-critic ${pendingOutlet}, article-fingerprint matches): ${namedCritic.filename}` };
          }
          // Fingerprint differs → possibly a second critic. DO NOT delete.
          return { action: 'keep', reason: `outlet-dup BUT multi-critic outlet ${pendingOutlet} + fingerprint differs from ${namedCritic.filename} — possible second critic, manual review needed` };
        }
        // Single-critic outlet: safe to delete
        return { action: 'delete', reason: `outlet-dup (fuzzy ${pendingData.source}): ${namedCritic.filename} exists with named critic` };
      }
    }
  }

  return { action: 'keep', reason: 'no-main-duplicate (legitimate unenriched)' };
}

module.exports = {
  decide,
  tierRank,
  normalizeUrlFragment,
  looksLikeSameArticle,
  MULTI_CRITIC_OUTLETS,
  FUZZY_SOURCES,
  CONTENT_TIER_RANK,
};
