'use strict';
/**
 * Inline fetch, extract and score for the opening-night lane (BRO-4784, epic BRO-4210 phase 2c). The `fetchReview` and
 * `scoreReview` ports lane-runner.js calls for each newly discovered review, the moment it is discovered, not in a
 * batch. Target: URL seen to scored in under 5 minutes.
 *
 * Failure policy (no silent gates): every fetch or score failure is written to the lane's failure record with its
 * reason, attempt and next retry time, and retried on a bounded backoff (DEFAULT_RETRY_MS: four retries over ~17
 * minutes). A review that exhausts its retries gets a TERMINAL record and the runner reports it as failed; it is never
 * dropped without a trace. A paywalled page with no extractable text is not a failure when the aggregator gave a thumb
 * or stars (the trust model's low-confidence fallback score); with neither it is a failure.
 *
 * Timing: the runner re-offers a failed candidate on its next pass (every 2 minutes), so the backoff steps below are
 * floors and the effective retry granularity is the pass interval. One transient failure therefore costs about one pass
 * (~2-3 minutes) and still lands under the 5-minute target; two failures in a row can pass it, which the failure record
 * makes visible. Retry state is rebuilt from the failure record at start, so a restart keeps per-night attempt counts
 * and terminal verdicts instead of resetting them.
 *
 * Every external dependency is injected (fetchPage, extractors, scoreText), so this runs on recorded fixtures in cloud
 * sessions. `ensembleScoreText` adapts the real ensemble scorer; `realFetchPorts` wires scraper.fetchPage (all fetching
 * goes through fetchPage, root CLAUDE.md "Web Scraping") and the article extractors lazily, so requiring this module
 * never loads a scraper.
 */
// venue-write-guard-ok: `venue` here is read-only scoring context copied from the show record to the scorer's input;
// nothing in this file writes a venue to a data file.
const failures = require('./lane-failures');
const trust = require('./trust-model');
const { canonicalUrl } = require('./discovery');

const DEFAULT_RETRY_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];

class LaneRetryError extends Error { constructor(msg) { super(msg); this.name = 'LaneRetryError'; } }
class LanePermanentError extends Error { constructor(msg) { super(msg); this.name = 'LanePermanentError'; this.permanent = true; } }

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * @param {object} args
 *   show {id}, night, ledgerDir, now() -> ms,
 *   fetchPage(url) -> {content: string}            (throws on failure)
 *   extractArticle(html, host) -> string|null      (clean body text)
 *   extractMeta?(html, url) -> {criticName?, publishDate?, outlet?}
 *   aggregatorFor?(candidate) -> {thumb?, stars?, excerpt?}
 *   scoreText(text, ctx) -> {score, rejected?, rejection?, allModelsFailed?}  (throws on failure)
 *   retryMs? (backoff schedule), minTextChars?
 */
