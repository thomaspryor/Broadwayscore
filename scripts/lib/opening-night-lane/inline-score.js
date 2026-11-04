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
 * or stars (the trust model's low-confidence fallback score), or printed an excerpt beside its link (scored as
 * excerpt-only, the regular pipeline's path for a paywalled review); with none of them it is a failure.
 * A paywall host's page under the scorer's body gate is the teaser, never scored as page text: it waits for an excerpt
 * or score. Over the gate, scraped text failing the old path's paywall rule is scored as a partial copy, and
 * a not_a_review on a page under the host's floor (WSJ 2500) is held for an excerpt.
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
const { canonicalUrl, hasReviewSignal } = require('./discovery');
const { laneNonReviewReason, multiShowColumnReason, nearbyShowTitles } = require('./lane-guards');
const { BODY_GATE_CHARS, MIN_SHORT_PARTIAL_CHARS } = require('../scorable-text');
const { EXCERPT_FIELDS } = require('../excerpt-fields');
const { getHardPaywallDomain, HARD_PAYWALL_FLOORS, SCRAPED_SOURCE_METHODS, SOFT_PAYWALL_MIN_CHARS, truncatedTierPatch } = require('../paywall-completeness');
const { OUTLET_HARD_MARKERS } = require('../paywall-detector');

// Hosts whose page will not give a scraper the review text, so an aggregator excerpt may stand in for it: the
// completeness hard paywalls (NYT, WSJ, ...), the detector's (FT, Telegraph), plus London and NY titles in neither
// list. Open sites are not here: an excerpt scored 13-20 points off their full review (BRO-6872).
const EXCERPT_FALLBACK_HOSTS = Object.freeze([...new Set([
  ...Object.keys(HARD_PAYWALL_FLOORS), ...Object.keys(OUTLET_HARD_MARKERS),
  'thetimes.com', 'thetimes.co.uk', 'newsday.com', 'bostonglobe.com',
])]);
function excerptMayScore(url) {
  let h;
  try { h = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return false; }
  return EXCERPT_FALLBACK_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

// The ensemble refuses selected text under 50 chars (ensemble-scorer.ts prepareScoringInput): a shorter excerpt is no fallback.
const MIN_EXCERPT_CHARS = 50;
/** The aggregator excerpts the scorer can read, as review-file fields ({ bwwExcerpt: '...' }). */
function usableExcerpts(excerpts) {
  const out = {};
  for (const [field, text] of Object.entries(excerpts || {})) {
    if (EXCERPT_FIELDS.includes(field) && typeof text === 'string' && text.trim().length >= MIN_EXCERPT_CHARS) out[field] = text.trim();
  }
  return out;
}

/**
 * The critic's printed rating ("3/5 stars", "5/5", "B+") as the review-file fields the regular pipeline writes for it
 * (collect-review-texts.js: setExtractedScore, then scoreSource = the extractor's source). With these on the scoring
 * file, detectBandFromReviewFile finds the band and the ensemble scores in anchored mode, as it does for the site's own
 * row; without them every lane score was unanchored (BRO-6872: NYSR "3/5 stars" lane 71 vs site 63, One Minute Critic
 * "5/5" lane 80 vs site 95). `rating` is extractScore's result ({originalScore, normalizedScore, source}); null when none.
 */
function ratingFields(rating) {
  if (!rating || rating.originalScore == null || rating.originalScore === '' || !rating.source) return null;
  const { setExtractedScore } = require('../score-routing');
  const f = {};
  const routed = setExtractedScore(f, { value: rating.originalScore, normalizedValue: rating.normalizedScore, source: rating.source });
  if (!routed.wasAggregator) f.scoreSource = rating.source;
  return f;
}

const DEFAULT_RETRY_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];

class LaneRetryError extends Error { constructor(msg) { super(msg); this.name = 'LaneRetryError'; } }
class LanePermanentError extends Error { constructor(msg) { super(msg); this.name = 'LanePermanentError'; this.permanent = true; } }

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * A not_a_review verdict on a paywall teaser: the page is a known hard-paywall host (paywall-completeness.js
 * HARD_PAYWALL_FLOORS: NYT, WSJ, New Yorker, Washington Post, Chicago Tribune) and its text is under that host's floor
 * for a complete review. A teaser is a headline and a paragraph, so "not a review" judges the teaser, not the review the
 * aggregator cited (BRO-6066: the 10-29 WSJ review was lost for good to not_a_review). A full-length page judged
 * not_a_review is still a verdict.
 */
function isTeaserNotAReview(rejection, url, text) {
  // truncated_text too: a page labelled a partial copy (the paywall rule above) can draw that verdict instead (BRO-6872).
  // garbage_text judges the page text as unreadable (paywall and sign-in chrome), not the review, at any length: the
  // 2026-11-04 A Few Good Men replay lost the WSJ review for good to it although the BWW roundup printed a 600-character
  // quote from it (BRO-6872).
  const garbled = /^garbage_text\b/.test(String(rejection || ''));
  if (!garbled && !/^(not_a_review|truncated_text)\b/.test(String(rejection || ''))) return false;
  // The URL must itself say review (WSJ "/articles/<show>-review-..."): a short feature or news piece on the same host,
  // under the floor because it is short, keeps its verdict (ship-check).
  if (!hasReviewSignal(url, '')) return false;
  const domain = getHardPaywallDomain(url);
  return !!domain && (garbled || String(text || '').trim().length < HARD_PAYWALL_FLOORS[domain]);
}

/**
 * @param {object} args
 *   show {id}, night, ledgerDir, now() -> ms,
 *   fetchPage(url) -> {content: string}            (throws on failure)
 *   extractArticle(html, host) -> string|null      (clean body text)
 *   extractMeta?(html, url) -> {criticName?, publishDate?, outlet?}
 *   extractRating?(html, text, {url, outletId, showTitle}) -> {originalScore, normalizedScore, source}|null
 *                                                  (the printed star rating or grade; the scorer anchors to its band)
 *   aggregatorFor?(candidate) -> {thumb?, stars?, excerpt?, excerpts?}   (default: the excerpts discovery attached to
 *                                                  the candidate, { bwwExcerpt|dtliExcerpt|playbillVerdictExcerpt })
 *   scoreText(text, ctx) -> {score, rejected?, rejection?, allModelsFailed?}  (throws on failure)
 *   retryMs? (backoff schedule), minTextChars?
 */
function createInlineScoring({
  show, night, ledgerDir, now, fetchPage, extractArticle, extractMeta = () => ({}), extractRating = () => null, aggregatorFor = () => ({}), scoreText,
  retryMs = DEFAULT_RETRY_MS, minTextChars = trust.MIN_FULL_TEXT_CHARS, allShows = [],
} = {}) {
  for (const [k, v] of Object.entries({ show, night, ledgerDir, now, fetchPage, extractArticle, scoreText })) {
    if (v === undefined || v === null) throw new Error(`inline-score: ${k} is required`);
  }
  const otherTitles = nearbyShowTitles(show, allShows); // same-weeks shows a multi-show column would also cover
  const state = new Map(); // `${stage}:${key}` -> {attempts, nextAt, terminal}
  const maxAttempts = retryMs.length + 1;
  const fetched = new Map(); // key -> the fetch result, so a score retry never pays for the page again
  const shortLen = new Map(); // key -> length of the last under-the-floor extraction
  const teaserVerdict = new Map(); // key -> the scorer's not_a_review on a paywall teaser, waiting for an aggregator excerpt
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
    if (fetched.has(key)) { // a score retry: no second fetch, no second `fetched` cost
      const out = fetched.get(key);
      // A later pass can bring an aggregator that prints an excerpt the first sighting lacked (Playbill lists links only;
      // BWW quotes each critic): keep it, a teaser verdict waits for exactly that. Kept BEFORE the backoff gate: the
      // candidate exists only for this pass, so an excerpt seen while the score is backing off would otherwise be lost.
      const more = usableExcerpts(candidate.excerpts);
      if (Object.keys(more).length) out.excerpts = { ...(out.excerpts || {}), ...more };
      gate('score', key);
      return out;
    }
    gate('fetch', key);
    const aggregator = { ...(candidate.excerpts ? { excerpts: candidate.excerpts } : {}), ...(aggregatorFor(candidate) || {}) };
    // An aggregator excerpt stands in for the review only on a paywall host (EXCERPT_FALLBACK_HOSTS: WSJ, NYT, Times, ...), where the page
    // will never give the text. On an open site a failed or short fetch is a block or an extractor miss, and a one-line
    // excerpt scored 20 points off the full review (BRO-6872: Talkin' Broadway 71 vs 91, the Independent 42 vs 55, The
    // Hollywood Reporter 62 vs 42), so the review is held for the regular pipeline to collect in full.
    // Every usable excerpt is kept on the row (buildLaneReview writes bwwExcerpt etc., as the regular pipeline does);
    // only its use as a score stand-in is limited to paywall hosts.
    const excerpts = usableExcerpts(aggregator.excerpts);
    const hasExcerpt = excerptMayScore(candidate.url) && Object.keys(excerpts).length > 0;
    const thumbScore = !!trust.paywallFallbackScore(aggregator);
    // aggregatorFor was never wired in the real lane, so this was always false and a paywalled WSJ review was lost for
    // good (BRO-6066). Discovery now carries each aggregator's excerpt on the candidate.
    const canFallBack = thumbScore || hasExcerpt;
    // With no thumb or stars the scorer reads the excerpt (excerpt-only, exempt from its body gate); a thumb score is
    // set by the trust model and the scorer is not called.
    const excerptTier = hasExcerpt && !thumbScore ? { contentTier: 'excerpt' } : {};
    const withExcerpts = (o) => (Object.keys(excerpts).length ? { ...o, excerpts } : o);
    const fallback = (why) => withExcerpts({ outlet: undefined, criticName: null, publishDate: null, fullText: '', aggregator, fallbackReason: why, ...excerptTier });
    try {
      const page = await fetchPage(candidate.fetchUrl || candidate.url);
      const html = page && typeof page.content === 'string' ? page.content : '';
      if (!html) throw new Error('fetchPage returned no content');
      const sourceMethod = page.source || page.via || null; // what the old path's paywall rule keys on (SCRAPED_SOURCE_METHODS)
      const text = String(extractArticle(html, hostOf(candidate.url)) || '').trim();
      const meta = extractMeta(html, candidate.url) || {};
      // Read off the page whatever text is kept: a rating printed beside a teaser is still the critic's.
      let rating = null;
      try { rating = ratingFields(extractRating(html, text, { url: candidate.url, outletId: candidate.outletId, showTitle: show.title })); } catch { /* no rating is not a failure */ }
      if (text.length < minTextChars && !canFallBack) throw new Error(`no extractable text (${text.length} chars) and no aggregator score or paywall excerpt to fall back on`);
      // Under the scorer's body gate the scorer rejects the text for good (body_too_short), so a teaser or a page the
      // extractor cut short is a FETCH problem: fetch again on the backoff (BRO-6066: Deadline's 956-char extraction and
      // WSJ's teaser were each lost after one attempt). On an open site the last attempt scores what it has as a partial copy
      // (contentTier 'truncated'), the owner's call for 300-999-char partials (scorable-text.js isShortPartialReview).
      // A paywall host's short page is a teaser and is never scored as page text (see paywallTeaser below).
      // Under 300 chars the scorer refuses even a partial copy, so the aggregator excerpt is scored instead, or, with
      // none, the review fails rather than being sent to a scorer that will reject it.
      // An aggregator thumb or stars still takes a paywall's empty page at once (the trust model's fallback). An excerpt
      // waits for the retries: an empty extraction is as often a Cloudflare page or a transient block as a paywall, and
      // the full text a few minutes later beats an excerpt score (ship-check).
      let contentTier;
      let keepText = text.length >= minTextChars;
      const shortText = text.length < BODY_GATE_CHARS && !(text.length < minTextChars && thumbScore);
      if (shortText) {
        const st = state.get(`fetch:${key}`);
        const attempt = ((st && st.attempts) || 0) + 1;
        const why = text.length < minTextChars ? `no usable article text (${text.length} chars)` : `only ${text.length} chars of article text (the scorer needs ${BODY_GATE_CHARS})`;
        // The same length twice means the page or the extractor gives no more: stop paying for fetches.
        const sameAsBefore = shortLen.get(key) === text.length;
        shortLen.set(key, text.length);
        if (attempt < maxAttempts && !sameAsBefore) fail('fetch', key, new Error(`${why}; fetching again`));
        // On a paywall host (WSJ, NYT, ...) a short page is the teaser, not a partial copy of the review: the lane's fetch
        // has no subscriber login (production gets WSJ through collect-review-texts' logged-in Browserbase), so scoring
        // it would score a headline and a paragraph. It is held unscored, on the backoff, until an aggregator excerpt or
        // score arrives; when the retries run out the regular pipeline collects it in full (BRO-6872).
        const paywallTeaser = excerptMayScore(candidate.url);
        const partialOk = !paywallTeaser && text.length >= MIN_SHORT_PARTIAL_CHARS;
        if (!partialOk && !canFallBack && paywallTeaser) fail('fetch', key, new Error(`${why}: a paywall teaser, held unscored until an aggregator excerpt or score arrives`));
        if (!partialOk && !canFallBack) fail('fetch', key, new Error(`${why}, under the ${MIN_SHORT_PARTIAL_CHARS} a partial copy needs, and no aggregator score or paywall excerpt`), true);
        const using = partialOk ? 'scoring it as a partial copy' : (thumbScore ? 'using the aggregator score' : 'scoring the aggregator excerpt');
        failures.appendFailure(ledgerDir, { show: show.id, night, reviewKey: key, stage: 'fetch', reason: `${why}; ${using}`, attempt, terminal: false, at: now() });
        if (partialOk) contentTier = 'truncated';
        else { keepText = false; contentTier = excerptTier.contentTier; }
      }
      // Over the body gate, the old path's paywall rule (collect-review-texts.js), on the same inputs: scraped text on a
      // hard-paywall URL that fails assessPaywallCompleteness, or on a soft-paywall host under its floor, is a partial
      // copy. It is scored now, re-collected later, and carries the old path's fields (tierReason 'Paywall truncation:',
      // sourceMethod) so the rebuild's applyPaywallTierOverride keeps it truncated. The WSJ floor is not a teaser
      // boundary: 27 of 40 complete, logged-in WSJ reviews of 1000-2499 chars sit under it, so this text is scored,
      // not held (BRO-6872).
      let paywallTruncation = null;
      if (!contentTier && keepText && text.length >= BODY_GATE_CHARS && SCRAPED_SOURCE_METHODS.has(sourceMethod)) {
        const criticName = meta.criticName || candidate.criticName || null;
        paywallTruncation = truncatedTierPatch({ contentTier: 'complete', fullText: text, url: candidate.url, criticName, sourceMethod });
        const host = hostOf(candidate.url);
        const softMin = !getHardPaywallDomain(candidate.url) && SOFT_PAYWALL_MIN_CHARS[host];
        if (!paywallTruncation && softMin && text.length < softMin) {
          const reason = `Paywall truncation: ${text.length} chars < ${softMin} min for ${host} (source: ${sourceMethod})`;
          paywallTruncation = { contentTier: 'truncated', tierReason: reason, contentTierReason: reason, textStatus: 'truncated', textQuality: 'truncated', isFullReview: false };
        }
        if (paywallTruncation) contentTier = 'truncated';
      }
      const out = withExcerpts({ outlet: meta.outlet, criticName: meta.criticName || null, publishDate: meta.publishDate || null, fullText: keepText ? text : '', aggregator, ...(contentTier ? { contentTier } : {}), ...(sourceMethod ? { sourceMethod } : {}), ...(paywallTruncation ? { paywallTruncation } : {}), ...(rating ? { rating } : {}) });
      fetched.set(key, out);
      return out;
    } catch (e) {
      if (e instanceof LaneRetryError || e instanceof LanePermanentError) throw e;
      // A hard paywall (401/403) is a paywall, not an outage: a T1 review with an aggregator score is never rejected for
      // it (trust-model paywallFallbackScore), so take the fallback now instead of retrying a door that stays shut. An
      // excerpt-only fallback retries first (a proxy's 403 is often transient) and is taken when the retries run out.
      if (thumbScore && (e && (e.status === 401 || e.status === 403 || /\b40[13]\b/.test(String(e.message))))) {
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

  async function scoreReview(row, fetchedReview = {}) {
    const key = canonicalUrl(row.url);
    gate('score', key);
    // The write path's non-review and roundup guards, which the lane bypasses, applied to the fetched page before any
    // model is paid for it: a verdict, never retried (BRO-6872: Gold Derby roundups scored as reviews).
    const notAReview = laneNonReviewReason(row);
    if (notAReview) return fail('score', key, new Error(`not a review: ${notAReview}`), true);
    const column = multiShowColumnReason(row, otherTitles);
    if (column) return fail('score', key, new Error(column), true);
    const excerpts = usableExcerpts((fetchedReview && fetchedReview.excerpts) || {});
    const ctx = { showId: row.showId, showTitle: show.title, category: show.category, venue: show.venue, type: show.type, outletId: row.outletId, outlet: row.outlet, criticName: row.criticName, publishDate: row.publishDate, url: row.url, contentTier: (fetchedReview && fetchedReview.contentTier) || 'complete', ...(fetchedReview && fetchedReview.rating ? { rating: fetchedReview.rating } : {}) };
    // The excerpt is the scorer's text only when there is no page text to score: page text is scored as it always was,
    // with no aggregator quote mixed in (text-quality.js would append it to a short body).
    // Excerpts score a review only on a hard-paywall host (see fetchReview): an open site's page text the scorer refused
    // is held for the regular pipeline, not replaced by a one-line quote (BRO-6872).
    const hasExcerpts = Object.keys(excerpts).length > 0 && excerptMayScore(row.url);
    if (hasExcerpts && !row.fullText) ctx.excerpts = excerpts;
    let r;
    let fromExcerpt = false;
    try {
      // The teaser was judged once already: never pay the models for it again. With an excerpt now, score that; without
      // one, wait (bounded by the retry schedule) for an aggregator that prints one.
      if (teaserVerdict.has(key)) {
        if (!hasExcerpts) return fail('score', key, new Error(`scorer rejected the paywall teaser (${teaserVerdict.get(key)}); waiting for an aggregator excerpt`));
        r = { rejected: true, rejection: teaserVerdict.get(key) };
      } else r = await scoreText(row.fullText, ctx);
      // not_a_review on a known hard-paywall host's teaser judges the teaser. With an aggregator excerpt the excerpt is
      // scored; without one it is retried on the backoff (not a verdict yet), since a later pass may bring the excerpt.
      if (r && r.rejected && row.fullText && isTeaserNotAReview(r.rejection, row.url, row.fullText)) {
        teaserVerdict.set(key, r.rejection);
        if (!hasExcerpts) return fail('score', key, new Error(`scorer rejected the paywall teaser (${r.rejection}, ${row.fullText.length} chars); waiting for an aggregator excerpt`));
        failures.appendFailure(ledgerDir, { show: show.id, night, reviewKey: key, stage: 'score', reason: `scorer judged the paywall teaser (${r.rejection}); scoring the aggregator excerpt`, attempt: 1, terminal: false, at: now() });
        r = await scoreText('', { ...ctx, contentTier: 'excerpt', excerpts });
        fromExcerpt = true;
      }
      // The scorer's input gate refusing the PAGE text (a paywall teaser, or a page that is mostly chrome) says nothing
      // about the review when an aggregator printed the critic's own words: score those once, excerpt-only. The 10-22
      // WSJ review was lost for good to input_validation_failed:body_too_short (BRO-6066). A wrong-show or non-review
      // verdict is the scorer's judgement of the review itself and is never retried on an excerpt.
      // Likewise a paywall page already labelled a partial copy (contentTier 'truncated', over the host floor) drawing a
      // truncated_text verdict: the scorer agreed it is partial, which says nothing against the critic's quoted words.
      const refusedPartial = /^truncated_text\b/.test(String((r && r.rejection) || '')) && ctx.contentTier === 'truncated';
      if (!fromExcerpt && r && r.rejected && (/^input_validation_failed/.test(String(r.rejection || '')) || refusedPartial) && row.fullText && hasExcerpts) {
        failures.appendFailure(ledgerDir, { show: show.id, night, reviewKey: key, stage: 'score', reason: `scorer refused the page text (${r.rejection}); scoring the aggregator excerpt`, attempt: 1, terminal: false, at: now() });
        r = await scoreText('', { ...ctx, contentTier: 'excerpt', excerpts });
        fromExcerpt = true;
      }
    } catch (e) {
      // A retry or verdict already recorded above (the teaser wait) must not be counted a second time (ship-check).
      if (e instanceof LaneRetryError || e instanceof LanePermanentError) throw e;
      return fail('score', key, e);
    }
    // The scorer judging it not a review of this show is a verdict, not a glitch: record it and stop retrying.
    if (r && r.rejected) return fail('score', key, new Error(`scorer rejected the review: ${r.rejection || 'unspecified'}`), true);
    if (!r || r.allModelsFailed || !Number.isFinite(r.score)) return fail('score', key, new Error('scorer returned no score'));
    // Scored from the excerpt: the page text the scorer refused is not kept, and the review is queued for re-collection.
    const extra = fromExcerpt ? { ...(r.extra || {}), fullText: '', isFullReview: false, needsRecollection: true, textStatus: 'paywalled-awaiting-recollection', contentTier: 'excerpt' } : r.extra;
    return extra ? { score: r.score, extra } : r.score;
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
      fullText: text, contentTier: ctx.contentTier || 'complete', // 'truncated': a partial copy, scored at low confidence
      ...usableExcerpts(ctx.excerpts), // aggregator quotes: context for a partial copy, the only text for an excerpt-only review
      ...(ctx.rating || {}), // the printed rating (originalScore + its extractor source): anchored mode keys on it
    };
    const res = await scorer.scoreReviewFile(file);
    if (res && res.rejected) return { rejected: true, rejection: res.rejection || 'rejected' };
    if (res && res.inputValidationFailed) return { rejected: true, rejection: res.error || 'input_validation_failed' };
    if (!res || !res.success || !res.scoredFile) throw new Error((res && res.error) || 'ensemble scoring failed');
    const ens = res.ensembleResult || {};
    if (ens.singleModelEmergency) throw new Error('only one model scored it (single-model emergency); not trusting that score');
    const sf = res.scoredFile;
    // The scorer's method label (anchored-v6 / llm-v6) and the star's provenance, as the regular pipeline's file has them.
    const label = { ...(sf.scoreSource ? { scoreSource: sf.scoreSource } : {}), ...(sf.scoreProvenance ? { scoreProvenance: sf.scoreProvenance } : {}) };
    return { score: sf.assignedScore, extra: { llmScore: sf.llmScore, llmMetadata: sf.llmMetadata, ensembleData: sf.ensembleData, ...label } };
  };
}

/**
 * The real fetch and extract ports; lazy, so tests and cloud sessions never load a scraper. Pass the lane's routed
 * fetchPage (browserbase-fetch.js createLaneFetch) so review fetches share discovery's Browserbase session (BRO-6073);
 * without one it is the plain scraper.
 */
function realFetchPorts({ fetchPage = require('../scraper').fetchPage } = {}) {
  const { extractArticleText, extractPublishDate } = require('../article-extractor');
  const { extractByline } = require('../byline-extraction');
  return {
    // The regular pipeline's regex rating extractor (collect-review-texts.js extractScore, with its no-critic-rating
    // discard). Its LLM extractor is not run: that is a paid call per review on the night's hot path.
    extractRating: (html, text, { url, outletId, showTitle } = {}) => {
      const { extractScore, publishesNoCriticRating } = require('../score-extractors');
      const oid = outletId || ((require('../review-normalization').resolveOutletFromUrl(url) || {}).outletId) || '';
      if (!oid) return null;
      const r = extractScore(html, text, oid, showTitle) || null;
      // A rating-less outlet's page star is a site widget, not the critic's (london-theatre's own page data excepted).
      return r && !publishesNoCriticRating(oid, { originalScoreSource: r.source }) ? r : null;
    },
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

module.exports = {
  DEFAULT_RETRY_MS, usableExcerpts, ratingFields, excerptMayScore, EXCERPT_FALLBACK_HOSTS, isTeaserNotAReview, LaneRetryError, LanePermanentError, createInlineScoring, ensembleScoreText, realFetchPorts };
