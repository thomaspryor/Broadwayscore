'use strict';
// BRO-7945 Part B. The same article is queued in _pending under every same-title production
// (ew--6aa1dc39.json under a-streetcar-named-desire-1973/-1988/-1992/-2005/-regional-2026).
// Two pure pieces so the drain stops paying for, and re-judging, the same URL once per copy:
//   makeFetchCache  one fetch per URL per run (a thrown error is cached too: no second paid try)
//   siblingForArticle  which same-title sibling production owns an out-of-window article

const { isArticleOutsideProductionWindow } = require('./date-guard');
const { normalizeTitle } = require('./title-match');

function makeFetchCache(fetchImpl) {
  const memo = new Map();
  let calls = 0;
  const wrapped = (url) => {
    calls++;
    if (!memo.has(url)) memo.set(url, Promise.resolve().then(() => fetchImpl(url)).then(
      (value) => ({ value }), (error) => ({ error })));
    return memo.get(url).then((r) => { if (r.error) throw r.error; return r.value; });
  };
  wrapped.stats = () => ({ unique: memo.size, calls, cacheHits: calls - memo.size });
  return wrapped;
}

/**
 * Other productions sharing this show's title, in ANY market (a regional entry can hold a copy of a Broadway
 * review), whose window decidably contains publishDate. An undated sibling never owns an article
 * (isArticleOutsideProductionWindow answers false when it cannot decide), and hasCopy must say the sibling's
 * copy is still live (not itself settled), so two copies can never settle onto each other.
 */
function siblingForArticle(show, allShows, publishDate, { hasCopy = () => true, isOutside = isArticleOutsideProductionWindow } = {}) {
  if (!show || !publishDate) return null;
  const key = normalizeTitle(show.title || '');
  if (!key) return null;
  for (const s of allShows || []) {
    if (!s || s.id === show.id || normalizeTitle(s.title || '') !== key) continue;
    if (!s.openingDate && !s.previewsStartDate) continue;
    if (!isOutside(s, publishDate) && hasCopy(s.id)) return s;
  }
  return null;
}

/**
 * Every OTHER same-title production whose window decidably contains publishDate. Pure.
 * siblingForArticle returns the first; BRO-8090 needs to know whether the owner is unique.
 */
function fittingSiblings(show, allShows, publishDate, { isOutside = isArticleOutsideProductionWindow } = {}) {
  if (!show || !publishDate) return [];
  const key = normalizeTitle(show.title || '');
  if (!key) return [];
  return (allShows || []).filter((s) => s && s.id !== show.id && normalizeTitle(s.title || '') === key
    && (s.openingDate || s.previewsStartDate) && !isOutside(s, publishDate));
}

/**
 * BRO-8090: what to do with a stub whose article date sits outside its own production's window.
 *   rehome     exactly one same-title sibling's window fits and the sibling does not hold the url -> move the stub there
 *   duplicate  that sibling already holds the url (live _pending copy, or a scored review)          -> settle, nothing is lost
 *   outside-all  no sibling fits (a real earlier/later run we do not track)                         -> settle as junk
 *   ambiguous  2+ siblings fit                                                                      -> settle, a human picks
 * A stub that was already rehomed once is never rehomed again (no ping-pong between two windows).
 * @param {{hasCopy?:(sid:string)=>boolean, holdsUrl?:(sid:string)=>boolean}} deps  hasCopy = sibling has a live _pending copy
 */
