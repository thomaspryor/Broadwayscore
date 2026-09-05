/**
 * playbill-title-match.js — decide whether a Playbill /production/ URL names
 * the SAME title as one of our shows.
 *
 * BRO-2821. `scorePlaybillUrl()` in scripts/validate-show-venue.js requires the
 * URL's title segment to normalize EXACTLY to the show's title, and requires a
 * market keyword segment ("-broadway-", "-london-", …) to delimit that segment.
 * Measured against the 107 live entries in data/playbill-urls.json — a durable
 * cache written by discover-playbill-urls.js and read by findPlaybillUrl BEFORE
 * the scorer, so those URLs are correct but were never judged by it — 92 pass
 * and 15 do not. All 15 are correct URLs. A show in one of those shapes with no
 * cache entry resolves to 'no-playbill-url' forever.
 *
 * The 15, re-derived from the live cache rather than inherited from the card:
 *   10  legacy URLs with NO market segment — five `…-vault-<digits>` pages and
 *       five `…-YYYY-YYYY` season pages, three of which glue the title straight
 *       onto the venue ("hadestownwalter-kerr-theatre-2018-2019") and two of
 *       which keep a leading "the-" our normalizer strips.
 *    3  subtitle-delimiter disagreements — our title carries a ":" subtitle
 *       Playbill drops ("Doubt: A Parable" -> "doubt", "Purlie Victorious: A
 *       Non-Confederate Romp Through the Cotton Patch" -> "purlie-victorious"),
 *       or Playbill spells out a parenthetical our normalizer drops
 *       ("Two Strangers (Carry a Cake Across New York)").
 *    2  prefix drops — a leading "&" ("& Juliet" -> "juliet") and a leading
 *       series brand ("Encores! La Cage Aux Folles" -> "la-cage-aux-folles").
 *
 * WHY NOT TOKEN CONTAINMENT. The obvious relaxation — accept when one title's
 * token run contains the other's — is unsafe, and the corpus rules it out:
 * across 2,416 distinct normalized titles there are 392 strict token-run
 * containment pairs. "& Juliet" is contained in "Romeo and Juliet", so the one
 * relaxation that would RECOVER it is the same one that would let it collide.
 * Likewise SIX/Six Degrees of Separation, Home/Fun Home, Oedipus/Oedipus Rex.
 *
 * So every branch is driven by an EXPLICIT DELIMITER in our own raw title (a
 * ":", a "(", a leading "&", a leading "<Word>!"), never by generic
 * containment, and each relaxation carries its own independent check:
 *   - lossless forms ADD text, so they cannot reach a different show and need
 *     no corroboration;
 *   - lossy forms REMOVE text, so they additionally require the URL to name
 *     this show's VENUE;
 *   - the legacy branch cannot isolate a title segment at all, so it requires
 *     the URL body to decompose exactly into <our title form><a known venue>.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. "Giant" must not match "giant-the-play",
 * and an earlier draft of this file accepted it by treating an appended
 * "-the-play" as lossless. It is not: normalizeTitle() strips a trailing
 * "the musical" but NOT "the play", so the two are distinct titles in this
 * corpus and Playbill uses the longer one for a different production. The
 * "-the-musical" form survives only as a legacy PREFIX candidate, where it is
 * compared against the raw URL body and normalization does not apply.
 */

// venue-write-guard-ok: this module is READ-ONLY with respect to venues. It never
// writes shows.json, reviews.json or any other data file — it only reads a venue
// slug back out of a URL path in order to DECIDE whether that URL names a given
// show. The `venue:` key the guard flags (legacyDecomposes' return) is a
// diagnostic describing which corpus venue slug the URL body decomposed into, so
// callers and tests can assert WHY a legacy match fired.
//
// Traced in review: legacyDecomposes returns `{ form: f, venue: rest }`,
// playbillUrlTitleMatch renames it to `corroboration.venueSlugInUrl`, and
// scorePlaybillUrl reads only `match` and `branch` — the slug itself is DISCARDED
// there, not transformed. The audit ledger records the selected URL and the venue
// parsed from Playbill's own page, never this value. sanitizeVenueForWrite() would
// be meaningless: there is no write to guard, and sanitizing a comparison
// diagnostic would corrupt the thing it exists to explain.
//
// COST OF THIS MARKER, stated so the next reader does not have to discover it:
// the guard scopes exemptions per FILE, not per line, so any genuine venue write
// added to this module in future passes unnoticed. A line-scoped exemption would
// be preferable and the guard does not support one. Keep this module free of
// venue writes; if one ever belongs here, delete this marker first.
const { normalizeTitle } = require('./title-match');

