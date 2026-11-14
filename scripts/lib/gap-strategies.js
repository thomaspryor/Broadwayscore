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
    listCaptureTimestamps: (url, opts) => require('./fetch-archive-fallback').listCaptureTimestamps(url, opts),
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

// Distinct captures tried per review (earliest first). Each costs one free
// archive.org fetch; 4 keeps a night's ARCHIVE work bounded.
const ARCHIVE_MAX_CAPTURES = 4;

/**
 * Earliest usable 200 Wayback capture of the stored url (pre-paywall copy). Free.
 * Three distinct failure outcomes (revised plan item 5):
 *   archive_unavailable  CDX or every snapshot fetch failed      -> non_evidence
 *   archive_empty        no 200 capture exists                   -> no_evidence
 *   archive_thin_copy /  captures exist but each one is a teaser,
 *   extractor_null       404 template or unextractable            -> rejected
 * A capture whose text is under archiveCopyDisposition's 1,000-char bar
 * (BRO-5874) is a teaser, not the review: skip it and try the next one.
 */
async function archive(c, deps = defaultDeps()) {
  if (!c.url) return { ok: false, outcome: 'non_evidence', reason: 'no_url' };
  let cdxError = null;
  const list = deps.listCaptureTimestamps
    ? await deps.listCaptureTimestamps(c.url, { limit: ARCHIVE_MAX_CAPTURES, onError: (e) => { cdxError = e; } })
    : [];
  if (!list.length) {
    if (cdxError) return { ok: false, outcome: 'non_evidence', reason: `archive_unavailable: ${String(cdxError.message).slice(0, 80)}` };
    return { ok: false, outcome: 'no_evidence', reason: 'archive_empty' };
  }
  const { archiveCopyDisposition } = require('./fetch-archive-fallback');
  let fetchedAny = false;
  let lastFetchError = null;
  let lastRefusal = null;
  let evidenceRefusal = null;
  for (const ts of list) {
    const snap = deps.archiveSnapshotFetchUrl(c.url, ts);
    if (!snap) continue;
    let html;
    try { html = await deps.fetchText(snap); } catch (e) { lastFetchError = e; continue; }
    fetchedAny = true;
    const r = fromHtml(html, c.url, `archive:${ts}`, deps);
    if (!r.ok) { lastRefusal = r; if (r.outcome === 'rejected' && !evidenceRefusal) evidenceRefusal = r; continue; }
    const disp = archiveCopyDisposition({ viaArchive: false, explicitSnapshot: true, stubOnFailure: false, textLength: r.rawText.length });
    if (disp !== 'ok') { evidenceRefusal = { ok: false, outcome: 'rejected', reason: 'archive_thin_copy' }; continue; }
    // The text is the stored url's article: the candidate url stays the original.
    return { ...r, url: c.url };
  }
  if (!fetchedAny) {
    return { ok: false, outcome: 'non_evidence', reason: `archive_unavailable: ${String((lastFetchError && lastFetchError.message) || 'bad snapshot url').slice(0, 80)}` };
  }
  // A thin copy or extractor miss on any capture is evidence; soft-404
  // snapshots alone say nothing about the review. But when some capture
  // could not be fetched at all, that one may have been the full copy: not
  // evidence, retry later.
  if (lastFetchError) return { ok: false, outcome: 'non_evidence', reason: `archive_unavailable: ${String(lastFetchError.message).slice(0, 80)}` };
  if (evidenceRefusal) return evidenceRefusal;
  return lastRefusal || { ok: false, outcome: 'non_evidence', reason: 'archive_unavailable: no usable snapshot' };
}

/**
 * Subscriber browser. `session` comes from browser-outlet-adapters.openSession
 * (opened once per outlet per run, auth probe passed). A body that will not
 * extract re-runs the probe: a lost session is auth_failed, not evidence.
 */
// Raw browser bodies under this length get a session re-probe before the
// acceptance gate can call them "too short" (gap-acceptance MIN_TEXT_CHARS is
// 300 after cleaning; the raw text is longer than the cleaned one).
const BROWSER_SHORT_BODY_CHARS = 500;