function createInlineScoring({
  show, night, ledgerDir, now, fetchPage, extractArticle, extractMeta = () => ({}), aggregatorFor = () => ({}), scoreText,
  retryMs = DEFAULT_RETRY_MS, minTextChars = trust.MIN_FULL_TEXT_CHARS,
} = {}) {
  for (const [k, v] of Object.entries({ show, night, ledgerDir, now, fetchPage, extractArticle, scoreText })) {
    if (v === undefined || v === null) throw new Error(`inline-score: ${k} is required`);
  }
  const state = new Map(); // `${stage}:${key}` -> {attempts, nextAt, terminal}
  const maxAttempts = retryMs.length + 1;
  const fetched = new Map(); // key -> the fetch result, so a score retry never pays for the page again
  // Rebuild retry state from the night's failure record (a restart must not reset attempts or reopen terminal verdicts).
  for (const f of failures.readFailures(ledgerDir, show.id, night).failures) {
    const id = `${f.stage}:${f.reviewKey}`;
    const st = state.get(id) || { attempts: 0, nextAt: 0, terminal: false };
    st.attempts = Math.max(st.attempts, f.attempt);
    st.terminal = f.terminal === true;
    st.nextAt = f.nextRetryAt ? Date.parse(f.nextRetryAt) : 0;
    state.set(id, st);
  }

  const gate = (stage, key) => {
    const st = state.get(`${stage}:${key}`);
    if (st && st.terminal) throw new LanePermanentError(`${stage} failed for good earlier (see the failure record)`);
    if (st && now() < st.nextAt) throw new LaneRetryError(`${stage} backing off until ${new Date(st.nextAt).toISOString()}`);
  };
  /** Record a failed attempt; throws a retry error, or a permanent one when attempts are exhausted or `permanent`. */
  const fail = (stage, key, e, permanent = false) => {
    const id = `${stage}:${key}`;
    const st = state.get(id) || { attempts: 0, nextAt: 0, terminal: false };
    st.attempts += 1;
    const reason = String((e && e.message) || e);
    const terminal = permanent || st.attempts >= maxAttempts;
    st.terminal = terminal;
    st.nextAt = terminal ? Infinity : now() + retryMs[st.attempts - 1];
    state.set(id, st);
    failures.appendFailure(ledgerDir, { show: show.id, night, reviewKey: key, stage, reason, attempt: st.attempts, terminal, nextRetryAt: terminal ? null : st.nextAt, at: now() });
    if (terminal) throw new LanePermanentError(`${stage} failed for good after ${st.attempts} attempt(s): ${reason}`);
    throw new LaneRetryError(`${stage} failed (attempt ${st.attempts}/${maxAttempts}), retry at ${new Date(st.nextAt).toISOString()}: ${reason}`);
  };

  async function fetchReview(candidate) {
    const key = candidate.key || canonicalUrl(candidate.url);
    if (fetched.has(key)) { gate('score', key); return fetched.get(key); } // a score retry: no second fetch, no second `fetched` cost
    gate('fetch', key);
    const aggregator = aggregatorFor(candidate) || {};
    const canFallBack = !!trust.paywallFallbackScore(aggregator);
    const fallback = (why) => ({ outlet: undefined, criticName: null, publishDate: null, fullText: '', aggregator, fallbackReason: why });
    try {
      const page = await fetchPage(candidate.fetchUrl || candidate.url);
      const html = page && typeof page.content === 'string' ? page.content : '';
      if (!html) throw new Error('fetchPage returned no content');
      const text = String(extractArticle(html, hostOf(candidate.url)) || '').trim();
      const meta = extractMeta(html, candidate.url) || {};
      if (text.length < minTextChars && !canFallBack) throw new Error(`no extractable text (${text.length} chars) and no aggregator score to fall back on`);
      const out = { outlet: meta.outlet, criticName: meta.criticName || null, publishDate: meta.publishDate || null, fullText: text.length < minTextChars ? '' : text, aggregator };
      fetched.set(key, out);
      return out;
    } catch (e) {
      if (e instanceof LaneRetryError || e instanceof LanePermanentError) throw e;
      // A hard paywall (401/403) is a paywall, not an outage: a T1 review with an aggregator score is never rejected for
      // it (trust-model paywallFallbackScore), so take the fallback now instead of retrying a door that stays shut.
      if (canFallBack && (e && (e.status === 401 || e.status === 403 || /\b40[13]\b/.test(String(e.message))))) {
        failures.appendFailure(ledgerDir, { show: show.id, night, reviewKey: key, stage: 'fetch', reason: `${String(e.message)} (paywall: using the aggregator score)`, attempt: 1, terminal: false, at: now() });
        const out = fallback('paywall');
        fetched.set(key, out);
        return out;
      }
      try { return fail('fetch', key, e); } catch (thrown) {
        // Retries exhausted: with an aggregator score the review still goes out at low confidence and is queued for
        // re-collection; without one it fails for good (the terminal record is already written).
        if (thrown instanceof LanePermanentError && canFallBack) { const out = fallback('fetch-exhausted'); fetched.set(key, out); return out; }
        throw thrown;
      }
    }
  }

  async function scoreReview(row) {
    const key = canonicalUrl(row.url);
    gate('score', key);
    let r;
    try {
      r = await scoreText(row.fullText, { showId: row.showId, showTitle: show.title, category: show.category, venue: show.venue, type: show.type, outletId: row.outletId, outlet: row.outlet, criticName: row.criticName, publishDate: row.publishDate, url: row.url });
    } catch (e) { return fail('score', key, e); }
    // The scorer judging it not a review of this show is a verdict, not a glitch: record it and stop retrying.
    if (r && r.rejected) return fail('score', key, new Error(`scorer rejected the review: ${r.rejection || 'unspecified'}`), true);
    if (!r || r.allModelsFailed || !Number.isFinite(r.score)) return fail('score', key, new Error('scorer returned no score'));
    return r.extra ? { score: r.score, extra: r.extra } : r.score;
  }

  return { fetchReview, scoreReview, maxAttempts };
}

/**
 * Adapt the real ensemble scorer (scripts/llm-scoring/ensemble-scorer.ts) to the scoreText port. Goes through
 * scoreReviewFile(), the production path: the pre-scoring input validator (the only text-level wrong-show and
 * nav-chrome check left once the lane stands its guards down), the hallucinated-score guard, and the confidence cap.
 * A scorer rejection or a failed input validation is a VERDICT (the review is not about this show, or is not a review);
 * all-models-failed and single-model-emergency scores are retried, never trusted.
 */
function ensembleScoreText(scorer) {
  return async (text, ctx = {}) => {
    const file = {
      showId: ctx.showId, showTitle: ctx.showTitle, category: ctx.category, venue: ctx.venue, type: ctx.type,
      outletId: ctx.outletId, outlet: ctx.outlet, criticName: ctx.criticName, publishDate: ctx.publishDate, url: ctx.url,
      fullText: text, contentTier: 'complete',
    };
    const res = await scorer.scoreReviewFile(file);
    if (res && res.rejected) return { rejected: true, rejection: res.rejection || 'rejected' };
    if (res && res.inputValidationFailed) return { rejected: true, rejection: res.error || 'input_validation_failed' };
    if (!res || !res.success || !res.scoredFile) throw new Error((res && res.error) || 'ensemble scoring failed');
    const ens = res.ensembleResult || {};
    if (ens.singleModelEmergency) throw new Error('only one model scored it (single-model emergency); not trusting that score');
    const sf = res.scoredFile;
    return { score: sf.assignedScore, extra: { llmScore: sf.llmScore, llmMetadata: sf.llmMetadata, ensembleData: sf.ensembleData } };
  };
}

/** The real fetch and extract ports; lazy, so tests and cloud sessions never load a scraper. */
function realFetchPorts() {
  const { fetchPage } = require('../scraper');
  const { extractArticleText, extractPublishDate } = require('../article-extractor');
  const { extractByline } = require('../byline-extraction');
  return {
    fetchPage: (url) => fetchPage(url),
    extractArticle: (html, host) => extractArticleText(html, host),
    extractMeta: (html, url) => {
      let criticName = null;
      try { criticName = extractByline(html) || null; } catch { /* a missing byline is not a failure */ }
      let publishDate = null;
      try { publishDate = extractPublishDate(html, url) || null; } catch { /* nor is a missing date */ }
      return { criticName, publishDate };
    },
  };
}

module.exports = { DEFAULT_RETRY_MS, LaneRetryError, LanePermanentError, createInlineScoring, ensembleScoreText, realFetchPorts };