/** Words that carry no venue identity on their own. */
const VENUE_NOUNS = new Set(['theatre', 'theater', 'the', 'at', 'and', 'of']);

/** Normalize a slug or a title to the canonical hyphenated comparison form. */
function normSlug(s) {
  return normalizeTitle(String(s || '').replace(/-/g, ' ')).replace(/\s+/g, '-');
}

/** Slugify a raw venue name without any aliasing. */
function venueSlug(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[''""‘’“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The tokens of a venue that actually identify it. "Todd Haimes Theatre" ->
 * ["haimes"], "New York City Center" -> ["center"], "Music Box Theatre" ->
 * ["music"]. Short tokens are dropped because a 3-4 letter substring test
 * against a URL is close to free ("new", "box", "york" all appear widely).
 *
 * canonicalVenue() from title-match.js is NOT used here: it returns the first
 * distinctive token of the CURRENT canonical name ("New Amsterdam Theatre" ->
 * "new", "Virginia Theatre" -> "august wilson" via the alias table), so it is
 * neither a slug nor stable against a venue rename, and both properties matter
 * when the URL was minted under the venue's older name.
 */
function venueTokens(v) {
  return venueSlug(v)
    .split('-')
    .filter((t) => t.length >= 5 && !VENUE_NOUNS.has(t));
}

/**
 * Every form of a show title we are willing to see in a Playbill slug, derived
 * from DELIMITERS PRESENT IN THE RAW TITLE. A title with no ":", no "(", no
 * leading "&" and no leading "<Word>!" yields only its exact form, so this
 * cannot loosen the 92 cache entries that already pass.
 */
function titleForms(rawTitle) {
  const title = String(rawTitle || '').trim();
  const exact = normSlug(title);
  const lossless = new Set();
  const lossy = new Set();
  if (!exact) return { exact: '', lossless: [], lossy: [], legacyPrefixes: [] };

  // "(…)" — normalizeTitle drops parentheticals; Playbill spells them out.
  if (/[()]/.test(title)) {
    const spelled = normSlug(title.replace(/[()]/g, ' '));
    if (spelled) lossless.add(spelled);
  }

  // ":" or an en/em-dash subtitle. Both directions: Playbill may drop the
  // subtitle (lossy — we shorten to the head) or carry the whole thing
  // (lossless — we lengthen). The TAIL alone is never a form; "A Parable"
  // must not match anything.
  const parts = title.split(/\s*:\s+|\s+[–—]\s+/);
  if (parts.length > 1 && parts[0].trim()) {
    const head = normSlug(parts[0]);
    if (head) lossy.add(head);
    const whole = normSlug(title.replace(/[:–—]/g, ' '));
    if (whole) lossless.add(whole);
  }

  // Leading "&" — we slug "& Juliet" as "and-juliet", Playbill as "juliet".
  if (/^\s*&\s*\S/.test(title)) {
    const dropped = normSlug(title.replace(/^\s*&\s*/, ''));
    if (dropped) lossy.add(dropped);
  }

  // Leading series brand ending in "!" — "Encores! La Cage Aux Folles". The
  // "!" must follow the FIRST word and be followed by more words, so a title
  // that simply ends in an exclamation ("Oklahoma!", "Moulin Rouge! The
  // Musical") produces no lossy form.
  const brand = title.match(/^\s*[A-Za-z][A-Za-z'’.]*!\s+(\S.*)$/);
  if (brand) {
    const dropped = normSlug(brand[1]);
    if (dropped) lossy.add(dropped);
  }

  lossless.delete(exact);
  lossy.delete(exact);
  for (const f of lossless) lossy.delete(f);

  // Legacy URLs are matched against the RAW body, where normalization never
  // runs — so the "-the-musical" suffix normalizeTitle would have stripped has
  // to be re-added as an explicit prefix candidate ("six-the-musical…",
  // "mj-the-musical…"). It is confined to this list on purpose: as a general
  // accepted form it would make "Giant" match "giant-the-play".
  //
  // LOSSY FORMS ARE DELIBERATELY EXCLUDED. An earlier version included them and
  // it was wrong: the legacy branch's whole justification is that decomposing a
  // body into <title><known venue> is self-corroborating, and that argument
  // holds for a form that carries the FULL title, not for one that has had a
  // subtitle or a leading token cut off. With lossy forms in the list, the show
  // "CATS: The Jellicle Ball" accepted a vault URL for plain "cats", and
  // "Seagull: True Story" accepted one for "the-seagull" — both new 2026
  // provisional stubs, which is precisely the population CLAUDE.md rule 3 aims
  // this validator at. Measured: excluding them takes cross-title legacy accepts
  // from 45 to 1 and changes live-cache recovery not at all (106/107 either
  // way), because none of the 10 legacy cache owners has a subtitle.
  const legacyPrefixes = [exact, `${exact}-the-musical`, ...lossless];

  return { exact, lossless: [...lossless], lossy: [...lossy], legacyPrefixes };
}

/**
 * Does the URL independently name this show's venue or year? Venue is the
 * strong signal and is what gates the lossy branch; the year is reported
 * separately so callers can see which fired.
 */
function urlCorroboratesShow(url, show) {
  const u = String(url || '').toLowerCase();
  const toks = venueTokens(show && show.venue);
  const venueHit = toks.some((t) => u.includes(t));
  const years = collectYears(show);
  return {
    venueHit,
    yearHit: [...years].some((y) => u.includes(y)),
    venueTokens: toks,
  };
}

function collectYears(show) {
  const years = new Set();
  for (const src of [show && show.id, show && show.openingDate]) {
    const y = String(src || '').match(/\b(?:19|20)\d{2}\b/);
    if (y) years.add(y[0]);
  }
  return years;
}

/**
 * Corroboration for the LOSSY branch, searched only in the part of the URL that
 * FOLLOWS the title segment.
 *
 * urlCorroboratesShow() scans the whole URL, and for a lossy match that is
 * circular: the title's own text can supply the "venue" evidence that is
 * supposed to be independent of it. Found in adversarial review. Concretely,
 * the show "Music: A New Story" at the Music Box Theatre has exactly one venue
 * identity token, "music" — so it accepted
 * /production/music-broadway-other-venue-theatre-2026, a page at a different
 * house, because its own shortened title matched the venue test. The gate read
 * as satisfied while nothing outside the title had agreed to anything.
 *
 * The tail is where the venue and year actually live in a Playbill slug, so
 * requiring the hit there is both stricter and closer to the real grammar.
 */
function tailCorroboratesShow(tail, show) {
  const t = String(tail || '').toLowerCase();
  const toks = venueTokens(show && show.venue);
  const venueHit = toks.some((x) => t.includes(x));
  const yearHit = [...collectYears(show)].some((y) => t.includes(y));
  return { venueHit, yearHit, venueTokens: toks, searchedTail: t };
}

const MARKET_SEGMENT_RE =
  /\/production\/([a-z0-9-]+?)-(?:off-)?(?:broadway|regional|tour|west-end|london)-/;
const MARKET_KEYWORD_RE =
  /-(?:off-)?(?:broadway|regional|tour|west-end|london)-/g;

/**
 * Every title segment the URL could be read as — one per market keyword in the
 * path, shortest first.
 *
 * MARKET_SEGMENT_RE is lazy, so it stops at the FIRST market keyword, and a
 * market word inside a TITLE is therefore read as the delimiter: a show called
 * "1536" matched a URL for one called "1536 West End", because the lazy group
 * took "1536" and treated the title's own "-west-end-" as the market segment.
 * That is the only cross-title acceptance the corpus sweep found under realistic
 * conditions. Considering every split point RECOVERS the correct reading — the
 * longer "1536-west-end" is now offered too, so a show genuinely titled "1536
 * West End" matches its own URL — but it does NOT remove the collision, and an
 * earlier version of this comment wrongly claimed it did. Every candidate
 * segment is still offered to the form test, so the short reading "1536" still
 * matches a show titled "1536". Closing that needs the DATA fixed (BRO-2886:
 * one corpus entry's title absorbed its market), not a stricter matcher — the
 * collision is between two corpus titles, and it predates this module.
 */
function marketTitleSegments(u) {
  const at = u.indexOf('/production/');
  if (at === -1) return [];
  const path = u.slice(at + '/production/'.length);
  const segs = [];
  MARKET_KEYWORD_RE.lastIndex = 0;
  let m;
  while ((m = MARKET_KEYWORD_RE.exec(path)) !== null) {
    const head = path.slice(0, m.index);
    // The tail is everything from the market keyword onward — where the venue
    // and year live. It is carried alongside the head so the lossy branch can
    // demand its corroboration from OUTSIDE the title it just shortened.
    if (head && /^[a-z0-9-]+$/.test(head)) segs.push({ head, tail: path.slice(m.index) });
    // Overlapping keywords ("-off-broadway-" also contains "-broadway-") must
    // not be skipped past, so advance one character rather than to lastIndex.
    MARKET_KEYWORD_RE.lastIndex = m.index + 1;
  }
  return segs;
}
// Legacy shapes carrying no market segment: a vault page, or a "-YYYY-YYYY"
// season page. Anchored at the end so a modern URL can never take this branch.
const LEGACY_RE =
  /\/production\/([a-z0-9-]+?)(?:-vault-\d+|-(?:19|20)\d{2}-(?:19|20)\d{2})$/;

/**
 * The legacy body must decompose EXACTLY into <one of our title forms> followed
 * by <a venue slug we recognise>, with an optional leading "the-" (which
 * normalizeTitle strips from our side but Playbill keeps) and with no separator
 * required between the two halves (three live URLs glue them:
 * "hadestownwalter-kerr-theatre").
 *
 * The decomposition IS the corroboration, which is why this branch does not
 * also demand a venue/year match: a vault URL carries no year, and for a show
 * that transferred or whose house was renamed the URL names the ORIGINAL venue
 * (Chicago's vault page says Richard Rodgers, our record says Ambassador; King
 * Hedley II's says Virginia, now the August Wilson). Requiring the URL to agree
 * with today's venue would refuse exactly those correct entries. Requiring it
 * to end in SOME known venue instead is what keeps "giant" from swallowing
 * "giant-the-play-…": "the-play-…" is not a venue.
 *
 * `knownVenueSlugs` is supplied by the caller (a Set of slugified venue names)
 * so this module never reads data/shows.json itself. With no set supplied the
 * branch refuses rather than falling back to a bare prefix test.
 */
function legacyDecomposes(body, forms, knownVenueSlugs) {
  if (!knownVenueSlugs || !knownVenueSlugs.size) return null;
  const bodies = body.startsWith('the-') ? [body, body.slice(4)] : [body];
  const candidates = [...new Set(forms.legacyPrefixes)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // "six-the-musical" before "six"
  for (const b of bodies) {
    for (const f of candidates) {
      if (!b.startsWith(f)) continue;
      const rest = b.slice(f.length).replace(/^-/, '');
      if (rest && knownVenueSlugs.has(rest)) return { form: f, venue: rest };
    }
  }
  return null;
}

/**
 * Decide whether `url` names the same title as `show`.
 *
 * Returns { match, branch, form, corroboration }. `branch` is one of
 * 'exact' | 'lossless' | 'lossy' | 'legacy' | null so callers and tests can
 * assert WHICH rule fired, not merely that something did.
 *
 * Title-only by design: market routing, the venue bonus and the year bonus stay
 * in scorePlaybillUrl. This replaces only its title hard filter.
 *
 * @param {object} [opts]
 * @param {Set<string>} [opts.knownVenueSlugs] enables the legacy branch.
 */
function playbillUrlTitleMatch(url, show, opts = {}) {
  const u = String(url || '')
    .toLowerCase()
    .replace(/[?#].*$/, '');
  const forms = titleForms(show && show.title);
  const miss = { match: false, branch: null, form: null, corroboration: null };
  if (!forms.exact) return miss;

  const rawSegs = marketTitleSegments(u);
  if (rawSegs.length) {
    const segs = rawSegs.map((s) => ({ form: normSlug(s.head), tail: s.tail })).filter((s) => s.form);
    const exactHit = segs.find((s) => s.form === forms.exact);
    if (exactHit) {
      return { match: true, branch: 'exact', form: forms.exact, corroboration: null };
    }
    const losslessHit = segs.find((s) => forms.lossless.includes(s.form));
    if (losslessHit) {
      return { match: true, branch: 'lossless', form: losslessHit.form, corroboration: null };
    }
    // Try EVERY lossy reading, not just the first: a URL can offer more than one
    // split point, and only one of them may carry the venue in its tail.
    for (const s of segs) {
      if (!forms.lossy.includes(s.form)) continue;
      const c = tailCorroboratesShow(s.tail, show);
      // Venue specifically, not "venue or year": a lossy form is a SHORTENING
      // of our title, so it can land on a genuinely different production that
      // happens to open the same year. Sharing the same house is far rarer.
      if (c.venueHit) return { match: true, branch: 'lossy', form: s.form, corroboration: c };
    }
    return miss;
  }

  const legacy = u.match(LEGACY_RE);
  if (!legacy) return miss;
  const hit = legacyDecomposes(legacy[1], forms, opts.knownVenueSlugs);
  if (!hit) return miss;
  return {
    match: true,
    branch: 'legacy',
    form: hit.form,
    corroboration: { venueSlugInUrl: hit.venue },
  };
}

module.exports = {
  normSlug,
  venueSlug,
  venueTokens,
  titleForms,
  urlCorroboratesShow,
  tailCorroboratesShow,
  legacyDecomposes,
  playbillUrlTitleMatch,
  MARKET_SEGMENT_RE,
  LEGACY_RE,
  VENUE_NOUNS,
};