const FAMILY_NEEDS_VENUE = 3;
const SCREEN_URL_RE = /(?:^|[-_/])(?:film|films|movie|movies|tv|series|netflix|album|podcast|soundtrack)(?:[-_/.]|$)/i;
const VENUE_NOISE = new Set(['the', 'theatre', 'theater', 'of', 'at', 'and']);
/** The stub's url or excerpts name the sibling's venue (all of its distinctive words, in order). Pure. */
function stubNamesVenue(stub, sib) {
  const fold = (x) => normalizeTitle(String(x || '')).split(' ').filter(Boolean);
  const venue = fold(String((sib && sib.venue) || '').split('/')[0]).filter((w) => !VENUE_NOISE.has(w));
  if (!venue.length) return false;
  const hay = ' ' + fold([stub && stub.url, stub && stub.dtliExcerpt, stub && stub.bwwExcerpt, stub && stub.showScoreExcerpt, stub && stub.fullText].filter(Boolean).join(' ').replace(/[-_/.]/g, ' ')).join(' ') + ' ';
  return hay.includes(' ' + venue.join(' ') + ' ');
}

/**
 * The url path (never the host: broadwayworld.com, broadwaynews.com) names the sibling's market and the stub's own
 * show is in a different market: "oh-mary-broadway-review" filed under the West End run, "/westend/" under a tour.
 * "off-broadway" never counts as "broadway". Pure.
 */
function stubNamesMarket(stub, sib, show) {
  let p; try { p = new URL(String(stub && stub.url)).pathname.toLowerCase(); } catch { return false; }
  const words = p.split(/[^a-z0-9]+/).filter(Boolean);
  const cat = (x) => String((x && x.category) || '');
  if (cat(sib) === cat(show)) return false;
  if (cat(sib) === 'broadway') return words.some((w, i) => w === 'broadway' && words[i - 1] !== 'off');
  if (cat(sib) === 'west-end') return words.some((w, i) => (w === 'westend' || (w === 'end' && words[i - 1] === 'west')) && words[i - (w === 'end' ? 2 : 1)] !== 'off');
  return false;
}
/** The stub itself points at this sibling (its venue, or its market where the stub's own show is elsewhere). Pure. */
function stubCorroboratesSibling(stub, sib, show) { return stubNamesVenue(stub, sib) || stubNamesMarket(stub, sib, show); }

/**
 * BRO-8090 sample audit (2026-11-23): evidence on the stub that it is NOT the sibling's review, even though its date
 * fits the sibling's window. Two London reviews of the 2025 Lyric Hammersmith Ghosts were moved to the 2025 New York
 * Ghosts (Mitzi Newhouse) on date alone.
 *   outlet-market-mismatch  a single-market outlet (outlet-registry region, not dual-market) filed under its own
 *                           market's entry, while the sibling is in the other market group
 *   venue-mismatch          the slug names a venue ("-at-the-lyric-hammersmith-theatre-") that is not the sibling's
 * Returns the reason or null. Pure over the registry (loaded once; missing registry = no outlet evidence).
 */
let _outletMaps;
function outletMarketGroup(outletId) {
  if (_outletMaps === undefined) {
    try { _outletMaps = require('./outlet-region-map').buildOutletMaps(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'data', 'outlet-registry.json'), 'utf8'))); } catch { _outletMaps = null; }
  }
  if (!_outletMaps || !outletId) return null;
  const id = String(outletId).toLowerCase();
  if (_outletMaps.dualMarket.has(id)) return null;
  const region = _outletMaps.outletRegionMap[id];
  if (!region || region === 'dual') return null;
  return region === 'london' || region === 'uk' ? 'uk' : 'us';
}
const SLUG_VENUE_RE = /-at-(?:the-)?([a-z0-9]+(?:-[a-z0-9]+){0,3}?)-(?:theatre|theater|playhouse)(?:-|$)/;
function stubContradictsSibling(stub, sib, show) {
  if (!stub || !sib) return null;
  const want = MARKET_GROUP[sib.category];
  const have = outletMarketGroup(stub.outletId);
  // Only when the outlet's market is also where it was filed (a London outlet under a West End entry): a UK site
  // reviewing a Met Opera HD screening, filed under another Met entry, is moving within its own market.
  const filed = show ? MARKET_GROUP[show.category] : have;
  if (want && have && want !== have && filed === have) return 'outlet-market-mismatch';
  let slug = '';
  try { slug = `-${new URL(String(stub.url)).pathname.split('/').filter(Boolean).pop() || ''}-`.toLowerCase().replace(/\.html?-$/, '-'); } catch { return null; }
  const m = slug.match(SLUG_VENUE_RE);
  const named = m && require('./pending-triage').venuePhrase(m[1].replace(/-/g, ' '));
  const own = require('./pending-triage').venuePhrase(String(sib.venue || '').split('/')[0]);
  if (named && own && !named.includes(own) && !own.includes(named)) return 'venue-mismatch';
  return null;
}

