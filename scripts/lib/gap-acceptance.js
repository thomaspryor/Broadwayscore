/**
 * gap-acceptance.js — the ONE gate every recovered review text passes before it
 * is written (BRO-7171 Stage 1, zero-gap recovery plan §2.4 / revised plan §4).
 *
 * Before this file there were three copies of the same quality gate:
 * processRecoveredText in browser-recovery-helpers.js (NYT, New Yorker, WaPo,
 * The Stage, The Times), a local copy in recover-wsj-browser.js, and
 * processRecovered in recover-serp-text.js. They had drifted: the WSJ and SERP
 * copies lacked the `-off-west-end` title-derivation fix, the SERP copy moved
 * the file's URL (updateFileUrlWithInvariant, which clears fullText and
 * scores and WRITES) and only then wrote the text, and none checked the
 * paywall/login page, the tier, the printed byline or the wrong-article screen
 * that safeWriteReview applies afterwards (a text that screen rejects lands
 * flagged wrongShow, i.e. the "recovery" hides a scored review).
 *
 * Two layers, so the decision is testable without disk:
 *   acceptRecoveredText(existing, candidate, ctx)  pure: no fs, no network.
 *   recoverReviewText({...})                        IO: lock, fresh read, gate,
 *       ONE write through safeWriteReview (three-way merged), provenance.
 *
 * Every refusal has a stable `code` (the Stage 2 ledger keys on it) and a human
 * `reason` that keeps the old phrases ("too short", "garbage", "not
 * mentioned", "not longer") the per-script stats buckets match on.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TIER_RANK = { invalid: 0, stub: 1, excerpt: 2, truncated: 3, complete: 4 };
const MIN_TEXT_CHARS = 300;
const EXCERPT_IDENTITY_MIN = 0.5;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex');
}

/**
 * Show title as the slug implies it. "off-west-end" must be stripped before
 * the shorter "west-end", or 360-allstars-off-west-end-2026 becomes
 * "360 allstars off" and validateShowMentioned rejects a real review
 * (confirmed 2026-08-02; the WSJ and SERP copies never got this fix).
 */
function deriveShowTitle(showId) {
  return String(showId || '')
    .replace(/-\d{4}$/, '')
    .replace(/-(off-west-end|west-end|off-broadway|regional)$/, '')
    .replace(/-/g, ' ');
}

/** cleanText + trailer strip + multi-show isolation. */
function cleanCandidateText(rawText, { url, showId }) {
  const { cleanText, stripTrailingJunk } = require('./text-cleaning');
  const { isolateMultiShowSectionForShowId } = require('./multi-show-section-extract');
  let text = stripTrailingJunk(cleanText(String(rawText || '')));
  const iso = isolateMultiShowSectionForShowId(url || '', text, showId);
  if (iso.action === 'refuse') return { refused: true };
  text = iso.text;
  return { refused: false, text };
}

