'use strict';

/**
 * tr-roundup-match.js — map a theatre.reviews round-up post to ONE of our
 * London shows (BRO-6084).
 *
 * The old path (extractTitleFromSlug + matchTitleToShow, or title-only
 * pickTheatreReviewsRoundupFromAnchors) attached round-ups to the wrong
 * production: Waiting for Godot 2017 got the 2024 round-up, Much Ado 2022 the
 * 2025 one, The Seagull 2022 the Blanchett 2025 one. A round-up is published
 * within days of press night, so the production is identified by title AND
 * the post date against the show's opening, with the venue in the slug as a
 * tiebreak. No confident match returns { unmatched: reason }, never a guess.
 */

const { normalizeTitle } = require('./title-match');

const DAY_MS = 86400000;
// A round-up appears after press night (reviews land 0-3 days later, TR posts
// in the following days and sometimes weeks). Slightly negative covers press
// nights that precede the post by a timezone/embargo hair.
const WINDOW_BEFORE_DAYS = 10;
const WINDOW_AFTER_DAYS = 60;
// Medium confidence (word-set title match, or venue disagreement) only inside
// this tighter window: two productions of one title opening 6 weeks apart is
// effectively unheard of, a stale same-title revival is not.
const TIGHT_AFTER_DAYS = 35;

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'at', 'on', 'to', 'for', 'with', 'by', 'as']);
// Slug/venue tokens that say nothing about which house it is.
const VENUE_NOISE = new Set(['theatre', 'theater', 'the', 'london', 'west', 'end', 'of', 'at', 'playhouse']);