const _titleIndexMemo = new WeakMap();
function _titlePhrases(allShows) {
  if (!_titleIndexMemo.has(allShows)) _titleIndexMemo.set(allShows, [...new Set((allShows || []).map((x) => normalizeTitle((x && x.title) || '')).filter(Boolean))]);
  return _titleIndexMemo.get(allShows);
}
const MARKET_GROUP = { broadway: 'us', 'off-broadway': 'us', 'west-end': 'uk', 'off-west-end': 'uk' };
/** Market groups the url path names: "broadway" (never "off-broadway") -> us, "west-end"/"westend" -> uk. Pure. */
function urlMarketGroups(url) {
  let p; try { p = new URL(String(url)).pathname.toLowerCase(); } catch { return new Set(); }
  const w = p.split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set();
  w.forEach((x, i) => {
    if (x === 'broadway' && w[i - 1] !== 'off') out.add('us');
    if ((x === 'westend' && w[i - 1] !== 'off') || (x === 'end' && w[i - 1] === 'west' && w[i - 2] !== 'off')) out.add('uk');
    if (x === 'tour' && w[i - 1] === 'uk') out.add('uk');
  });
  return out;
}
/**
 * BRO-8090 sample audit: the url itself says the article is about something else, so no date may move it.
 *   title-not-in-url  a worded slug that never names the title once the sibling's venue words are set aside
 *                     ("summer-holiday-review-...-crucible-sheffield" is not The Crucible)
 *   longer-title      the slug names a longer tracked title that contains this one ("romeo-and-juliet" is not & Juliet)
 * Opaque slugs (ids, dates) carry no evidence either way. Returns the reason or null. Pure.
 */
function urlContradictsTitle(stub, show, sib, allShows) {
  const V = require('./show-match-verifier');
  const url = stub && stub.url;
  if (!url || V.isOpaqueSlug(url)) return null;
  const toks = V.urlSlugTokens(url);
  const venueToks = normalizeTitle(String((sib && sib.venue) || '').split('/')[0]).split(' ').filter((w) => w && !VENUE_NOISE.has(w));
  const pathPhrase = ' ' + toks.join(' ') + ' ';
  const left = [...toks];
  if (venueToks.length && pathPhrase.includes(' ' + venueToks.join(' ') + ' ')) for (const v of venueToks) { const i = left.indexOf(v); if (i >= 0) left.splice(i, 1); }
  const need = V.titleTokens(show.title);
  if (need.length && !need.every((t) => left.includes(t))) return 'title-not-in-url';
  const mine = normalizeTitle(show.title || '');
  if (mine && need.length) {
    // A longer tracked title holding every word of this one, all of whose words the slug carries: "romeo-juliet-review"
    // and "romeo-and-juliet-review" are Romeo and Juliet, not & Juliet.
    for (const t of _titlePhrases(allShows)) {
      if (t === mine) continue;
      const tt = V.titleTokens(t);
      if (tt.length > need.length && need.every((w) => tt.includes(w)) && tt.every((w) => toks.includes(w))) return 'longer-title';
    }
  }
  // "minions-and-monsters-review" is not The Monsters: the title's first word joined to a preceding word by "and".
  const titleWords = mine.split(' ').filter((w) => w && w !== 'the' && w !== 'a');
  if (titleWords.length && titleWords[0] !== 'and') {
    const i = toks.indexOf(titleWords[0]);
    if (i >= 2 && (toks[i - 1] === 'and' || toks[i - 1] === 'amp') && !['review', 'reviews', 'theatre', 'theater'].includes(toks[i - 2])) return 'compound-title';
  }
  // A travel-section piece with no stage word ("intrepid-travel-tokyo-...-kyoto-osaka-tour-review") is not the play.
  let segs = []; try { segs = new URL(String(url)).pathname.toLowerCase().split('/').filter(Boolean); } catch { /* */ }
  if (segs[0] === 'travel' && !/theat|stage|musical|opera|ballet|play|panto|show/.test(segs[segs.length - 1] || '')) return 'travel-not-stage';
  return null;
}

