'use strict';
/**
 * gap-strategies.js — the IO side of each gap-recovery strategy (BRO-7171
 * Stage 2). Each fetcher returns either
 *   { ok: true, rawText, url, html, via }        a candidate text for the gate, or
 *   { ok: false, outcome, reason }               a ledger outcome (gap-recovery-ledger OUTCOMES).
 * Nothing here writes a review file: the driver sends every candidate through
 * gap-acceptance.recoverReviewTextVerified (lock, fresh read, gate, one write).
 *
 * Evidence vs non-evidence reuses failed-fetch-policy: a thrown fetch is
 * classified with classifyFetchFailure, and a reason in NON_EVIDENCE_REASONS
 * (budget_capped, soft_404, route cap, code_error) is non_evidence.
 */

const FREE_TIERS = Object.freeze(['cookies-plain', 'playwright-first', 'playwright-last']);

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function defaultDeps() {
  return {
    fetchPage: (url, opts) => require('./scraper').fetchPage(url, opts),
    extractArticleText: (html, host) => require('./article-extractor').extractArticleText(html, host),
    isNotFoundHtml: (html) => require('./soft-404-body').isNotFoundHtml(html),
    earliestCaptureTimestamp: (url, opts) => require('./fetch-archive-fallback').earliestCaptureTimestamp(url, opts),
    archiveSnapshotFetchUrl: (url, ts) => require('./archive-snapshot-url').archiveSnapshotFetchUrl(url, ts),
    fetchText: async (url) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    discoverCorrectUrl: (review, sb, opts) => require('./url-discovery').discoverCorrectUrl(review, sb, opts),
  };
}

/** Ledger outcome for a fetch that threw (failed-fetch-policy classification). */
function outcomeForFetchError(message) {
  const { classifyFetchFailure, isNonEvidenceFailure } = require('./failed-fetch-policy');
  const reason = classifyFetchFailure({ message });
  return { ok: false, outcome: isNonEvidenceFailure(reason) ? 'non_evidence' : 'no_evidence', reason };
}

/** Turn fetched HTML into a candidate, or the right refusal. */
function fromHtml(html, url, via, deps) {
  if (!html || typeof html !== 'string') return { ok: false, outcome: 'no_evidence', reason: 'fetch_error' };
  // A 200 "page not found" template says nothing about the article: soft_404 is non-evidence.
  if (deps.isNotFoundHtml(html)) return { ok: false, outcome: 'non_evidence', reason: 'soft_404' };
  const text = deps.extractArticleText(html, hostOf(url));
  if (!text) return { ok: false, outcome: 'rejected', reason: 'extractor_null' };
  return { ok: true, rawText: text, url, html, via };
}

/** Fetch `url` through the free fetchPage tiers only (no Bright Data / ScrapingBee). */
async function fetchFree(url, deps) {
  let res;
  try {
    res = await deps.fetchPage(url, { tiers: FREE_TIERS });
  } catch (e) {
    return outcomeForFetchError(e.message);
  }
  return fromHtml(res && res.content, url, `free:${(res && res.source) || '?'}`, deps);
}

async function refetchFree(c, deps = defaultDeps()) {
  if (!c.url) return { ok: false, outcome: 'non_evidence', reason: 'no_url' };
  const r = await fetchFree(c.url, deps);
  return r.ok ? { ...r, url: c.url } : r;
}

/** Earliest 200 Wayback capture of the stored url (pre-paywall copy). Free. */
async function archive(c, deps = defaultDeps()) {
  if (!c.url) return { ok: false, outcome: 'non_evidence', reason: 'no_url' };
  let cdxError = null;
  const ts = await deps.earliestCaptureTimestamp(c.url, { onError: (e) => { cdxError = e; } });
  if (!ts) {
    if (cdxError) return { ok: false, outcome: 'non_evidence', reason: `archive_unreachable: ${String(cdxError.message).slice(0, 80)}` };
    return { ok: false, outcome: 'no_evidence', reason: 'no_snapshot' };
  }
  const snap = deps.archiveSnapshotFetchUrl(c.url, ts);
  if (!snap) return { ok: false, outcome: 'non_evidence', reason: 'bad_snapshot_url' };
  let html;
  try { html = await deps.fetchText(snap); } catch (e) {
    return { ok: false, outcome: 'non_evidence', reason: `archive_unreachable: ${String(e.message).slice(0, 80)}` };
  }
  const r = fromHtml(html, c.url, `archive:${ts}`, deps);
  // The text is the stored url's article: the candidate url stays the original.
  return r.ok ? { ...r, url: c.url } : r;
}

/**
 * Subscriber browser. `session` comes from browser-outlet-adapters.openSession
 * (opened once per outlet per run, auth probe passed). A body that will not
 * extract re-runs the probe: a lost session is auth_failed, not evidence.
 */
async function browserSession(c, session) {
  if (!session) return { ok: false, outcome: 'browser_unavailable', reason: 'no_session' };
  let r;
  try { r = await session.extract(c.url); } catch (e) { r = { error: e.message }; }
  if (r && r.text) return { ok: true, rawText: r.text, url: c.url, html: r.html || '', via: 'browser' };
  if (session.probe) {
    const p = await session.probe().catch((e) => ({ error: e.message }));
    if (!p || p.error || !p.text) return { ok: false, outcome: 'auth_failed', reason: `session_lost: ${(p && p.error) || 'probe empty'}` };
  }
  return { ok: false, outcome: 'rejected', reason: /robot|denied|too many/i.test(String(r && r.error)) ? 'bot_check' : 'extractor_null' };
}

/**
 * SERP url rediscovery, then a free fetch of the hit. The url change is proven
 * (or refused) later by the acceptance gate's identity proof.
 * @returns candidate | refusal, plus `serpRan` (true when a live search ran, so
 *   the driver advances the file's serpRetryCount)
 */
async function urlRediscover(c, { scrapingBeeKey = '', brightDataKey = '' } = {}, deps = defaultDeps()) {
  if (!scrapingBeeKey && !brightDataKey) return { ok: false, outcome: 'non_evidence', reason: 'no_serp_key', serpRan: false };
  let found;
  try {
    found = await deps.discoverCorrectUrl(
      { showId: c.showId, outletId: c.outletId, outlet: c.outlet, url: c.url || '', criticName: c.criticName, source: c.source },
      scrapingBeeKey, { brightDataKey },
    );
  } catch (e) {
    return { ok: false, outcome: 'non_evidence', reason: `code_error: ${String(e.message).slice(0, 80)}`, serpRan: false };
  }
  if (found === '__SERP_UNAVAILABLE__') return { ok: false, outcome: 'non_evidence', reason: 'serp_unavailable', serpRan: false };
  if (!found) return { ok: false, outcome: 'no_evidence', reason: 'no_serp_match', serpRan: true };
  const newUrl = require('./scraper').unwrapRedirectUrl(typeof found === 'string' ? found : found.url);
  if (c.url && !require('./url-change-invariant').urlCanonicallyChanged(c.url, newUrl)) {
    return { ok: false, outcome: 'no_evidence', reason: 'serp_returned_same_url', serpRan: true };
  }
  const r = await fetchFree(newUrl, deps);
  if (!r.ok) return { ...r, url: newUrl, serpRan: true };
  return { ...r, url: newUrl, serpRan: true };
}

module.exports = { FREE_TIERS, refetchFree, archive, browserSession, urlRediscover, outcomeForFetchError, fromHtml, defaultDeps };