async function browserSession(c, session) {
  if (!session) return { ok: false, outcome: 'browser_unavailable', reason: 'no_session' };
  let r;
  try { r = await session.extract(c.url); } catch (e) {
    // A navigation timeout or a crashed page says nothing about the article.
    return { ok: false, outcome: 'non_evidence', reason: `navigation_error: ${String(e.message).split('\n')[0].slice(0, 80)}` };
  }
  // A body shorter than the acceptance floor would be refused as "too short",
  // which is evidence; a logged-out page reads the same way, so re-probe first.
  const shortBody = r && r.text && r.text.length < BROWSER_SHORT_BODY_CHARS;
  if (r && r.text && !shortBody) return { ok: true, rawText: r.text, url: c.url, html: r.html || '', via: 'browser' };
  // The outlet answered 404/410 to a logged-in session: evidence the stored url
  // is dead (Stage 4; it used to fall through to a probe and read as rejected).
  if (r && r.notFound) return { ok: false, outcome: 'no_evidence', reason: `url_not_found_${r.status || 404}` };
  // One policy with the recover-*-browser.js scripts (browser-outlet-adapters
  // resolveBrowserMiss): a bot check, an access wall or a lost session is never
  // evidence about the review.
  if (session.probe) {
    const { resolveBrowserMiss } = require('./browser-outlet-adapters');
    const v = await resolveBrowserMiss(r, { probe: session.probe, minAuthChars: session.minAuthChars || 1, refusalCode: shortBody ? 'too_short' : null });
    if (v.action === 'stop') return { ok: false, outcome: 'auth_failed', reason: v.reason };
    if (v.action === 'skip') return { ok: false, outcome: 'non_evidence', reason: v.reason };
  } else if (/robot|denied|too many|bot-check|challenge/i.test(String(r && r.error))) {
    return { ok: false, outcome: 'non_evidence', reason: 'bot_check' };
  } else if (r && r.authWall) {
    return { ok: false, outcome: 'non_evidence', reason: 'access_wall' };
  }
  // Session verified live: a short body goes to the acceptance gate as usual.
  if (shortBody) return { ok: true, rawText: r.text, url: c.url, html: r.html || '', via: 'browser' };
  return { ok: false, outcome: 'rejected', reason: 'extractor_null' };
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

const DEAD_URL_REASONS = Object.freeze({
  url_not_found_404: 404, url_not_found_410: 410, // logged-in subscriber browser (browserSession)
  url_dead_404: 404, url_dead_410: 410, // free refetch (failed-fetch-policy classification)
});

/**
 * Field patch that records a hard 404/410 on the review's CURRENT url, or null.
 * `httpStatus` is the field rediscover-review-urls.js Phase 3 already ranks
 * first for SERP url discovery, and text-gap-classify reads as URL_DEAD, so
 * the next run plans ARCHIVE / rediscovery instead of re-fetching a dead url
 * through the subscriber browser (BRO-7171: 31 WaPo, 16 WSJ, 12 New Yorker
 * and 5 NYT urls answered 404 to a logged-in session; the evidence stayed in
 * the engine ledger only). Url-bound: url-change-invariant clears it when the
 * url moves, and a record whose url moved since the fetch is left alone.
 * Pure.
 * @param {object} review  fresh on-disk record
 * @param {{url:string|null, outcome:string, reason:string}} result  strategy result for that url
 * @returns {object|null}
 */
function deadUrlStampPatch(review, { url, outcome, reason }) {
  if (!review || outcome !== 'no_evidence') return null;
  const status = DEAD_URL_REASONS[reason];
  if (!status || !url || review.url !== url) return null;
  if (review.contentTier === 'complete') return null;
  if (review.httpStatus === status) return null;
  return { httpStatus: status };
}

/**
 * Paid fetch of the stored url (Bright Data web unlocker, no login). The
 * Telegraph returned full premium text this way in Nov 2026 with the
 * subscription cancelled. Spend is capped by BD_REQ_BUDGET inside fetchPage;
 * a capped request is non_evidence (failed-fetch-policy).
 */
async function paidFetch(c, deps = defaultDeps()) {
  if (!c.url) return { ok: false, outcome: 'non_evidence', reason: 'no_url' };
  let res;
  try { res = await deps.fetchPage(c.url, { tiers: ['brightdata'] }); } catch (e) { return outcomeForFetchError(e.message); }
  const r = fromHtml(res && res.content, c.url, 'paid:brightdata', deps);
  return r.ok ? { ...r, url: c.url } : r;
}

// Paid SERP queries URL_FIND may spend per process (the rest of the night's
// SERP_QUERY_BUDGET stays with the other strategies).
let urlFindSerpUsed = 0;
const urlFindSerpMax = () => { const n = parseInt(process.env.GAP_URL_FIND_SERP_MAX || '15', 10); return Number.isFinite(n) ? n : 15; };
let urlFindEnv = null;
// Bright Data fetches URL_FIND may spend per process, so it cannot eat the
// night's BD_REQ_BUDGET before PAID_FETCH (the paywall route) runs.
let urlFindBdUsed = 0;
const urlFindBdLeft = () => { const n = parseInt(process.env.GAP_URL_FIND_BD_MAX || '8', 10); return urlFindBdUsed < (Number.isFinite(n) ? n : 8); };
const URL_FIND_CANDIDATES_PER_METHOD = 3;
// Gate refusals that say the page is NOT this review (vs. "is it, but unreadable").
const URL_IDENTITY_REFUSALS = new Set(['identity_unproven', 'url_change_refused', 'show_not_mentioned', 'wrong_article', 'byline_conflict', 'date_implausible', 'multi_show_no_section', 'blocklisted']);

/** Corpus index, shows and registry, built once per process. */
function urlFindEnvironment({ dir, rootDir }) {
  if (urlFindEnv) return urlFindEnv;
  const fs = require('fs');
  const path = require('path');
  const UF = require('./gap-url-find');
  const reg = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'outlet-registry.json'), 'utf8'));
  const showsRaw = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'shows.json'), 'utf8'));
  const titles = new Map((showsRaw.shows || showsRaw).map((s) => [s.id, s.title]));
  urlFindEnv = { registry: reg.outlets || reg, corpus: UF.buildCorpusIndex(dir, (id) => titles.get(id)), archiveDir: path.join(rootDir, 'data', 'aggregator-archive') };
  return urlFindEnv;
}