/**
 * The sibling's own no-fetch triage would settle the stub at once (a forum thread, a box-office story, its url date):
 * moving it there gains nothing. Judged with the verdict date. No allShows, so it never recurses. Pure.
 */
function siblingTriageJunk(stub, sib, publishDate) {
  if (!stub || !stub.url) return null;
  const bare = { ...stub }; if (publishDate) bare.publishDate = publishDate;
  for (const k of ['promoteSkippedReason', 'promoteSkippedAt', 'promoteSettled', 'promoteSettledSibling']) delete bare[k];
  const t = require('./pending-triage').triagePendingStub(bare, { showId: sib.id, show: sib });
  return t.verdict === 'junk' ? t.reason : null;
}

/**
 * Every url-level reason a stub must NOT be moved to sib, for routes that picked sib without a date (the venue in
 * the slug): undated sibling, a url naming the other market, a screen adaptation, a url about another title, or
 * the sibling's own triage. Returns the reason or null. Pure.
 */
function siblingRehomeBlocker(stub, show, sib, allShows, publishDate) {
  if (!sib || !(sib.openingDate || sib.previewsStartDate)) return 'sibling-undated';
  const groups = urlMarketGroups(stub && stub.url);
  if (groups.size && MARKET_GROUP[sib.category] && !groups.has(MARKET_GROUP[sib.category])) return 'market-mismatch';
  if (stub && stub.url && SCREEN_URL_RE.test(stub.url)) return 'screen-not-stage';
  const against = stubContradictsSibling(stub, sib, show);
  if (against) return against;
  const contra = urlContradictsTitle(stub, show, sib, allShows);
  if (contra) return contra;
  if (stub && stub.rehomedFrom) return 'already-rehomed';
  return siblingTriageJunk(stub, sib, publishDate);
}

