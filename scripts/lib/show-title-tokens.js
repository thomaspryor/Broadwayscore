'use strict';
/** Significant title tokens (moved from audit-show-review-gap.js, BRO-6804, so lib code can share it). */
function titleTokens(title) {
  // Significant tokens (3+ chars, not stopwords) from the show title.
  // Used to filter aggregator-article links to URLs actually about THIS show
  // (vs sidebar/related-article links).
  const STOPWORDS = new Set([
    'the','and','for','off','broadway','musical','play','theater','theatre',
    'review','reviews','what','are','is','of','to','in','on','at','a','an',
    'with','by','from','presents','starring','new','york','nyc','show',
  ]);
  // Fold diacritics BEFORE stripping non-alphanumerics. Without the NFD
  // decomposition the `[^a-z0-9 ]` strip turns each accented letter into a
  // SPACE, shredding one word into fragments that can never match an ASCII URL
  // slug: "Les Misérables" became ["les","mis","rables"] instead of
  // ["les","miserables"]. Because urlMatchesShow requires n-1 of n tokens, the
  // two phantom fragments made every real review URL for that show unmatchable
  // — the census reported "0 gaps" for Les Misérables: The Arena Concert
  // Spectacular on 2026-07-30 while amNewYork and New York Theatre Guide were
  // both live and missing. 28 corpus shows are affected; the worst are operas
  // where the fragment count collapses to 1-2 tokens and the `tokens.length<=2`
  // branch then demands a 100% match: "La Bohème" → ["boh"], "Jenůfa" → ["jen"].
  // Same fold as title-normalization.js:29 / show-matching.js:1078.
  const words = (title || '').toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const significant = words.filter(t => t.length >= 3 && !STOPWORDS.has(t));
  if (significant.length) return significant;
  // BRO-6629: a title made only of short or stopword tokens ("44", "Oz",
  // "The Play") used to yield [], and urlMatchesShow accepts EVERY link on an
  // empty token set, so a BWW/Playbill roundup sidebar for another show (the
  // Merrily URLs on "44") was booked as a missing review. Fall back to the
  // numeric / 2-char words, then to every word, so a token set exists.
  const short = words.filter(t => /^\d+$/.test(t) || (t.length >= 2 && !STOPWORDS.has(t)));
  return short.length ? short : words;
}

// BRO-6909: the other names a show is listed under. Aggregators and critics drop
// billing prefixes our titles keep: Playbill's Verdict for "Clifford Odets’ Waiting
// for Lefty" is /what-do-reviews-think-of-waiting-for-lefty-at-classic-stage-company,
// and the full-title token gate (n-1 of 4 tokens) rejected it, so the gap audit
// saw no round-up and graded the show "0 gaps" while 4 of 7 reviews were missing.
// Every variant is a title the show is billed or reviewed under:
//   - akaTitles from shows.json
//   - minus a possessive author credit ("Clifford Odets’ ", "Irving Berlin's "),
//     only when the possessor is a cast/creative name or the remainder is another
//     show's exact title (the same work billed bare). Otherwise the possessive is
//     part of the title: "Ma Rainey's Black Bottom", "Jacob Marley's Christmas Carol".
//   - "Performer: Title" → "Title", only when the prefix is a cast/creative name
//     ("Kelly McCaughan: Catholic Guilt"). Most colon titles are "Title: Subtitle"
//     ("Billy Elliot: The Musical"), and neither half alone is safe: the subtitle is
//     generic and the bare title or a performer's name matches their other shows.
//   - "Title – Venue" / "Title (Venue or Company)" → "Title", only when the dropped
//     part names this show's venue ("Betty's Summer Vacation (The Heights Players)",
//     "Jack and the Beanstalk - Theatre on Kew"). A dash or bracket that carries a
//     performer or a subtitle stays ("Patti LuPone - Matters Of The Heart",
//     "Pride and Prejudice* (*sort of)").
// Each shortened variant keeps >= 2 significant tokens, so a one-word remainder
// ("Seussical", "Motherfucker") never widens the gate to another production.
const CREDIT_LEAD_WORDS = new Set(['a', 'an', 'the', 'our', 'my', 'your', 'his', 'her', 'their']);
const normName = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function creditNames(show) {
  const names = new Set();
  for (const k of ['cast', 'creativeTeam']) {
    for (const p of (Array.isArray(show[k]) ? show[k] : [])) if (p && p.name) names.add(normName(p.name));
  }
  return names;
}
let _knownTitles = null;
// normalised title -> Set of show ids carrying it (data/shows.json)
function knownTitles() {
  if (!_knownTitles) {
    _knownTitles = new Map();
    try {
      const raw = require('../../data/shows.json');
      for (const s of (Array.isArray(raw) ? raw : raw.shows || [])) {
        if (!s || !s.title) continue;
        const k = normName(s.title);
        if (!_knownTitles.has(k)) _knownTitles.set(k, new Set());
        _knownTitles.get(k).add(s.id);
      }
    } catch (_) { /* no shows.json: the possessive rule then needs a credit name */ }
  }
  return _knownTitles;
}
// Words every venue name shares; they say nothing about WHICH house.
// opera/music: a /opera/ or /music/ section path is not a venue (Metropolitan Opera House).
const GENERIC_VENUE_WORDS = new Set(['opera', 'music', 'theatre', 'theater', 'theatres', 'theaters', 'house', 'company', 'stage',
  'playhouse', 'center', 'centre', 'hall', 'studio', 'studios', 'arts', 'club', 'new', 'york', 'nyc', 'london',
  'off', 'broadway', 'west', 'end', 'space', 'room']);