function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8217;|&#8216;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-')
    .replace(/&amp;|&#038;/g, '&')
    .replace(/&#\d+;/g, ' ');
}

function words(s) {
  return normalizeTitle(s).split(' ').filter(Boolean);
}

/**
 * Headline with the "Theatre reviews roundup:" boilerplate and the trailing
 * average-rating badge ("3.7★") removed.
 */
function cleanRoundupTitle(raw) {
  return decodeEntities(raw)
    .replace(/^\s*(?:theatre\s+)?reviews?\s*round-?\s*up\s*[:\-–—]*\s*/i, '')
    .replace(/^\s*theatre\s+reviews?\s*[:\-–—]+\s*/i, '')
    .replace(/\s*\d(?:\.\d)?\s*[★⭑*]\s*$/u, '')
    .replace(/\s*\((?:revised|revival|2\d{3})\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Post (WP REST row) → what the matcher needs. */
function parseRoundupPost(post) {
  const url = post && typeof post.link === 'string' ? post.link : '';
  const slug = String((post && post.slug) || url.replace(/\/+$/, '').split('/').pop() || '');
  const date = post && post.date ? String(post.date).slice(0, 10) : null;
  const title = cleanRoundupTitle(post && post.title && (post.title.rendered ?? post.title));
  const modified = post && (post.modified_gmt || post.modified) ? String(post.modified_gmt || post.modified) : null;
  const venue = venueFromContent(post && post.content && (post.content.rendered ?? post.content));
  return { id: post && post.id != null ? post.id : null, url, slug, date, title, modified, ...(venue ? { venue } : {}) };
}

/**
 * The venue TR prints under the headline (first <h5>). The slug can name the
 * wrong house ("sorry-prime-minister-adelphi" is an Apollo show), so a body
 * venue, when we have it, outranks the slug for the venue check.
 */
function venueFromContent(html) {
  const m = String(html || '').match(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
  if (!m) return null;
  const v = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return v && v.length <= 80 ? v : null;
}

function slugWords(slug) {
  return String(slug || '').replace(/-reviews?$/, '').split('-').filter(Boolean);
}

function venueTokens(v) {
  const t = String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/['\u2018\u2019]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w && !VENUE_NOISE.has(w));
  // TR writes "sohoplace" for Soho Place.
  if (t.length >= 2) t.push(t[0] + t[1]);
  return t;
}

/**
 * A body venue names the house when every word of one of its parts is in the
 * show's venue. One shared word is not enough: "Lyric Hammersmith" shares
 * "lyric" with the Lyric Theatre, "Theatre Royal Haymarket" shares "royal"
 * with Drury Lane.
 */
function bodyVenueHit(bodyVenue, showTokens) {
  return String(bodyVenue).split(/\s*\/\s*|\s+at the\s+/i).some((part) => {
    const t = venueTokens(part);
    if (!t.length) return false;
    const joined = t.length >= 2 ? t[t.length - 1] : null; // synthesized "sohoplace"
    const core = joined ? t.slice(0, -1) : t;
    return core.every((w) => showTokens.has(w)) || (joined != null && showTokens.has(joined));
  });
}

const NATIONAL_HOUSES = ['national', 'olivier', 'lyttelton', 'dorfman', 'cottesloe'];

function showVenueTokens(show) {
  const t = new Set(venueTokens(show.venue));
  // "Lyttelton Theatre (National Theatre)": the parenthetical names the complex
  // TR uses in slugs ("-national-"), so it counts too.
  const par = String(show.venue || '').match(/\(([^)]*)\)/);
  if (par) venueTokens(par[1]).forEach((w) => t.add(w));
  if (NATIONAL_HOUSES.some((h) => t.has(h))) NATIONAL_HOUSES.forEach((h) => t.add(h));
  return t;
}

/** Slug tokens that are not part of the show title = the venue/cast suffix. */
function slugExtraTokens(roundup, showTitleWords) {
  const tw = new Set(showTitleWords);
  return slugWords(roundup.slug).filter((w) => !tw.has(w) && !STOP.has(w) && !/^\d+$/.test(w));
}

// "Wings" vs "Wing": plural-only differences do not make a different title.
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const sameWord = (a, b) => a === b || stem(a) === stem(b);

function titleMatchKind(show, roundup) {
  const sw = words(show.title);
  if (!sw.length) return null;
  const tw = words(roundup.title);
  const slw = words(slugWords(roundup.slug).join(' '));
  const phrase = (hay) => {
    for (let i = 0; i + sw.length <= hay.length; i++) {
      if (sw.every((w, j) => sameWord(hay[i + j], w))) return true;
    }
    return false;
  };
  if (phrase(tw) || phrase(slw)) return 'phrase';
  const sig = sw.filter((w) => !STOP.has(w));
  if (sig.length >= 2 && sig.every((w) => tw.some((x) => sameWord(x, w)) || slw.some((x) => sameWord(x, w)))) return 'words';
  // TR drops subtitles ("Thelma & Louise" for "Thelma and Louise: A New
  // Musical", "Hunger Games" for "The Hunger Games On Stage"): every
  // significant word of the round-up headline is in our title.
  const rsig = tw.filter((w) => !STOP.has(w));
  if (rsig.length >= 2 && rsig.every((w) => sw.some((x) => sameWord(x, w)))) return 'subset';
  return null;
}

function openingMs(show) {
  const t = Date.parse(show.openingDate || '') || Date.parse(show.previewsStartDate || '');
  return Number.isFinite(t) ? t : null;
}

/**
 * Date windows a round-up for this show can fall in beyond the opening
 * window: the whole run of a long-running show (Tina 2018-2025 has round-ups
 * for later casts) and every declared prior run (a tour or transfer of the
 * same production, shows.json priorRuns).
 */
function extraWindows(show) {
  const out = [];
  const om = openingMs(show);
  let cm = Date.parse(show.closingDate || '');
  // An open show with no announced closing runs until today.
  if (!Number.isFinite(cm) && show.status === 'open') cm = Date.now();
  if (om != null && Number.isFinite(cm) && cm > om) out.push({ start: om, end: cm, kind: 'in-run' });
  for (const r of Array.isArray(show.priorRuns) ? show.priorRuns : []) {
    const rs = Date.parse(r && r.openingDate || '');
    if (!Number.isFinite(rs)) continue;
    const re = Date.parse(r.closingDate || '');
    out.push({ start: rs, end: Number.isFinite(re) && re > rs ? re : rs, kind: 'prior-run', venue: r.venue }); // venue-write-guard-ok: in-memory match window, nothing written to shows.json
  }
  return out;
}

function idYear(show) {
  const m = String(show.id || '').match(/-(\d{4})$/);
  return m ? Number(m[1]) : null;
}

/**
 * @param {{date, title, slug, url}} roundup parseRoundupPost() output
 * @param {Array<object>} shows London-market shows.json rows
 * @returns {{show: object, confidence: 'high'|'medium', reasons: string[]} | {unmatched: string, candidates?: string[]}}
 */
function matchRoundupToShow(roundup, shows) {
  const postMs = Date.parse(roundup.date || '');
  const cands = [];
  for (const show of shows) {
    if (!show || !show.id || !show.title) continue;
    const kind = titleMatchKind(show, roundup);
    if (!kind) continue;
    cands.push({ show, kind, titleWords: words(show.title).length });
  }
  if (!cands.length) return { unmatched: 'no show with this title' };

  // Strongest kind of title match first, then the most specific title
  // ("Richard III" over a hypothetical "Richard").
  // A longer matching title beats a shorter one whatever the kind ("A Good
  // House" over the one-word "Good"); kind breaks ties.
  const RANK = { phrase: 3, words: 2, subset: 1 };
  const sigWords = (c) => words(c.show.title).filter((w) => !STOP.has(w)).length;
  // A 'subset' match (headline words all inside a longer title) never outranks
  // a title the headline names in full.
  const full = cands.filter((c) => c.kind !== 'subset');
  const base = full.length ? full : cands;
  const maxSig = Math.max(...base.map(sigWords));
  const longest = base.filter((c) => sigWords(c) === maxSig);
  const bestRank = Math.max(...longest.map((c) => RANK[c.kind]));
  const ranked = longest.filter((c) => RANK[c.kind] === bestRank);
  const maxWords = Math.max(...ranked.map((c) => c.titleWords));
  const pool = ranked.filter((c) => c.titleWords === maxWords);
  const ids = pool.map((c) => c.show.id);

  const slugWordsList = slugWords(roundup.slug);
  // Extra windows (in-run, prior-run) are a fallback: they only apply when no
  // same-title show opens inside the round-up's own window, otherwise a long
  // run would make every same-title round-up ambiguous.
  const scoreAll = (useExtras) => pool.map((c) => {
    const reasons = [`title:${c.kind}`];
    const vt = showVenueTokens(c.show);
    // A venue read from the post body beats the slug (the slug can be wrong).
    const bodyTokens = roundup.venue ? venueTokens(roundup.venue) : [];
    let venueHit = bodyTokens.length ? bodyVenueHit(roundup.venue, vt) : slugWordsList.some((w) => vt.has(w));
    const extras = bodyTokens.length
      ? bodyTokens.filter((w) => !STOP.has(w))
      : slugExtraTokens(roundup, words(c.show.title).concat(slugWordsList.filter((w) => STOP.has(w))));
    // The slug (or body) names a venue we recognise for a DIFFERENT house.
    let venueKnownElsewhere = !venueHit && vt.size > 0 && extras.length > 0 && extras.some((w) => VENUE_SLUG_TOKENS.has(w));
    if (venueHit) reasons.push('venue');
    const om = openingMs(c.show);
    let days = null;
    let dateOk = false;
    let tight = false;
    if (om != null && Number.isFinite(postMs)) {
      days = Math.round((postMs - om) / DAY_MS);
      dateOk = days >= -WINDOW_BEFORE_DAYS && days <= WINDOW_AFTER_DAYS;
      tight = days >= -WINDOW_BEFORE_DAYS && days <= TIGHT_AFTER_DAYS;
      reasons.push(`opening:${days >= 0 ? '+' : ''}${days}d`);
      if (!dateOk && useExtras) {
        const w = extraWindows(c.show).find((x) => postMs >= x.start - WINDOW_BEFORE_DAYS * DAY_MS && postMs <= x.end + WINDOW_AFTER_DAYS * DAY_MS);
        if (w) {
          dateOk = true;
          days = Math.round((postMs - w.start) / DAY_MS);
          tight = days >= -WINDOW_BEFORE_DAYS && days <= TIGHT_AFTER_DAYS;
          reasons.push(w.kind);
          // A prior run was at its own house: judge the venue against that one.
          // A touring prior run played many houses: no single venue to veto on.
          if (w.kind === 'prior-run' && /\btour\b/i.test(w.venue || '')) {
            venueKnownElsewhere = false;
          } else if (w.kind === 'prior-run' && w.venue && (bodyTokens.length || slugWordsList.length)) {
            const pvt = new Set(venueTokens(w.venue));
            const toks = bodyTokens.length ? bodyTokens : slugWordsList;
            venueHit = bodyTokens.length ? bodyVenueHit(roundup.venue, pvt) : toks.some((x) => pvt.has(x));
            venueKnownElsewhere = !venueHit && extras.length > 0 && extras.some((x) => VENUE_SLUG_TOKENS.has(x));
          }
        }
      }
    } else {
      const y = idYear(c.show);
      if (y && Number.isFinite(postMs) && String(y) === String(roundup.date).slice(0, 4)) reasons.push('id-year');
    }
    return { ...c, reasons, venueHit, venueKnownElsewhere, days, dateOk, tight, undated: om == null };
  });

  let scored = scoreAll(false);
  if (!scored.some((x) => x.dateOk)) {
    const withExtras = scoreAll(true);
    if (withExtras.some((x) => x.dateOk)) scored = withExtras;
  }
  const dated = scored.filter((s) => s.dateOk);
  let chosen = null;
  let confidence = null;

  if (dated.length) {
    let best = dated;
    const venueMatched = best.filter((s) => s.venueHit);
    if (best.length > 1 && venueMatched.length) best = venueMatched;
    if (best.length > 1) {
      // Same title, same window, venue silent: the closest opening wins only
      // when it is clearly closer (> 14 days apart), otherwise ambiguous.
      best = best.slice().sort((a, b) => Math.abs(a.days) - Math.abs(b.days));
      if (Math.abs(best[1].days) - Math.abs(best[0].days) <= 14) {
        return { unmatched: 'ambiguous: several shows with this title open in the window', candidates: best.map((s) => s.show.id) };
      }
    }
    chosen = best[0];
    const strong = chosen.kind === 'phrase' && !chosen.venueKnownElsewhere;
    if (strong) confidence = 'high';
    else if (chosen.tight && (chosen.venueHit || !chosen.venueKnownElsewhere)) confidence = 'medium';
    else return { unmatched: chosen.venueKnownElsewhere ? 'venue in slug disagrees with the show' : 'title only partly matches', candidates: [chosen.show.id] };
  } else {
    // Nothing inside a date window. Distinguish "wrong production" from "our
    // show has no dates" so the report says what to fix.
    const undated = scored.filter((s) => s.undated);
    if (undated.length === 1 && scored.length === 1 && undated[0].venueHit && undated[0].kind === 'phrase') {
      chosen = undated[0];
      confidence = 'medium';
      chosen.reasons.push('undated-show-unique-title+venue');
    } else if (undated.length && undated.length === scored.length) {
      return { unmatched: 'matching show has no opening date to check the production against', candidates: ids };
    } else {
      const near = scored.filter((s) => s.days != null).map((s) => `${s.show.id}:${s.days}d`);
      return { unmatched: `no production of this title opened near the round-up date (${near.join(', ') || 'no dated show'})`, candidates: ids };
    }
  }

  return { show: chosen.show, confidence, reasons: chosen.reasons };
}

// Venue words TR puts in slugs; lets a slug naming another house veto a
// title-only match. Not exhaustive on purpose: an unknown token never vetoes.
const VENUE_SLUG_TOKENS = new Set([
  'national', 'almeida', 'donmar', 'bridge', 'barbican', 'hampstead', 'hampstead', 'menier', 'marylebone',
  'riverside', 'globe', 'palladium', 'garrick', 'coliseum', 'adelphi', 'gielgud', 'wyndhams', 'wyndham',
  'apollo', 'savoy', 'lyric', 'dominion', 'duchess', 'harold', 'pinter', 'vaudeville', 'noel', 'coward',
  'ambassadors', 'criterion', 'novello', 'sondheim', 'lyceum', 'aldwych', 'phoenix', 'trafalgar', 'olivier',
  'dorfman', 'lyttelton', 'court', 'kiln', 'arcola', 'bush', 'soho', 'sohoplace', 'park', 'hackney',
  'southwark', 'playhouse', 'richmond', 'orange', 'tree', 'jermyn', 'ambassador', 'cottesloe', 'swan',
  'sadlers', 'sadler', 'wells', 'haymarket', 'shaftesbury', 'prince', 'edward', 'wales', 'cambridge',
  'victoria', 'palace', 'vic', 'old', 'young', 'royal', 'albery', 'harold', 'queens', 'fortune',
]);

/**
 * Match every post; one show can own at most one round-up (the closest to its
 * opening wins, later ones are reported as duplicates, never merged).
 * @returns {{matched: Array, unmatched: Array}}
 */
function matchAllRoundups(posts, shows, pins = {}) {
  const matched = [];
  const unmatched = [];
  for (const raw of posts) {
    const roundup = raw && raw.slug !== undefined && raw.title && typeof raw.title === 'string' ? raw : parseRoundupPost(raw);
    const r = pinnedMatch(roundup, shows, pins) || matchRoundupToShow(roundup, shows);
    if (r.show) matched.push({ roundup, show: r.show, confidence: r.confidence, reasons: r.reasons });
    else unmatched.push({ roundup, reason: r.unmatched, candidates: r.candidates || [] });
  }
  const byShow = new Map();
  for (const m of matched) {
    const cur = byShow.get(m.show.id);
    if (!cur) { byShow.set(m.show.id, m); continue; }
    const dist = (x) => { const om = openingMs(x.show); const pm = Date.parse(x.roundup.date || ''); return om != null && Number.isFinite(pm) ? Math.abs(pm - om) : Infinity; };
    const [keep, drop] = dist(m) < dist(cur) ? [m, cur] : [cur, m];
    byShow.set(m.show.id, keep);
    unmatched.push({ roundup: drop.roundup, reason: `duplicate: ${keep.roundup.url} is closer to ${drop.show.id}'s opening`, candidates: [drop.show.id] });
  }
  return { matched: [...byShow.values()], unmatched };
}

/**
 * An operator pin ({slug: showId}) for a round-up whose post date does not
 * track the production's run (a round-up covering two houses, a long open
 * run with a one-word title). Only honoured while the show still exists.
 */
function pinnedMatch(roundup, shows, pins) {
  const id = pins && pins[roundup.slug];
  const show = id && shows.find((x) => x && x.id === id);
  return show ? { show, confidence: 'high', reasons: ['pinned'] } : null;
}

/**
 * Second pass: unmatched round-ups get their body venue (venueById: id -> text)
 * and are matched again. A round-up that now matches a show no other round-up
 * owns moves to `matched`; everything else stays unmatched, now carrying the
 * venue so scope can be judged. Pure: callers do the fetching.
 */
function rematchWithVenues(matched, unmatched, shows, venueById) {
  const owned = new Set(matched.map((m) => m.show.id));
  const stillUnmatched = [];
  const moved = [];
  for (const u of unmatched) {
    const venue = u.roundup && u.roundup.id != null ? venueById[u.roundup.id] : null;
    if (!venue) { stillUnmatched.push(u); continue; }
    const roundup = { ...u.roundup, venue };
    const r = /^duplicate/.test(u.reason) ? { unmatched: u.reason, candidates: u.candidates } : matchRoundupToShow(roundup, shows);
    if (r.show && !owned.has(r.show.id)) {
      owned.add(r.show.id);
      moved.push({ roundup, show: r.show, confidence: r.confidence, reasons: [...r.reasons, 'body-venue'] });
    } else {
      stillUnmatched.push({ roundup, reason: r.unmatched || u.reason, candidates: r.candidates || u.candidates || [] });
    }
  }
  return { matched: [...matched, ...moved], unmatched: stillUnmatched };
}

module.exports = {
  rematchWithVenues,
  pinnedMatch,
  cleanRoundupTitle,
  parseRoundupPost,
  venueFromContent,
  matchRoundupToShow,
  matchAllRoundups,
  titleMatchKind,
  WINDOW_BEFORE_DAYS,
  WINDOW_AFTER_DAYS,
};
