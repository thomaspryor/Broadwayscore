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
const MIN_MATERIAL_GAIN_CHARS = 100;
const MIN_MATERIAL_GAIN_FRAC = 0.03;
const EXCERPT_IDENTITY_MIN = 0.5;
// Stored partial text long enough to be a fingerprint of the article (not a pull quote).
const PRIOR_TEXT_IDENTITY_MIN_CHARS = 400;
const PRINT_IDENTITY_MIN_COVERAGE = 0.25;
const PRINT_IDENTITY_MIN_SHARED = 30;

/**
 * Distinct 5-word runs of `normPrior` found in `normPage`, and that as a
 * fraction of the prior's runs. No length precondition: excerptCoverage
 * returns 0 unless the page is 1.5x the excerpt, and a print text can be
 * nearly the whole review (BRO-7171: Nine Night, 2,647 print chars vs a
 * 2,665-char page). Pure.
 */
function sharedShingles(normPage, normPrior) {
  const grams = (t) => { const w = t.split(' ').filter(Boolean); const s = new Set(); for (let i = 0; i + 5 <= w.length; i++) s.add(w.slice(i, i + 5).join(' ')); return s; };
  const a = grams(normPage);
  const b = grams(normPrior);
  let n = 0;
  for (const g of b) if (a.has(g)) n++;
  return { shared: n, coverage: b.size ? n / b.size : 0 };
}

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

const { novelProseChars, novelProseVerdict, MIN_NOVEL_PROSE_CHARS, MIN_NOVEL_PROSE_FRAC } = require('./novel-prose');