/** Distinctive venue words ("Classic Stage Company" -> ['classic']). */
function venueTokens(show) {
  const v = show && (typeof show.venue === 'string' ? show.venue : show.venue && show.venue.name);
  return titleTokens(v || '').filter(w => !GENERIC_VENUE_WORDS.has(w) && !/^\d+$/.test(w));
}
function significantCount(t) {
  return titleTokens(t).filter(w => w.length >= 3 && !/^\d+$/.test(w)).length;
}
/**
 * Every title a show is billed by, with where it came from.
 * kind: 'billed' (show.title), 'aka' (akaTitles), 'derived' (a credit, performer
 * prefix or venue label dropped). clashIds: OTHER shows.json rows whose title is
 * exactly this variant ("Waiting for Lefty" is also the 2024 regional's title), so
 * a URL naming it may be that production's. fromVenue: made by dropping the venue.
 * @param {object|string} showOrTitle a shows.json row or a bare title
 * @param {{titles?: Map<string, Set<string>>}} [opts] normalised title -> ids (default: data/shows.json)
 * @returns {{title: string, kind: string, clashIds: string[], fromVenue: boolean}[]}
 */
function titleVariantInfo(showOrTitle, opts = {}) {
  const show = typeof showOrTitle === 'string' ? { title: showOrTitle } : (showOrTitle || {});
  const title = String(show.title || '').trim();
  const titles = opts.titles || knownTitles();
  const out = [];
  const add = (t, kind, minTokens, fromVenue = false) => {
    const v = String(t || '').trim();
    if (!v || out.some(o => o.title === v)) return;
    if (minTokens && significantCount(v) < minTokens) return;
    const ids = kind === 'billed' ? [] : [...(titles.get(normName(v)) || [])].filter(id => id !== show.id);
    out.push({ title: v, kind, clashIds: ids, fromVenue });
  };
  const credits = creditNames(show);
  add(title, 'billed');
  // An aka needs one real word: "860" (Billy Crystal) would match any /860/ path.
  for (const aka of (Array.isArray(show.akaTitles) ? show.akaTitles : [])) add(aka, 'aka', 1);
  const credit = title.match(/^((?:[A-Z][\w.\-]*\s+){1,3}[A-Z][\w.\-]*)[’']s?\s+(.+)$/);
  if (credit && !CREDIT_LEAD_WORDS.has(credit[1].split(/\s+/)[0].toLowerCase())
      && (credits.has(normName(credit[1])) || titles.has(normName(credit[2])))) add(credit[2], 'derived', 2);
  const colon = title.match(/^([^:]{2,80}):\s+(.+)$/);
  if (colon && credits.has(normName(colon[1]))) add(colon[2], 'derived', 2);
  const sub = title.match(/^(.+?)\s+(?:[–—-]\s+(.+)|\((.+)\))$/);
  // Whole words, not substrings: "Live" is inside "Olivier".
  const vWords = normName(typeof show.venue === 'string' ? show.venue : show.venue && show.venue.name).split(' ').filter(Boolean);
  const dWords = sub ? normName(sub[2] || sub[3]).split(' ').filter(Boolean) : [];
  const within = (a, b) => a.length > 0 && a.every(w => b.includes(w));
  if (sub && dWords.join(' ').length >= 4 && vWords.length && (within(dWords, vWords) || within(vWords, dWords))) {
    add(sub[1], 'derived', 2, true);
  }
  // "Tosca - English National Opera": critics write "Tosca". The bare head is
  // another show's exact title by construction, so it always carries clashIds
  // and a URL needs proof (a venue word, or a link inside this show's own
  // roundup) before it counts. One word is enough for that reason.
  // The dropped label's initials are proof too ("tosca-eno-review").
  if (sub && sub[2] && titles.has(normName(sub[1]))) {
    add(sub[1], 'derived', 1);
    const words = normName(sub[2]).split(' ').filter(w => w && !['the', 'a', 'an', 'of', 'and', 'at'].includes(w));
    const initials = words.map(w => w[0]).join('');
    const v = out.find(o => o.title === String(sub[1]).trim() && o.kind === 'derived');
    if (v) v.labelHead = true;
    if (v && words.length >= 3 && initials.length >= 3) v.proofTokens = [initials];
  }
  return out;
}
let _labelled = null;
/**
 * Shows billed as "<this show's title> - <label>" ("Tosca - English National
 * Opera" for the Met's "Tosca"), with the proof words that tie a URL to them:
 * their venue words and, for a 3+ word label, its initials.
 * @returns {{id: string, proof: string[]}[]}
 */
function labelledSiblings(show) {
  if (!_labelled) {
    _labelled = new Map();
    try {
      const raw = require('../../data/shows.json');
      for (const s of (Array.isArray(raw) ? raw : raw.shows || [])) {
        const v = s && s.title ? titleVariantInfo(s).find(o => o.kind === 'derived' && o.labelHead) : null;
        if (!v) continue;
        const k = normName(v.title);
        if (!_labelled.has(k)) _labelled.set(k, []);
        _labelled.get(k).push({ id: s.id, proof: [...venueTokens(s), ...(v.proofTokens || [])] });
      }
    } catch (_) { /* no shows.json: no labelled siblings */ }
  }
  return (_labelled.get(normName(show && show.title)) || []).filter(x => x.id !== (show && show.id));
}

/** @returns {string[]} the full title first, then each variant */
function titleVariants(showOrTitle, opts = {}) {
  return titleVariantInfo(showOrTitle, opts).map(o => o.title);
}

/** Token lists for every variant, full title first. */
function titleTokenSets(showOrTitle) {
  return titleVariants(showOrTitle).map(titleTokens);
}

module.exports = { titleTokens, titleVariants, titleVariantInfo, titleTokenSets, venueTokens, labelledSiblings };