/**
 * URL_FIND: find the original url of a review we hold no (or a dead) url for,
 * free methods first, fetch each found url (free, Wayback, then Bright Data
 * within budget), and return the first candidate the acceptance gate would
 * take (decide-only; the driver then runs the real locked write, LLM check
 * included). Every method's result goes in `methods` for the ledger: a review
 * is only written off once each method has run to the end
 * (gap-url-find.urlFindProgress, gap-terminal NOT_FINDABLE).
 * @returns candidate | refusal, plus `methods` {METHOD: status}
 */
async function urlFind(c, { dir, rootDir, serpKeys = {}, refusedUrls = new Set(), methods: only = null, freeOnly = false } = {}, ufDeps = null) {
  const fs = require('fs');
  const path = require('path');
  const UF = require('./gap-url-find');
  const { recoverReviewTextVerified, pageHeadline, pagePublishDate, pageByline } = require('./gap-acceptance');
  const env = urlFindEnvironment({ dir, rootDir });
  let review;
  try { review = JSON.parse(fs.readFileSync(c.filePath, 'utf8')); } catch (e) { return { ok: false, outcome: 'non_evidence', reason: `code_error: ${e.message}`, methods: {} }; }
  const showId = c.showId || path.basename(path.dirname(c.filePath));
  const show = c.show || null;
  const title = (show && show.title) || review.showTitle || showId;
  const ce = env.corpus.get(review.outletId) || { urls: [], samples: [] };
  const profile = UF.learnOutletProfile(ce.urls);
  const hosts = UF.outletHosts(review.outletId, profile, env.registry);
  if (!profile.hosts.length) profile.hosts = hosts.slice(0, 2);
  // freeOnly (a free-only URL_FIND slot, BRO-7171 item c): no paid SERP, no
  // Bright Data fetch. SERP then reads 'skipped_paid', which never counts as done.
  const serpLeft = !freeOnly && urlFindSerpUsed < urlFindSerpMax();
  const ctx = { review: { ...review, showId }, show, title, profile, hosts, archiveDir: env.archiveDir, templates: UF.learnSlugTemplates(ce.samples), titleDirs: UF.learnTitleStartDirs(ce.samples), serpKeys, allowPaid: serpLeft };
  const status = {};
  const tried = new Set([...refusedUrls].map((u) => u.replace(/\/$/, '')));
  const refusedCandidates = [];
  const foundUnreadable = [];
  for (const m of only || UF.METHODS) {
    if (m === 'SERP' && !serpLeft) { status[m] = 'skipped_paid'; continue; }
    if (m === 'COMMON_CRAWL') { try { await ensureCcCollections(UF); } catch { status[m] = 'error'; continue; } }
    const r = await UF.runMethod(m, ctx, ufDeps || undefined);
    if (m === 'SERP' && r.paid) urlFindSerpUsed++;
    if (r.error && !r.candidates.length) { status[m] = /no_serp_key/.test(r.error) ? 'skipped_paid' : 'error'; continue; }
    if (!r.candidates.length) {
      status[m] = UF.methodNotApplicable(m, r, ctx) ? 'not_applicable' : 'no_candidates';
      continue;
    }
    // Links refused on earlier nights do not use up this night's slots.
    const fresh = r.candidates.filter((x) => !tried.has(x.url.replace(/\/$/, '')));
    let st = fresh.length > URL_FIND_CANDIDATES_PER_METHOD ? 'more_candidates' : 'candidates_refused';
    for (const cand of fresh.slice(0, URL_FIND_CANDIDATES_PER_METHOD)) {
      tried.add(cand.url.replace(/\/$/, ''));
      const got = await UF.fetchCandidateText(cand.url, { allowBd: !freeOnly && urlFindBdLeft(), onPaid: () => { urlFindBdUsed++; } }, (ufDeps && ufDeps.fetchDeps) || null);
      if (!got.ok) {
        // Refused only when every route answered with evidence (404, no
        // capture, extractor null); a timeout or budget cap leaves it open.
        if (UF.fetchRefusedOnEvidence(got.tried)) refusedCandidates.push(cand.url); else if (st !== 'found_unreadable') st = 'error';
        continue;
      }
      const d = await ((ufDeps && ufDeps.gate) || recoverReviewTextVerified)({
        filePath: c.filePath, rawText: got.rawText, url: cand.url, expectUrl: review.url || null, headline: pageHeadline(got.html), pageDate: pagePublishDate(got.html, cand.url), pageByline: pageByline(got.html, review.outletId),
        labels: { fetchMethod: 'x', sourceMethod: 'x' }, dryRun: true, show, ctxOpts: { reviewTextsDir: dir },
      });
      if (d.ok || d.code === 'dry_run_needs_llm') {
        status[m] = 'found';
        return { ok: true, rawText: got.rawText, url: cand.url, html: got.html, via: `url-find:${m}:${got.via}`, methods: status, foundBy: m, refusedCandidates, foundUnreadable };
      }
      if (URL_IDENTITY_REFUSALS.has(d.code)) { refusedCandidates.push(cand.url); continue; }
      // The page may well be this review but cannot be taken (paywall, too
      // short, not longer, record locked): the link is found, never "not
      // findable". Keep it for the ledger; the method stays open.
      foundUnreadable.push({ url: cand.url, code: d.code });
      st = 'found_unreadable';
    }
    // A query that errored left part of the index unsearched: refusing what
    // the other queries found does not finish the method (ship-check P1).
    if (r.error && st === 'candidates_refused') st = 'error';
    status[m] = st;
  }
  const complete = UF.METHODS.every((m) => UF.METHOD_DONE.has(status[m]));
  return { ok: false, outcome: Object.values(status).some((s) => UF.METHOD_DONE.has(s)) ? 'no_evidence' : 'non_evidence', reason: complete ? 'url_not_found_all_methods' : (foundUnreadable.length ? 'url_found_unreadable' : 'url_not_found'), methods: status, refusedCandidates, foundUnreadable };
}

async function ensureCcCollections(UF) {
  if (ensureCcCollections.done) return;
  // One try per process: an outage must not cost 60s on every review.
  if (ensureCcCollections.failed) throw new Error('common crawl index list unavailable this run');
  try {
    UF.setCcCollections(JSON.parse(await UF.defaultDeps().fetchText('https://index.commoncrawl.org/collinfo.json', { timeoutMs: 60000 })));
  } catch (e) { ensureCcCollections.failed = true; throw e; }
  ensureCcCollections.done = true;
}

module.exports = { FREE_TIERS, refetchFree, archive, browserSession, urlRediscover, paidFetch, urlFind, outcomeForFetchError, fromHtml, defaultDeps, deadUrlStampPatch, DEAD_URL_REASONS };