function resolveOutOfWindowStub({ show, allShows, publishDate, stub, hasCopy = () => false, holdsUrl = () => false }) {
  const fitByDate = fittingSiblings(show, allShows, publishDate);
  if (fitByDate.length === 0) return { kind: 'outside-all', sibling: null };
  // A url that names a market rules out a sibling in the other one ("oedipus-broadway-..." is not the West End run).
  const groups = urlMarketGroups(stub && stub.url);
  let fit = groups.size ? fitByDate.filter((s) => !MARKET_GROUP[s.category] || groups.has(MARKET_GROUP[s.category])) : fitByDate;
  if (fit.length === 0) return { kind: 'market-mismatch', sibling: null, candidates: fitByDate.map((s) => s.id) };
  const contradicted = fit.map((s) => stubContradictsSibling(stub, s, show));
  if (contradicted.every(Boolean)) return { kind: contradicted[0], sibling: null, candidates: fit.map((s) => s.id) };
  fit = fit.filter((_, i) => !contradicted[i]);
  const contra = urlContradictsTitle(stub, show, fit.length === 1 ? fit[0] : null, allShows);
  if (contra) return { kind: contra, sibling: null, candidates: fit.map((s) => s.id) };
  // A screen adaptation of the same title (Matilda film, Jersey Boys film) dated inside a stage run is not a review of it.
  if (stub && stub.url && SCREEN_URL_RE.test(stub.url)) return { kind: 'screen-not-stage', sibling: null, candidates: fit.map((s) => s.id) };
  // A title many productions share (A Christmas Carol: 9 tracked, dozens untracked) can land in a sibling's window
  // by coincidence (a Dundee Rep review dated inside the Old Vic run). In such a family the date alone is not
  // enough: the stub must also point at the sibling (its venue, or its market: "oh-mary-broadway-review").
  // An open-ended sibling (no closingDate: Harry Potter on Broadway, the 2017 Met Tosca with no dates) matches almost
  // any later date, so it needs the same corroboration. 2+ fitting siblings are told apart the same way
  // (Operation Mincemeat Broadway vs West End: "operation-mincemeat-broadway-review").
  const family = (allShows || []).filter((s) => s && s.id !== show.id && normalizeTitle(s.title || '') === normalizeTitle(show.title || '')).length;
  const needsCorroboration = (s) => fit.length > 1 || family >= FAMILY_NEEDS_VENUE || !s.closingDate || !(s.previewsStartDate || s.openingDate);
  let sib = fit[0];
  if (needsCorroboration(sib)) {
    const named = fit.filter((s) => stubCorroboratesSibling(stub, s, show));
    if (named.length !== 1) return { kind: fit.length > 1 ? 'ambiguous' : 'unverified-family', sibling: null, candidates: fit.map((s) => s.id) };
    sib = named[0];
    // Corroboration can pick a different sibling than the one the url-contradiction check saw (it only sees a
    // sibling when exactly one fit): re-check the slug against the one we are about to move it to.
    if (fit.length > 1) {
      const c2 = urlContradictsTitle(stub, show, sib, allShows);
      if (c2) return { kind: c2, sibling: null, candidates: [sib.id] };
    }
  }
  if (hasCopy(sib.id) || holdsUrl(sib.id)) return { kind: 'duplicate', sibling: sib.id };
  if (stub && stub.rehomedFrom) return { kind: 'ambiguous', sibling: null, candidates: [sib.id] };
  const junk = siblingTriageJunk(stub, sib, publishDate);
  if (junk) return { kind: 'junk-for-sibling', sibling: null, candidates: [sib.id], reason: junk };
  return { kind: 'rehome', sibling: sib.id };
}

/**
 * The stub as it must sit in the sibling's _pending: new showId, the date the verdict was reached on,
 * the old settle cleared (the sibling's drain judges it afresh), and the origin recorded. Pure.
 */
/**
 * Flags the OLD show's checks stamped because the article was judged against the wrong production (its date was
 * "before this show's earliest date", "a sibling's review"). Against the owning sibling they are false, and a
 * kept wrongProduction stamp would silently exclude a real review after the move. Human stamps are kept. Mutates.
 */
const AUTO_WRONG_PRODUCTION_RE = /^Auto-flagged|days before show earliest date|cross-production|url date|Unknown critic|published .* before/i;
function stripForeignShowFlags(o) {
  if (!o) return o;
  if (/^(date_implausible|cross_market)/.test(String(o.pendingReason || ''))) delete o.pendingReason;
  delete o._dateImplausibleDetail; delete o._crossMarketDetail;
  const human = o.wrongProductionManual || o.humanReviewed || o.manualReview || /manual|owner|human/i.test(String(o.wrongProductionSource || ''));
  if (o.wrongProduction && !human && AUTO_WRONG_PRODUCTION_RE.test(String(o.wrongProductionNote || ''))) {
    delete o.wrongProduction; delete o.wrongProductionNote;
    require('./wrongproduction-provenance').dropWrongProductionProvenance(o); // BRO-7575: no orphaned provenance
  }
  return o;
}

function rehomedStub(stub, fromShowId, toShowId, { publishDate, nowIso } = {}) {
  const out = stripForeignShowFlags({ ...stub, showId: toShowId, rehomedFrom: fromShowId, rehomedAt: nowIso || new Date().toISOString() });
  delete out.promoteSkippedReason; delete out.promoteSkippedAt; delete out.promoteSettled; delete out.promoteSettledSibling;
  delete out.pendingFetchAttemptedAt; delete out.pendingFetchAttemptResult;
  if (publishDate) { out.publishDate = publishDate; out.dateSource = 'rehome-verdict-date'; }
  return out;
}

