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
 * Every external dependency is injected (fetchPage, extractors, scoreText), so this runs on recorded fixtures in cloud
 * sessions. `ensembleScoreText` adapts the real ensemble scorer; `realFetchPorts` wires scraper.fetchPage (all fetching
 * goes through fetchPage, root CLAUDE.md "Web Scraping") and the article extractors lazily, so requiring this module
 * never loads a scraper.
 */
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
  const state = new Map(); // `${stage}:${key}` -> {attempts, nextAt}
  const maxAttempts = retryMs.length + 1;

  const gate = (stage, key) => {
    const st = state.get(`${stage}:${key}`);
    if (st && now() < st.nextAt) throw new LaneRetryError(`${stage} backing off until ${new Date(st.nextAt).toISOString()}`);
  };
  /** Record a failed attempt; throws a retry error, or a permanent one when attempts are exhausted or `permanent`. */
  const fail = (stage, key, e, permanent = false) => {
    const id = `${stage}:${key}`;
    const st = state.get(id) || { attempts: 0, nextAt: 0 };
    st.attempts += 1;
    const reason = String((e && e.message) || e);
    const terminal = permanent || st.attempts >= maxAttempts;
    st.nextAt = terminal ? Infinity : now() + retryMs[st.attempts - 1];
    state.set(id, st);
    failures.appendFailure(ledgerDir, { show: show.id, night, reviewKey: key, stage, reason, attempt: st.attempts, terminal, nextRetryAt: terminal ? null : st.nextAt, at: now() });
    if (terminal) throw new LanePermanentError(`${stage} failed for good after ${st.attempts} attempt(s): ${reason}`);
    throw new LaneRetryError(`${stage} failed (attempt ${st.attempts}/${maxAttempts}), retry at ${new Date(st.nextAt).toISOString()}: ${reason}`);
  };

  async function fetchReview(candidate) {
    const key = candidate.key || canonicalUrl(candidate.url);
    gate('fetch', key);
    try {
      const page = await fetchPage(candidate.fetchUrl || candidate.url);
      const html = page && typeof page.content === 'string' ? page.content : '';
      if (!html) throw new Error('fetchPage returned no content');
      const text = String(extractArticle(html, hostOf(candidate.url)) || '').trim();
      const meta = extractMeta(html, candidate.url) || {};
      const aggregator = aggregatorFor(candidate) || {};
      if (text.length < minTextChars && !trust.paywallFallbackScore(aggregator)) throw new Error(`no extractable text (${text.length} chars) and no aggregator score to fall back on`);
      return { outlet: meta.outlet, criticName: meta.criticName || null, publishDate: meta.publishDate || null, fullText: text.length < minTextChars ? '' : text, aggregator };
    } catch (e) {
      if (e instanceof LaneRetryError || e instanceof LanePermanentError) throw e;
      return fail('fetch', key, e);
    }
  }

  async function scoreReview(row) {
    const key = canonicalUrl(row.url);
    gate('score', key);
    let r;
    try {
      r = await scoreText(row.fullText, { showId: row.showId, outletId: row.outletId, outlet: row.outlet, criticName: row.criticName, url: row.url });
    } catch (e) { return fail('score', key, e); }
    // The scorer judging it not a review of this show is a verdict, not a glitch: record it and stop retrying.
    if (r && r.rejected) return fail('score', key, new Error(`scorer rejected the review: ${r.rejection || 'unspecified'}`), true);
    if (!r || r.allModelsFailed || !Number.isFinite(r.score)) return fail('score', key, new Error('scorer returned no score'));
    return r.score;
  }

  return { fetchReview, scoreReview, maxAttempts };
}

/** Adapt the real ensemble scorer (scripts/llm-scoring/ensemble-scorer.ts) to the scoreText port. */
function ensembleScoreText(scorer) {
  return async (text, ctx = {}) => {
    const res = await scorer.scoreReview(text, ctx.outlet ? `${ctx.outlet}${ctx.criticName ? `, ${ctx.criticName}` : ''}` : '');
    return { score: res && res.score, allModelsFailed: !!(res && res.allModelsFailed), rejected: !!(res && res.rejected), rejection: res && res.rejection };
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
      try { criticName = extractByline(html, url) || null; } catch { /* a missing byline is not a failure */ }
      let publishDate = null;
      try { publishDate = extractPublishDate(html) || null; } catch { /* nor is a missing date */ }
      return { criticName, publishDate };
    },
  };
}

module.exports = { DEFAULT_RETRY_MS, LaneRetryError, LanePermanentError, createInlineScoring, ensembleScoreText, realFetchPorts };