function cleanedLength(text) {
  if (typeof text !== 'string' || !text) return 0;
  const { cleanText, stripTrailingJunk } = require('./text-cleaning');
  return stripTrailingJunk(cleanText(text)).length;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function surnameOf(criticName) {
  // Theatre Record scans join names ("AndrzejLukowski", "MichaelArditti":
  // ~228 files, 2026-11-10): split a run-together camel-case name first.
  const raw = String(criticName || '').split(/[,(]/)[0].trim();
  const name = /\s/.test(raw) ? raw : raw.replace(/([a-z]{2})([A-Z][a-z])/g, '$1 $2');
  const s = name.split(/\s+/).pop() || '';
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
  const owners = (ctx.crossShowOwners || []).filter((o) => o && o.blocking !== false);
  // The print text we already hold (Theatre Record's archive: attribution
  // comes from the print page, never from a web url that could be wrong) is a
  // fingerprint of the article. Only on the outlet's own site with no other
  // show owning the url, and only with dozens of shared 5-word runs, so a
  // roundup quoting a line or a copy on another site cannot pass
  // (BRO-7171: 463 of the 780 no-url reviews hold Theatre Record text, and
  // Telegraph/Mail bodies never print the critic's name). Scans merge
  // neighbouring columns into the stored text, so a true match can sit under
  // half coverage (the real Telegraph "Julie" page: 0.41, 80 shared runs).
  // Because of that merge, the text alone cannot tell this critic's column
  // from the neighbouring critic's page (ship-check P0: a neighbour fixture
  // passed at 0.54), and sibling outlets share a domain (telegraph and
  // sunday-telegraph). So the page's OWN byline (JSON-LD/meta author) must
  // name the critic too; no byline, or another name, is not proof.
  const prior = String(existing.fullText || '');
  const surname = surnameOf(existing.criticName);
  const missing = [];
  if (existing.source === 'theatre-record' && prior.length >= PRIOR_TEXT_IDENTITY_MIN_CHARS && onOutletDomain && owners.length === 0) {
    const { normText } = require('./cloned-excerpt-guard');
    const { shared, coverage: cov } = sharedShingles(normText(cleaned), normText(prior));
    if (cov >= PRINT_IDENTITY_MIN_COVERAGE && shared >= PRINT_IDENTITY_MIN_SHARED) {
      const byline = ctx.pageByline ? String(ctx.pageByline) : '';
      if (surname && byline && stripMarks(byline).includes(stripMarks(surname))) {
        return { proven: true, via: `stored theatre-record text: ${shared} shared 5-word runs, coverage ${cov.toFixed(2)}; page byline "${byline}"` };
      }
      missing.push(byline ? `page byline "${byline}" is not ${existing.criticName || 'the critic'}` : 'print text matches but the page has no byline to confirm the critic');
    }
    best = Math.max(best, cov);
  }

  const named = !!surname && stripMarks(cleaned).includes(stripMarks(surname));
  const llm = ctx.llmIdentityVerified === true;
  if (onOutletDomain && named && owners.length === 0 && llm) {
    return { proven: true, via: 'outlet domain + critic named + no cross-show owner + LLM verified' };
  }
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

/** The page's own author credit (reviewer line, JSON-LD, meta, byline markup), or null. */
function pageByline(html, outletId) {
  if (!html || typeof html !== 'string') return null;
  try { return require('./byline-extraction').extractByline(html, { outletId }) || null; } catch { return null; }
}

/** The page's own publish date (JSON-LD, meta, dateline; never the url), or null. */
function pagePublishDate(html, url) {
  if (!html || typeof html !== 'string') return null;
  try { return require('./html-publish-date').extractPublishDateFromHtml(html, url) || null; } catch { return null; }
}

// A page published this long after a closed show's last night reviews a later
// production (BRO-7171 ramp: a 2022 Daniel Craig "Macbeth" review matched the
// mis-filed macbeth-1982 record; a 2016 EW review matched robber-bridegroom-1976).
const DAYS_IMPLAUSIBLE_AFTER_CLOSING = 365;

/**
 * Is the page's own date plausible for this production? Before: the shared
 * 180-day rule (priorRuns/tour legs honoured). After: more than a year past a
 * closed show's closing date. Pure.
 * @returns {string|null} refusal reason, or null when plausible/unknown
 */
function pageDateRefusal(pageDate, existing, show) {
  if (!pageDate || !show) return null;
  const { evaluateDatePlausibility, parsePlausibilityDate } = require('./date-plausibility');
  const before = evaluateDatePlausibility({ review: { ...existing, publishDate: pageDate, dateSource: 'html-page' }, show });
  if (before.implausible) return `page dated ${pageDate}, ${before.daysBefore}d before the show's earliest date ${before.earliestDate}`;
  const pub = parsePlausibilityDate(pageDate);
  const closed = show.closingDate ? parsePlausibilityDate(show.closingDate) : null;
  if (pub && closed && !(show.status && /^(open|previews)$/i.test(show.status))) {
    const daysAfter = Math.round((pub.getTime() - closed.getTime()) / 86400000);
    const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');
    if (daysAfter > DAYS_IMPLAUSIBLE_AFTER_CLOSING && !isWithinPriorRun(pub, show.priorRuns) && !isWithinTourLeg(pub, show.tourLegs)) {
      return `page dated ${pageDate}, ${daysAfter}d after the show closed ${show.closingDate}`;
    }
  }
  return null;
}

/** The page's own headline: og:title, else the first <h1>. Never the url. */
function pageHeadline(html) {
  if (!html || typeof html !== 'string') return null;
  const decode = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  // The closing quote must match the opening one: "Peter Shaffer's Equus" is one title.
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=(["'])((?:(?!\1).)+)\1/i.exec(html)
    || /<meta[^>]+content=(["'])((?:(?!\1).)+)\1[^>]*property=["']og:title["']/i.exec(html);
  if (og && decode(og[2])) return decode(og[2]);
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
  // normalizeTitle drops bracketed text, and The Stage brackets part of some
  // titles ("Tartuffe (Remixed)"), so also read the headline with brackets unwrapped.
  const forms = [...new Set([headline, String(headline).replace(/[()[\]]/g, ' ')].map((x) => ` ${normalizeTitle(x)} `))];
  const named = titles.some((t) => { const n = normalizeTitle(t); return n.length >= 3 && forms.some((h) => h.includes(` ${n} `)); });
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
  // The shows.json title, not the slug: the slug gives "life of pi tour",
  // "n a" (N/A) and "44" (44 - The Obama Musical), which no review prints, so
  // every tour / punctuated title was refused show_not_mentioned (Stage 4
  // WaPo live batch 2026-11-09: 6 of 20). The slug form is only the fallback.
  const showTitle = (ctx.show && ctx.show.title) || deriveShowTitle(showId);
  let identityHeadline = null;
  if (!validateShowMentioned(text, showTitle, showId).valid) {
    const hl = headlineIdentity({ outletId: existing.outletId, headline: candidate.headline, show: ctx.show, showTitle });
    if (!hl.ok) return refuse('show_not_mentioned', `show not mentioned: "${showTitle}"${hl.why ? ` (headline: ${hl.why})` : ''}`);
    identityHeadline = String(candidate.headline).trim();
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
    // The new page's own date must fit this production (a mis-filed record
    // must not pull in a later revival's review).
    const late = pageDateRefusal(candidate.pageDate, existing, ctx.show);
    if (late) return refuse('date_implausible', `date implausible: ${late} (likely another production)`);
    identity = proveIdentity(existing, text, newUrl, { ...ctx, pageByline: candidate.pageByline || null });
    if (!identity.proven) return refuse('identity_unproven', `identity unproven for new url: ${identity.missing.join('; ')}`, { identity });
  } else if (existing.fabricatedEntry === true) {
    // The stored url and critic of an invented row were an LLM's guess: a
    // page at that url (a Wayback capture, a live page) proves nothing until
    // the same identity rule as a new url passes; the accept clears the flag.
    identity = proveIdentity(existing, text, newUrl, { ...ctx, pageByline: candidate.pageByline || null });
    if (!identity.proven) return refuse('identity_unproven', `identity unproven at the invented stored url: ${identity.missing.join('; ')}`, { identity });
  }

  // 7. Tier: never invalid, never a downgrade.
  const priorTier = existing.contentTier || null;
  const tierResult = classifyContentTier({ ...existing, fullText: text, url: newUrl });
  const newTier = tierResult.contentTier || tierResult.tier;
  if (newTier === 'invalid') return refuse('tier_invalid', `garbage content: classifies invalid (${tierResult.tierReason || tierResult.reason || ''})`.trim());
  if (priorTier && TIER_RANK[priorTier] !== undefined && TIER_RANK[newTier] < TIER_RANK[priorTier]) {
    return refuse('tier_downgrade', `tier downgrade ${priorTier} -> ${newTier}`);
  }
  // 8. Material gain (BRO-7171 Stage 3, first nightly: 12 of 60 accepts gained
  //    under 50 chars, e.g. 2487 -> 2489 bytes, still truncated). A same-tier
  //    re-fetch that adds a few characters recovers nothing: it would burn the
  //    nightly ceiling and be reported to the owner as a recovered review.
  const tierUp = !priorTier || TIER_RANK[priorTier] === undefined || TIER_RANK[newTier] > TIER_RANK[priorTier];
  // A record with no url that gets its first, identity-proven url gains the
  // url itself (the review's NO_URL gap closes, and clean web text replaces an
  // OCR scan), so the text-gain bars do not apply. BRO-7171: Theatre Record
  // often prints nearly the whole Telegraph review (Nine Night +19 chars,
  // Strictly Ballroom +49), and those real links were being refused.
  const firstUrl = !existing.url && !!candidate.url && !!identity && identity.proven === true;
  if (firstUrl) {
    return {
      accept: true, code: 'accepted', reason: `accepted: first url for a no-url record (${identity.via})`, cleanedText: text,
      newTier, newTierReason: tierResult.tierReason || tierResult.reason || null, priorTier, urlChanged, identity, identityHeadline,
    };
  }
  const minGain = Math.max(MIN_MATERIAL_GAIN_CHARS, Math.ceil(priorLen * MIN_MATERIAL_GAIN_FRAC));
  if (priorLen > 0 && !tierUp && text.length - priorLen < minGain) {
    return refuse('not_materially_longer', `not materially longer than existing (+${text.length - priorLen} chars, need ${minGain} or a better tier)`);
  }
  // 9. The gain must be new prose, not page chrome (Stage 4). A tier-up is no
  //    exemption: chrome that ends in a full stop (a cookie banner, a booking
  //    line) flips truncated -> complete. Ship-check audit 2026-11-09: all 16
  //    tier-up accepts under this bar were chrome or a repeated review.
  if (priorLen > 0) {
    const v = novelProseVerdict(existing.fullText, text);
    if (!v.ok) {
      return refuse('not_materially_longer', `no material new prose (${v.novel} chars of new prose, need ${v.need}); the gain is page chrome`);
    }
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
    identityHeadline,
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
  } else if (existing.fabricatedEntry === true && url) {
    // An invented-url row needs identity proof even at its stored url
    // (acceptRecoveredText step 6), so the proof inputs are needed here too.
    ctx.outletDomains = outletDomainsFor(outletId);
    ctx.crossShowOwners = require('./url-ownership').findCrossShowOwners(url, showId, opts.reviewTextsDir || path.dirname(showDir));
  }
  return ctx;
}

/**
 * May an invented-url flag (fabricatedEntry) clear after the collector stored
 * text from a SERP-found url? (BRO-7171 item b: the collector cleared it when
 * the search returned, before any fetch or proof.) Same identity proof as
 * acceptRecoveredText step 6. `preDiscovery` is the record as it was BEFORE the
 * url flip cleared its old excerpts/print text, since those are the proof inputs.
 * @returns {{clear:boolean, via:string|null, reason:string}}
 */
function fabricatedFlagClearDecision({ filePath, preDiscovery, fetchedText, url, html = null, llmVerified = false, reviewTextsDir = null }) {
  if (!preDiscovery || preDiscovery.fabricatedEntry !== true) return { clear: false, via: null, reason: 'not flagged' };
  if (!url || !fetchedText) return { clear: false, via: null, reason: 'no url or text' };
  const ctx = buildAcceptanceContext(filePath, preDiscovery, url, { llmIdentityVerified: llmVerified === true, reviewTextsDir: reviewTextsDir || undefined });
  ctx.pageByline = pageByline(html, preDiscovery.outletId);
  const showId = preDiscovery.showId || path.basename(path.dirname(filePath));
  const cleaned = cleanCandidateText(fetchedText, { url, showId }).text || '';
  const p = proveIdentity(preDiscovery, cleaned, url, ctx);
  return p.proven
    ? { clear: true, via: p.via, reason: 'identity proven' }
    : { clear: false, via: null, reason: `identity unproven: ${(p.missing || []).join('; ')}` };
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
function recoverReviewText({ filePath, rawText, url, headline = null, pageDate = null, pageByline = null, expectUrl, labels, dryRun = false, tracker, ctxOpts = {}, beforeWrite }) {
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
    const decision = acceptRecoveredText(data, { rawText, url, headline, pageDate, pageByline }, ctx);
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
    // An invented-url row (fabricatedEntry) whose real review the gate just
    // proved: the flag (clear-only, review-field-edit) goes false with its
    // breadcrumb, or the rebuild keeps skipping the recovered review.
    if (data.fabricatedEntry === true) {
      data.fabricatedEntry = false;
      data.fabricatedClearedReason = `real review text accepted at ${data.url} (${labels.sourceMethod}, ${at}); was: ${data.fabricatedReason || 'flagged'}`;
      data.fabricatedReason = null;
    }
    // Accepted on the page's own headline (body never prints the title): persist that
    // evidence so evaluateShowMentionGuard does not re-flag the body as wrong-show.
    if (decision.identityHeadline) data.showIdentityHeadline = decision.identityHeadline;
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
    // An outage is not a "no": the caller must not record the url as refused
    // (ship-check P1: a missing key or API error blacklisted the right link).
    log(`    LLM identity check failed: ${String(e.message).slice(0, 120)}`);
    return null;
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
async function recoverReviewTextVerified({ filePath, rawText, url, headline = null, pageDate = null, pageByline = null, expectUrl, labels, dryRun = false, tracker, ctxOpts = {}, show = null, prepareWrite, log = console.log }) {
  const base = { filePath, rawText, url, headline, pageDate, pageByline, expectUrl, labels, ctxOpts };
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
      if (verified === null) {
        return { ok: false, code: 'identity_check_unavailable', reason: 'LLM identity check unavailable (error, not a verdict); try this link again later', decision: pre.decision, llmAsked: true };
      }
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
  fabricatedFlagClearDecision,
  surnameOf,
  pagePublishDate,
  pageByline,
  pageDateRefusal,
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
  novelProseChars,
  MIN_NOVEL_PROSE_CHARS,
  MIN_NOVEL_PROSE_FRAC,
  novelProseVerdict,
};