function cleanedLength(text) {
  if (typeof text !== 'string' || !text) return 0;
  const { cleanText, stripTrailingJunk } = require('./text-cleaning');
  return stripTrailingJunk(cleanText(text)).length;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function surnameOf(criticName) {
  const s = String(criticName || '').split(/[,(]/)[0].trim().split(/\s+/).pop() || '';
  return s.length >= 3 ? s : '';
}

function stripMarks(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Identity proof for a text arriving at a NEW url (url rediscovery, mirror,
 * aggregator link). Either the review's own aggregator excerpt is in the text,
 * or the host is the outlet's own domain AND the critic is named AND no other
 * show owns the url AND an LLM verifier said yes. Nothing else proves that a
 * SERP hit is this critic's review of this show (task #947).
 */
function proveIdentity(existing, cleaned, newUrl, ctx) {
  const { excerptValues, excerptCoverage } = require('./cloned-excerpt-guard');
  let best = 0;
  for (const norm of excerptValues(existing).keys()) {
    best = Math.max(best, excerptCoverage({ fullText: cleaned }, norm));
  }
  if (best >= EXCERPT_IDENTITY_MIN) return { proven: true, via: `excerpt coverage ${best.toFixed(2)}` };

  const host = hostOf(newUrl);
  const domains = (ctx.outletDomains || []).map((d) => String(d).replace(/^www\./, '').toLowerCase());
  const onOutletDomain = !!host && domains.some((d) => host === d || host.endsWith(`.${d}`));
  const surname = surnameOf(existing.criticName);
  const named = !!surname && stripMarks(cleaned).includes(stripMarks(surname));
  const owners = (ctx.crossShowOwners || []).filter((o) => o && o.blocking !== false);
  const llm = ctx.llmIdentityVerified === true;
  if (onOutletDomain && named && owners.length === 0 && llm) {
    return { proven: true, via: 'outlet domain + critic named + no cross-show owner + LLM verified' };
  }
  const missing = [];
  if (!onOutletDomain) missing.push(`host ${host || '(none)'} not an outlet domain`);
  if (!named) missing.push(surname ? `critic "${surname}" not in text` : 'no critic surname');
  if (owners.length) missing.push(`url owned by ${owners.map((o) => `${o.showId}/${o.file}`).join(', ')}`);
  if (!llm) missing.push('no LLM identity verdict');
  return { proven: false, via: null, missing, excerptCoverage: best };
}

/**
 * Outlets whose article body routinely never names the show because the name
 * lives only in the headline. The Stage: the BRO-7171 pilot extracted 16 full
 * logged-in reviews whose body omits the title ("Powerful and precise revival
 * of Peter Shaffer's equine psychodrama ...") while the h1 reads "Equus review
 * at the Menier Chocolate Factory, London".
 */
const HEADLINE_IDENTITY_OUTLETS = new Set(['thestage']);

/** The page's own headline: og:title, else the first <h1>. Never the url. */
function pageHeadline(html) {
  if (!html || typeof html !== 'string') return null;
  const decode = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
  if (og && decode(og[1])) return decode(og[1]);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return h1 && decode(h1[1]) ? decode(h1[1]) : null;
}

/**
 * Headline identity (BRO-7171 Stage 2b, owner-delegated decision 2026-11-09).
 * For HEADLINE_IDENTITY_OUTLETS only, a body that never names the show may
 * pass the show-mentioned check when the fetched page's OWN headline names it.
 *
 * Why this is not the BRO-5395 rollback again: that change counted a title in
 * the review's URL plus a nearby date, and the corpus audit found
 * other-production reviews it would admit. This is page evidence: the
 * headline comes from the HTML we fetched (og:title / h1), never the slug.
 * Matching uses title-match.normalizeTitle on both sides as a whole-phrase
 * match (no loose substring), and the generic-title gate still applies: a
 * generic or ambiguous one-word title must also find its venue / cast /
 * creative / year in the headline. The wrong-article, byline, date and
 * identity checks after this one are unchanged.
 * @returns {{ok:boolean, why?:string}}
 */
function headlineIdentity({ outletId, headline, show, showTitle }) {
  if (!HEADLINE_IDENTITY_OUTLETS.has(outletId)) return { ok: false };
  if (!headline) return { ok: false, why: 'none on page' };
  const { normalizeTitle } = require('./title-match');
  const titles = [...new Set([showTitle, show && show.title].filter(Boolean))];
  const h = ` ${normalizeTitle(headline)} `;
  const named = titles.some((t) => { const n = normalizeTitle(t); return n.length >= 3 && h.includes(` ${n} `); });
  if (!named) return { ok: false, why: `"${String(headline).slice(0, 80)}" does not name the show` };
  if (show) {
    const g = require('./generic-title-matching').checkGenericTitleCandidate({ show, candidate: { title: headline } });
    if (!g.ok) return { ok: false, why: g.reason };
  }
  return { ok: true };
}

/**
 * Pure acceptance decision.
 *
 * @param {object} existing  the on-disk review record (fresh read)
 * @param {{rawText: string, url?: string, headline?: string}} candidate  text from the fetch; url
 *   is where it came from (defaults to existing.url = no URL change)
 * @param {object} ctx
 * @param {string} ctx.showId
 * @param {object|null} [ctx.show]        shows.json entry (date + wrong-article checks no-op without it)
 * @param {string[]} [ctx.knownCritics]   the outlet's known critics (printed-byline check)
 * @param {boolean} [ctx.blocklisted]     candidate url is in the show's _blocklist.json
 * @param {string|null} [ctx.urlChangeRefusal]  reason from urlChangeRefusal() when the url moves
 * @param {string[]} [ctx.outletDomains]  domains of the outlet (identity proof)
 * @param {Array}   [ctx.crossShowOwners] findCrossShowOwners(newUrl) result
 * @param {boolean} [ctx.llmIdentityVerified]
 * @returns {{accept: boolean, code: string, reason: string, cleanedText?: string,
 *   newTier?: string, priorTier?: string|null, urlChanged: boolean, identity?: object}}
 */
function acceptRecoveredText(existing, candidate, ctx = {}) {
  const showId = ctx.showId || existing.showId;
  const newUrl = candidate.url || existing.url || '';
  const urlChanged = !!candidate.url && !!existing.url
    ? require('./url-change-invariant').urlCanonicallyChanged(existing.url, candidate.url)
    : (!!candidate.url && !existing.url);
  const refuse = (code, reason, extra = {}) => ({ accept: false, code, reason, urlChanged, ...extra });

  // 1. Records a person or a verdict owns are never overwritten by recovery.
  if (existing._locked === true) return refuse('locked', 'file is _locked');
  if (existing.manualContentTier) return refuse('manual_tier', `manualContentTier=${existing.manualContentTier} set by a person`);
  if (require('./incomplete-reason').isManuallyVerifiedAfterFetch(existing)) {
    return refuse('manually_verified', 'manually verified after the last fetch');
  }
  // duplicateOf is NOT here: the old gates recovered text onto duplicate rows
  // (dry-run 2026-11-08: 5 of 7 Stage recoveries were `unknown` duplicates) and
  // the rebuild folds them; refusing would change behaviour for no safety gain.
  if (existing.wrongShow || existing.wrongProduction) {
    return refuse('excluded_record', 'record is flagged wrongShow/wrongProduction');
  }
  if (ctx.blocklisted) return refuse('blocklisted', `url is in ${showId}/_blocklist.json`);

  // 2. Clean exactly once, the same way for every route.
  const cleaned = cleanCandidateText(candidate.rawText, { url: newUrl, showId });
  if (cleaned.refused) return refuse('multi_show_no_section', 'multi-show post: no unique section for this show');
  const text = cleaned.text;
  if (text.length < MIN_TEXT_CHARS) return refuse('too_short', `too short after cleaning (${text.length})`);

  // 3. Not a paywall / login / cookie wall / error page.
  const { isGarbageContent, validateShowMentioned, classifyContentTier } = require('./content-quality');
  const garbage = isGarbageContent(text);
  if (garbage.isGarbage) return refuse('garbage', `garbage content: ${garbage.reason}`);
  const wall = require('./paywall-detector').detectHardPaywall(text, newUrl);
  if (wall.detected) return refuse('paywall', `garbage content: paywall/login page (${wall.marker})`);

  // 4. Strictly longer than what is stored, both cleaned the same way.
  const priorLen = cleanedLength(existing.fullText);
  if (priorLen >= text.length) {
    return refuse('not_longer', `not longer than existing (${priorLen} >= ${text.length})`);
  }

  // 5. Identity: show named, not a different article, byline not contradicted,
  //    date plausible for this production.
  const showTitle = deriveShowTitle(showId);
  if (!validateShowMentioned(text, showTitle, showId).valid) {
    const hl = headlineIdentity({ outletId: existing.outletId, headline: candidate.headline, show: ctx.show, showTitle });
    if (!hl.ok) return refuse('show_not_mentioned', `show not mentioned: "${showTitle}"${hl.why ? ` (headline: ${hl.why})` : ''}`);
  }
  if (ctx.show) {
    const v = require('./wrong-article-screen').screenWrongArticle(text, ctx.show);
    // Same predicate safeWriteReview's BRO-4383 guard stamps wrongShow on.
    if (v.applicable && !v.sparseIdentity && v.suspect && v.titleMentions === 0) {
      return refuse('wrong_article', `wrong article: never names "${ctx.show.title}" and no cast/creative/venue evidence`);
    }
  }
  if (Array.isArray(ctx.knownCritics) && ctx.knownCritics.length) {
    const hit = require('./printed-byline-conflict').findPrintedBylineConflict({
      criticName: existing.criticName, fullText: text, knownCritics: ctx.knownCritics,
    });
    if (hit) return refuse('byline_conflict', `byline conflict: text is printed by ${hit.printedName}, file credits ${existing.criticName}`);
  }
  if (ctx.show && existing.publishDate) {
    const verdict = require('./date-plausibility').evaluateDatePlausibility({ review: existing, show: ctx.show });
    if (verdict.implausible) {
      return refuse('date_implausible', `date implausible: publishDate ${existing.publishDate} is ${verdict.daysBefore}d before earliest show date ${verdict.earliestDate} (likely wrong production — declare priorRuns if this is a legitimate earlier run)`);
    }
  }

  // 6. A new url must not be refused by the url-change rules and must be
  //    proven to be this review.
  let identity;
  if (urlChanged) {
    if (ctx.urlChangeRefusal) return refuse('url_change_refused', `url change refused: ${ctx.urlChangeRefusal}`);
    identity = proveIdentity(existing, text, newUrl, ctx);
    if (!identity.proven) return refuse('identity_unproven', `identity unproven for new url: ${identity.missing.join('; ')}`, { identity });
  }

  // 7. Tier: never invalid, never a downgrade.
  const priorTier = existing.contentTier || null;
  const tierResult = classifyContentTier({ ...existing, fullText: text, url: newUrl });
  const newTier = tierResult.contentTier || tierResult.tier;
  if (newTier === 'invalid') return refuse('tier_invalid', `garbage content: classifies invalid (${tierResult.tierReason || tierResult.reason || ''})`.trim());
  if (priorTier && TIER_RANK[priorTier] !== undefined && TIER_RANK[newTier] < TIER_RANK[priorTier]) {
    return refuse('tier_downgrade', `tier downgrade ${priorTier} -> ${newTier}`);
  }

  return {
    accept: true,
    code: 'accepted',
    reason: urlChanged ? `accepted at new url (${identity.via})` : 'accepted',
    cleanedText: text,
    newTier,
    newTierReason: tierResult.tierReason || tierResult.reason || null,
    priorTier,
    urlChanged,
    identity,
  };
}

/**
 * Did the write actually land the recovery? Pure: compares the record read
 * back from disk with what the gate accepted.
 * @param {object} landed  record on disk after the write
 * @param {{text: string, url: string}} expected
 * @param {{autoFlaggedWrongProduction?: boolean}} [writeResult]
 * @returns {{ok: boolean, why?: string}}
 */
function landedAsRecovered(landed, expected, writeResult = {}) {
  if (writeResult.autoFlaggedWrongProduction) return { ok: false, why: 'safeWriteReview auto-flagged wrongProduction' };
  if (!landed) return { ok: false, why: 'record unreadable after write' };
  if (landed.wrongShow || landed.wrongProduction) return { ok: false, why: 'the record was flagged wrongShow/wrongProduction' };
  if (landed.fullText !== expected.text) return { ok: false, why: 'fullText on disk is not the accepted text (rolled back)' };
  if (expected.url && landed.url !== expected.url) return { ok: false, why: `url on disk is ${landed.url}, not ${expected.url} (url change refused)` };
  return { ok: true };
}

/**
 * The LLM identity proof the gate accepts for a url move: content-verifier's
 * verifyContent() said valid with high confidence, from a model (not the
 * heuristic fallback), and flagged nothing.
 * @param {object|null} v  verifyContent() result
 * @returns {boolean}
 */
function llmIdentityVerdict(v) {
  if (!v || v.isValid !== true || v.confidence !== 'high') return false;
  if (v.wrongArticle || v.wrongProduction || v.isFilmTv) return false;
  return !!v.verifiedBy && !/^(heuristic|skip)/.test(String(v.verifiedBy));
}

// ── IO layer ────────────────────────────────────────────────────────────────

let _showsCache = null;
function getShowById(showId, showsPath) {
  if (!_showsCache || _showsCache.path !== showsPath) {
    const byId = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
      for (const s of (Array.isArray(parsed) ? parsed : (parsed.shows || []))) if (s && s.id) byId.set(s.id, s);
    } catch { /* checks needing the show no-op */ }
    _showsCache = { path: showsPath, byId };
  }
  return _showsCache.byId.get(showId) || null;
}

function defaultShowsPath() {
  if (process.env.SHOWS_JSON_PATH) return process.env.SHOWS_JSON_PATH;
  const local = path.join(__dirname, '..', '..', 'data', 'shows.json');
  return fs.existsSync(local) ? local : path.join(require('os').homedir(), 'broadway-scorecard-data', 'shows.json');
}

let _knownIndex = null;
function knownCriticsFor(outletId) {
  if (!_knownIndex) {
    const { buildKnownCriticsIndex } = require('./printed-byline-conflict');
    let registry = null;
    for (const p of [path.join(__dirname, '..', '..', 'data', 'outlet-registry.json'),
      path.join(require('os').homedir(), 'Broadwayscore', 'data', 'outlet-registry.json')]) {
      try { registry = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch { /* next */ }
    }
    _knownIndex = buildKnownCriticsIndex(registry);
  }
  return require('./printed-byline-conflict').knownCriticsForOutlet(_knownIndex, outletId);
}

function outletDomainsFor(outletId) {
  try {
    const { OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES } = require('./url-discovery');
    const d = OUTLET_DOMAINS[outletId];
    if (!d) return [];
    return [d, ...((REGISTRY_DOMAIN_ALIASES && REGISTRY_DOMAIN_ALIASES[d]) || [])];
  } catch { return []; }
}

/**
 * Everything acceptRecoveredText needs from disk, for one file + candidate.
 * @param {string} filePath
 * @param {object} existing
 * @param {string} candidateUrl
 * @param {{showsPath?: string, reviewTextsDir?: string, llmIdentityVerified?: boolean}} [opts]
 */
function buildAcceptanceContext(filePath, existing, candidateUrl, opts = {}) {
  const showDir = path.dirname(filePath);
  const showId = existing.showId || path.basename(showDir);
  const outletId = existing.outletId || path.basename(filePath).split('--')[0];
  const ctx = {
    showId,
    show: getShowById(showId, opts.showsPath || defaultShowsPath()),
    knownCritics: knownCriticsFor(outletId),
    llmIdentityVerified: opts.llmIdentityVerified === true,
  };
  const url = candidateUrl || existing.url;
  if (url) {
    const { loadBlocklist, isBlocked } = require('./poller-blocklist');
    ctx.blocklisted = isBlocked(loadBlocklist(showDir), url);
  }
  const { urlCanonicallyChanged, urlChangeRefusal } = require('./url-change-invariant');
  if (candidateUrl && (!existing.url || urlCanonicallyChanged(existing.url, candidateUrl))) {
    // Same preserve set recoverReviewText writes with: the review moved, its
    // aggregator excerpt/stars/score still describe it (rediscover-review-urls
    // rule), so the score-loss refusal must not count them as lost.
    const preserveFields = opts.preserveFields || new Set(require('./rediscovery-candidate').AGGREGATOR_FIELDS);
    const r = urlChangeRefusal(filePath, existing, candidateUrl, { preserveFields });
    ctx.urlChangeRefusal = r ? r.reason : null;
    ctx.outletDomains = outletDomainsFor(outletId);
    const { findCrossShowOwners } = require('./url-ownership');
    ctx.crossShowOwners = findCrossShowOwners(candidateUrl, showId, opts.reviewTextsDir || path.dirname(showDir));
  }
  return ctx;
}

/**
 * Lock, fresh read, gate, ONE write. URL + text + provenance land in the same
 * safeWriteReview call; nothing is written unless the gate accepted.
 *
 * @param {object} args
 * @param {string} args.filePath
 * @param {string} args.rawText
 * @param {string} [args.url]          where the text came from (omit = existing url)
 * @param {string|null} [args.expectUrl] the url on disk when the caller chose
 *                                     what to fetch. When given, a record whose url
 *                                     moved since (another writer) is refused, so
 *                                     old-page text never lands under a new url.
 * @param {{fetchMethod: string, sourceMethod: string, contentTierReasonFallback?: string, urlDiscoveryMethod?: string}} args.labels
 * @param {boolean} [args.dryRun]      decide only
 * @param {Set<string>} [args.tracker] absolute paths this run wrote (scoped staging);
 *                                     tracker.expected (Map) gets each path's landing key
 * @param {object} [args.ctxOpts]      buildAcceptanceContext opts
 * @param {(data: object, decision: object) => void} [args.beforeWrite] add score fields etc.
 * @returns {{ok: boolean, code: string, reason: string, newLen?: number, decision: object, write?: object}}
 */
function recoverReviewText({ filePath, rawText, url, headline = null, expectUrl, labels, dryRun = false, tracker, ctxOpts = {}, beforeWrite }) {
  const { withReviewTextsLock } = require('./review-texts-lock');
  const run = () => {
    const { readReviewForUpdate, persistReviewViaSafeWrite } = require('./persist-review-snapshot');
    const data = readReviewForUpdate(filePath);
    if (expectUrl !== undefined) {
      const disk = data.url || null;
      const exp = expectUrl || null;
      const moved = (!disk !== !exp) || (!!disk && require('./url-change-invariant').urlCanonicallyChanged(exp, disk));
      if (moved) {
        return { ok: false, code: 'url_moved_during_fetch', reason: `record url changed while fetching (${exp || 'none'} -> ${disk || 'none'})`, decision: null, dryRun };
      }
    }
    const ctx = buildAcceptanceContext(filePath, data, url, ctxOpts);
    const decision = acceptRecoveredText(data, { rawText, url, headline }, ctx);
    if (!decision.accept || dryRun) {
      return { ok: decision.accept, code: decision.code, reason: decision.reason, newLen: decision.cleanedText && decision.cleanedText.length, decision, dryRun };
    }
    const at = new Date().toISOString();
    const text = decision.cleanedText;
    data.textRecoveryProvenance = {
      priorFullTextHash: data.fullText ? sha256(data.fullText) : null,
      priorTextLength: (data.fullText || '').length,
      priorContentTier: data.contentTier || null,
      priorUrl: decision.urlChanged ? (data.url || null) : undefined,
      newFullTextHash: sha256(text),
      method: labels.sourceMethod,
      at,
    };
    if (decision.urlChanged) {
      if (data.url) data.previousUrl = data.url;
      data.url = url;
      data.urlDiscoveredAt = at;
      // Readers key on this (review-guards SERP_DISCOVERY_METHODS, abandonment
      // backfills, rediscovery-candidate repair); a stale value must not survive
      // the move (and a delete would be copied back by merge-mode safeWriteReview).
      data.urlDiscoveryMethod = labels.urlDiscoveryMethod || labels.sourceMethod;
    }
    const { countWords } = require('./content-quality');
    data.fullText = text;
    data.isFullReview = text.length > 1500;
    data.textWordCount = countWords(text);
    data.textFetchedAt = at;
    data.fetchMethod = labels.fetchMethod;
    data.sourceMethod = labels.sourceMethod;
    data.contentTier = decision.newTier;
    data.contentTierReason = decision.newTierReason || labels.contentTierReasonFallback || null;
    delete data.incompleteReason;
    delete data.incompleteDetail;
    if (beforeWrite) beforeWrite(data, decision);
    if (data.llmScore && data.llmScore.score) {
      require('./rescore-flagging').markRescoreNeeded(data, `fullText recovered via ${labels.sourceMethod}`, undefined, { requeue: true });
    }
    const write = persistReviewViaSafeWrite(
      { filePath, data, trailingNewline: true },
      decision.urlChanged ? { preserveUrlDerivedFields: require('./rediscovery-candidate').AGGREGATOR_FIELDS } : {},
    );
    if (tracker && write.wrote) tracker.add(path.resolve(filePath));
    if (!write.wrote) {
      if (tracker && tracker.expected) tracker.expected.delete(path.resolve(filePath));
      return { ok: false, code: 'write_refused', reason: `write refused by safeWriteReview (${write.skipped || 'unknown'})`, decision, write };
    }
    // safeWriteReview can still flag the record, or keep the old url and roll
    // the text back (regressed-swap / flip-flop paths) while returning
    // wrote:true. Only the record on disk says whether this was a recovery.
    const landed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const verdict = landedAsRecovered(landed, { text, url: decision.urlChanged ? url : landed.url }, write);
    if (!verdict.ok) {
      if (tracker && tracker.expected) tracker.expected.delete(path.resolve(filePath));
      return { ok: false, code: 'write_rolled_back', reason: `write landed but ${verdict.why}`, decision, write };
    }
    // The checkpoint confirms THIS text + url reached origin/main, not whatever
    // another writer left in the file by commit time.
    if (tracker && tracker.expected) tracker.expected.set(path.resolve(filePath), require('./review-texts-checkpoint').landingKey(landed));
    return { ok: true, code: 'accepted', reason: decision.reason, newLen: text.length, decision, write };
  };
  if (dryRun) return run();
  return withReviewTextsLock(`recover-text:${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`, run);
}

/**
 * LLM identity verdict for a text found at a NEW url (content-verifier). Only
 * asked when the cheap proofs did not settle identity. Never throws.
 */
async function verifyMovedReview({ filePath, show, showId, cleanedText, newUrl, log = console.log }) {
  const { verifyContent, resolveCvMarket } = require('./content-verifier');
  const { isLongRunningProduction } = require('./long-runner-registry');
  const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const s = show || {};
  try {
    // venue-write-guard-ok: venue is prompt context for verifyContent, never written to data.
    const v = await verifyContent({
      scrapedText: cleanedText,
      excerpt: review.excerpt || null,
      showTitle: s.title || showId,
      criticName: review.criticName || null,
      outletName: review.outlet || review.outletId || null,
      url: newUrl,
      venue: s.venue || null,
      openingDate: s.openingDate || null,
      publishDate: review.publishDate || null,
      market: resolveCvMarket(s),
      isLongRunningProduction: isLongRunningProduction(s),
      show: s,
    });
    return llmIdentityVerdict(v);
  } catch (e) {
    log(`    LLM identity check failed: ${String(e.message).slice(0, 120)}`);
    return false;
  }
}

/**
 * recoverReviewText with the paid steps OUTSIDE the lock: a decide-only pass;
 * when the only missing identity proof is the LLM verdict, ask it and decide
 * again; then (live) an optional async prepare step (score extraction) and the
 * locked write, which re-reads the file and re-runs the gate. Shared by
 * recover-serp-text.js and the gap-recovery driver (BRO-7171).
 *
 * @param {object} a  recoverReviewText args plus:
 * @param {object|null} [a.show]  shows.json record (LLM prompt context)
 * @param {(decision:object) => Promise<((data:object)=>void)|null>} [a.prepareWrite]
 * @returns {Promise<{ok:boolean, code:string, reason:string, newLen?:number, decision?:object, llmAsked?:boolean}>}
 */
async function recoverReviewTextVerified({ filePath, rawText, url, headline = null, expectUrl, labels, dryRun = false, tracker, ctxOpts = {}, show = null, prepareWrite, log = console.log }) {
  const base = { filePath, rawText, url, headline, expectUrl, labels, ctxOpts };
  let pre = recoverReviewText({ ...base, dryRun: true });
  let llmAsked = false;
  // identity_unproven is the one refusal an LLM verdict can overturn, and only
  // when the verdict is the ONLY missing proof (outlet domain, critic named and
  // no cross-show owner already hold); otherwise the paid call cannot help.
  const missing = (pre.decision && pre.decision.identity && pre.decision.identity.missing) || [];
  const onlyLlmMissing = missing.length === 1 && /no LLM identity verdict/.test(missing[0]);
  if (!pre.ok && pre.code === 'identity_unproven' && onlyLlmMissing) {
    if (dryRun) return { ok: false, code: 'dry_run_needs_llm', reason: 'would ask the LLM identity check, then write if it confirms', decision: pre.decision };
    const showId = path.basename(path.dirname(filePath));
    const cleaned = cleanCandidateText(rawText, { url, showId });
    if (!cleaned.refused) {
      llmAsked = true;
      const verified = await verifyMovedReview({ filePath, show, showId, cleanedText: cleaned.text, newUrl: url, log });
      pre = recoverReviewText({ ...base, ctxOpts: { ...ctxOpts, llmIdentityVerified: verified }, dryRun: true });
      if (verified) ctxOpts = { ...ctxOpts, llmIdentityVerified: true };
    }
  }
  if (!pre.ok || dryRun) return { ...pre, llmAsked };
  const beforeWrite = prepareWrite ? await prepareWrite(pre.decision) : null;
  const r = recoverReviewText({ ...base, ctxOpts, tracker, beforeWrite: beforeWrite || undefined });
  return { ...r, llmAsked };
}

module.exports = {
  acceptRecoveredText,
  headlineIdentity,
  pageHeadline,
  HEADLINE_IDENTITY_OUTLETS,
  recoverReviewText,
  recoverReviewTextVerified,
  verifyMovedReview,
  buildAcceptanceContext,
  deriveShowTitle,
  cleanCandidateText,
  proveIdentity,
  landedAsRecovered,
  llmIdentityVerdict,
  sha256,
  TIER_RANK,
  MIN_TEXT_CHARS,
};