/**
 * Intake side (BRO-8090 root cause): a discovered review is filed under the show whose TITLE matched, so the same
 * article was queued under every same-title production and settled out-of-window under the wrong one. Route it to
 * the unique sibling whose window holds its date at write time. Returns the show id to file under. Pure.
 */
function intakeShowIdForStub(show, allShows, publishDate, stub) {
  if (!show || !publishDate || !isArticleOutsideProductionWindow(show, publishDate)) return show && show.id;
  const r = resolveOutOfWindowStub({ show, allShows, publishDate, stub });
  return r.kind === 'rehome' ? r.sibling : show.id;
}

/** Same article: the canonical normalized url (tracking params dropped). Pure. */
function sameArticleUrl(a, b) {
  const n = require('./pending-triage').normalizeReviewUrl;
  return !!a && !!b && n(a) === n(b);
}

/**
 * The sibling's _pending already carries THIS url under the same file name (file names are outlet--critic or
 * outlet--hash, so a same-named file can be a different article). Reads the file. Pure over fsImpl.
 */
function siblingHoldsSameUrl({ root, toShowId, file, url, fsImpl = require('fs') }) {
  const p = require('path').join(root, '_pending', toShowId, file);
  try { return sameArticleUrl(JSON.parse(fsImpl.readFileSync(p, 'utf8')).url, url); } catch { return false; }
}

/**
 * Move a stub to the sibling's _pending. Never overwrites: the copy is written to a temp file and hard-linked into
 * place (link fails if the name exists, so two drain shards racing on one destination cannot both win, and a crash
 * never leaves a half-written destination), then the source is removed. A same-named destination holding the SAME
 * url = 'sibling-has-copy' (the caller settles the source as a duplicate); a different article under that name gets
 * a url-hash suffixed name instead. Returns 'rehomed' | 'sibling-has-copy'.
 */
function rehomeStubFile({ root, file, fromShowId, toShowId, data, publishDate, nowIso, dry = false, fsImpl = require('fs') }) {
  const path = require('path');
  const dir = path.join(root, '_pending', toShowId);
  const body = JSON.stringify(rehomedStub(data, fromShowId, toShowId, { publishDate, nowIso }), null, 2);
  const hash = require('crypto').createHash('sha1').update(String(data && data.url)).digest('hex').slice(0, 8);
  const names = [file, file.replace(/\.json$/, `--${hash}.json`)];
  for (const name of names) {
    const dest = path.join(dir, name);
    if (fsImpl.existsSync(dest)) {
      if (siblingHoldsSameUrl({ root, toShowId, file: name, url: data && data.url, fsImpl })) return 'sibling-has-copy';
      continue;
    }
    if (dry) return 'rehomed';
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
    fsImpl.writeFileSync(tmp, body);
    try { fsImpl.linkSync(tmp, dest); } catch (e) {
      fsImpl.unlinkSync(tmp);
      if (e.code === 'EEXIST') { if (siblingHoldsSameUrl({ root, toShowId, file: name, url: data && data.url, fsImpl })) return 'sibling-has-copy'; continue; }
      throw e;
    }
    fsImpl.unlinkSync(tmp);
    fsImpl.unlinkSync(path.join(root, '_pending', fromShowId, file));
    return 'rehomed';
  }
  return 'sibling-has-copy';
}

module.exports = { stubContradictsSibling, outletMarketGroup, stripForeignShowFlags, siblingRehomeBlocker, siblingTriageJunk, sameArticleUrl, siblingHoldsSameUrl, urlContradictsTitle, urlMarketGroups, stubNamesMarket, stubCorroboratesSibling, stubNamesVenue, rehomeStubFile, makeFetchCache, siblingForArticle, fittingSiblings, resolveOutOfWindowStub, rehomedStub, intakeShowIdForStub };
