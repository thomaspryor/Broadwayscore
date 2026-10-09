'use strict';

/**
 * What is this Tours To You page? (BRO-4931)
 *
 * Tours To You lists every touring thing as a page under /shows/: stage
 * productions, but also concerts, circus and dance shows, whole-season
 * aggregators ("Holiday Shows", 374 engagements), one company of a production
 * under its own page ("Hamilton - Angelica"), and WordPress template pages.
 * Discovery used to read only pages titled like a Broadway show, so none of
 * that mattered; with the Broadway-parent rule gone every page is read and each
 * must be told apart before it can become a tour entry.
 *
 * classifyTourPage checks, in order, and the first that fires decides:
 *   1. a human override (data/tour-page-classes.json) - always wins
 *   2. template: the slug says template / tester / test / sample
 *   3. title match: the page is a tracked production in a market automatic
 *      discovery may tour from (AUTO_TOUR_PARENT_CATEGORIES: Broadway,
 *      Off-Broadway, regional; a UK parent only by an override naming parentId).
 *      An event word in the SLUG is checked first (step 2b), so
 *      "jesus-christ-superstar-in-concert" is not the Broadway production
 *   4. company: "<tracked tour>-<one word>" is one company of that tour
 *   5. aggregator by structure: five or more cities with an engagement at the
 *      same moment (a touring show has a handful of companies at most; a list
 *      of many shows, like Holiday Shows, has dozens)
 *   6. event keywords (deny only): circus, tribute, concert, steamroller...
 *   7. Wikipedia infobox (musical / play => production; concert, circus,
 *      dance => event) when the caller supplies the article, and only if the
 *      article mentions touring, its "(musical)"/"(play)" name does not
 *      contradict the page, and no tracked show has a similar title (a
 *      "Tina: The Tina Turner Musical" page is probably the tour of "Tina",
 *      not a new standalone show: the owner decides)
 *   8. otherwise 'unclassified': never created by itself, recorded with
 *      needsClassification and sent to the owner digest
 *
 * Pure apart from loadTourPageClasses. Tour pages, parents and companies are
 * judged on our data and the page's own text, never on the URL's words except
 * the slug rules above, which only DENY.
 */

const fs = require('fs');
const path = require('path');
const { proseOnly } = require('./tour-schedule');
const { foldDiacritics } = require('./title-match');

const CLASSES = ['production', 'event', 'aggregator', 'template', 'company', 'unclassified'];
// One list with buildTourEntry: a standalone tour is refused for any other type.
const { STANDALONE_TYPES: PRODUCTION_TYPES } = require('./tour-entry');
const OVERRIDES_PATH = path.join(__dirname, '..', '..', 'data', 'tour-page-classes.json');

const TEMPLATE_RE = /(^|-)(template|tester|test|sample)(-|$)/;
// Deny only: a page matching these is an event unless a person said otherwise.
// Whole slug words only: (^|-)word(-|$), so "contributed" or "concerto" are not events.
const EVENT_RE = /(^|-)(cirque|circus|tributes?|concerts?|orchestra|symphony|illusionists?|on-ice|steamroller|riverdance|stomp|nutcrackers?)(-|$)/;
// An article that never mentions touring cannot say what is on the road.
const TOUR_MENTION_RE = /\btour(ed|ing)?\b/i;
// A company page needs a real suffix word; these are the same show's own page.
const NOT_A_COMPANY_WORD = new Set(['tour', 'the', 'musical', 'show', 'live', 'play', 'on', 'of', 'and', 'a']);
// Cities with an engagement at the same moment, at least this many, make a page
// an aggregator. The first design called three overlapping engagements enough
// ("one company cannot be in two cities at once"), but a production with two
// or three companies on the road (Menopause The Musical, Rudolph, Potted Potter)
// overlaps that much and is one show. Measured on 2026-10-09: Holiday Shows has
// 21 cities at once; every untitled production page has at most 4 (Hamilton's own
// page reaches 5 with its companies, but it is a title match and never reaches
// this rule). A page this rule catches that is really one production with many
// companies needs a production override, not an aggregator one.
const AGGREGATOR_MIN_CITIES = 5;

const kebab = s => foldDiacritics(String(s || '')).toLowerCase().replace(/&/g, 'and').replace(/['‘’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cityKey = c => String(c || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Overrides read from data/tour-page-classes.json:
 * { "<slug>": { class, title?, type?, parentId?, companyOf?, reason, issue, reviewedAt } }.
 * Keys starting with "_" are documentation. A missing file is no overrides.
 */
function loadTourPageClasses(file = OVERRIDES_PATH) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  const out = {};
  for (const [slug, row] of Object.entries(raw || {})) if (!slug.startsWith('_') && row && typeof row === 'object') out[slug] = row;
  return out;
}

/** Problems with an overrides map, as strings; the unit test and the sweep run it. */
function overrideProblems(overrides) {
  const out = [];
  for (const [slug, o] of Object.entries(overrides || {})) {
    if (!CLASSES.includes(o.class) || o.class === 'unclassified') out.push(`${slug}: class "${o.class}" is not one of ${CLASSES.filter(c => c !== 'unclassified').join(', ')}`);
    if (!o.reason) out.push(`${slug}: no reason`);
    if (!/^BRO-\d+$/.test(String(o.issue || ''))) out.push(`${slug}: issue must be BRO-N`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.reviewedAt || ''))) out.push(`${slug}: reviewedAt must be YYYY-MM-DD`);
    if (o.class === 'production' && !o.parentId && !(o.title && PRODUCTION_TYPES.includes(o.type))) out.push(`${slug}: a production override with no parentId needs title and type (${PRODUCTION_TYPES.join('/')})`);
    if (o.class === 'company' && !o.companyOf) out.push(`${slug}: a company override needs companyOf`);
  }
  return out;
}

const DAY = 86400000;

/**
 * The most distinct cities with an engagement at the same moment. An
 * engagement holds its first through its last day; a stop that ends one day
 * and another that starts the next are not concurrent, two that share a day are.
 */
function maxConcurrentCities(rows) {
  const events = [];
  const list = (rows || []).filter(r => r && r.start && r.end);
  list.forEach((r, i) => {
    events.push([r.start.getTime(), 1, i]);
    events.push([r.end.getTime() + DAY, -1, i]);
  });
  // At an equal time ends come first, so back-to-back stops never overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Map();
  let max = 0;
  for (const [, delta, i] of events) {
    const city = cityKey(list[i].city);
    if (delta > 0) active.set(city, (active.get(city) || 0) + 1);
    else {
      const left = active.get(city) - 1;
      if (left) active.set(city, left); else active.delete(city);
    }
    max = Math.max(max, active.size);
  }
  return max;
}

/** The infobox of a Wikipedia article's wikitext, as { kind } or null. */
function wikiInfobox(wikiText) {
  const m = /\{\{\s*Infobox\s+([A-Za-z][A-Za-z ]*?)\s*(?:\||\n|\}\})/i.exec(String(wikiText || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Production types an infobox names: Infobox musical / play / opera. Concert
 * tours, circus and dance shows are events. Anything else says nothing.
 */
function infoboxClass(wikiText) {
  const kind = wikiInfobox(wikiText);
  if (!kind) return null;
  if (kind === 'musical') return { class: 'production', type: 'musical', kind };
  if (kind === 'play') return { class: 'production', type: 'play', kind };
  if (kind === 'opera') return { class: 'production', type: 'opera', kind };
  if (/concert|circus|dance|ballet|festival|comedian|magic/.test(kind)) return { class: 'event', kind };
  return null;
}

/** Tracked tours whose schedule slug or title answers to a page-slug prefix. */
function trackedTourKeys(shows) {
  const { titleKey, titleKeys } = require('./tour-discovery');
  const keys = new Map();
  for (const s of shows || []) {
    if (!s || s.category !== 'tour') continue;
    const ks = new Set(titleKeys(s.title));
    if (s.tourScheduleSlug) ks.add(titleKey(s.tourScheduleSlug));
    for (const k of ks) if (k && !keys.has(k)) keys.set(k, s.id);
  }
  return keys;
}

/** The tracked tour id a "<tour>-<word>" slug is a company page of, or null. */
function companyOfSlug(slug, shows) {
  const { titleKey } = require('./tour-discovery');
  const m = /^(.+)-([a-z0-9]+)$/.exec(String(slug || ''));
  if (!m) return null;
  const [, base, word] = m;
  if (NOT_A_COMPANY_WORD.has(word) || /^\d+$/.test(word)) return null;
  return trackedTourKeys(shows).get(titleKey(base)) || null;
}

/**
 * The article's prose: citations and every {{template}} removed. A hatnote such as
 * {{About||the national touring play ... |Clue: On Stage}} says there is ANOTHER
 * work (it is the clue that this one never toured), and an infobox field is not prose.
 */
function bodyProse(wikiText) {
  let t = proseOnly(wikiText);
  for (let i = 0; i < 6 && /\{\{[^{}]*\}\}/.test(t); i++) t = t.replace(/\{\{[^{}]*\}\}/g, '');
  return t;
}

const result = (cls, extra) => ({ class: cls, title: null, type: null, reason: '', source: '', ...extra });

// Leading articles never decide whether two titles are the same show.
// Nor does a trailing "(the) musical" or "(the) play" ("the-spongebob-musical" is "spongebob").
const stripArticle = k => String(k || '').replace(/^(the|a|an)-/, '').replace(/(-the)?-(musical|play)$/, '');

/**
 * A tracked non-tour show (any market) whose title is the page's, or a whole-word
 * prefix of it, or the other way round (BRO-4931): "Tina" and "Tina: The Tina Turner
 * Musical", "SpongeBob SquarePants" and "The SpongeBob Musical". Each key must be at
 * least 4 characters to count as a prefix. Such a page may be the tour of that
 * show (a subtitle mismatch), so it is never made a duplicate standalone tour
 * by itself.
 */
function similarTrackedShow(shows, slug, pageTitle) {
  const { titleKey, titleKeys, slugKey } = require('./tour-discovery');
  const pageKeys = [...new Set([titleKey(pageTitle), titleKey(slug), slugKey(slug)].filter(Boolean).map(stripArticle))];
  const related = (a, b) => (a.length >= 4 && (b === a || b.startsWith(`${a}-`))) || (b.length >= 4 && a.startsWith(`${b}-`));
  for (const show of shows || []) {
    if (!show || show.category === 'tour') continue;
    for (const k of [...titleKeys(show.title)].map(stripArticle)) {
      if (k && pageKeys.some(p => related(p, k))) return show;
    }
  }
  return null;
}

/**
 * Why a Wikipedia article's "(musical)" / "(play)" name contradicts the page, or
 * null. Clue's tour is of the play; the article found was "Clue (musical)".
 */
function disambiguationConflict(wikiTitle, slug, pageTitle) {
  const m = /\((musical|play)\)\s*$/i.exec(String(wikiTitle || ''));
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const words = new Set(`${slug}-${kebab(pageTitle)}`.split('-'));
  const other = kind === 'musical' ? 'play' : 'musical';
  return words.has(other) ? `the article is "${wikiTitle}" but the page says ${other}` : null;
}

/**
 * @param {object} args
 * @param {string} args.slug Tours To You page slug
 * @param {string} [args.pageTitle] the page's title (WordPress title or its <title>), never the URL
 * @param {Array<{city, start: Date, end: Date}>} [args.rows] parsed engagements; omit to classify on the slug alone
 * @param {Array} args.shows all shows
 * @param {object} [args.overrides] loadTourPageClasses()
 * @param {string} [args.wikiText] the title's Wikipedia wikitext (classification only; never used for dates)
 * @param {string} [args.wikiTitle] the name of the article wikiText came from, e.g. "Clue (musical)"
 * @param {string} [args.beforeIso] a production counts as a parent only if it opened by then
 * @returns {{class: string, parentId?: string, companyOf?: string, title: string|null, type: string|null, reason: string, source: string}}
 */
function classifyTourPage({ slug, pageTitle = null, rows = null, shows = [], overrides = {}, wikiText = '', wikiTitle = null, beforeIso = null }) {
  const { parentForSlug, titleKey } = require('./tour-discovery');
  const { AUTO_TOUR_PARENT_CATEGORIES } = require('./tour-family');
  const s = String(slug || '').toLowerCase();

  // 1. A person's call always wins.
  const o = (overrides || {})[slug] || (overrides || {})[s];
  if (o) {
    const parent = o.parentId ? (shows || []).find(x => x.id === o.parentId) : null;
    return result(o.class, {
      ...(o.parentId ? { parentId: o.parentId } : {}),
      ...(o.companyOf ? { companyOf: o.companyOf } : {}),
      title: o.title || (parent && parent.title) || pageTitle || null,
      type: o.type || (parent && (parent.type || 'musical')) || null,
      reason: `${o.reason} (${o.issue || 'override'})`,
      source: 'override',
    });
  }

  // 2. Template pages.
  if (TEMPLATE_RE.test(s)) return result('template', { title: pageTitle, reason: 'slug names a template, tester or sample page', source: 'slug-rule' });

  // 2b. An event word in the slug beats a title match: "jesus-christ-superstar-in-concert"
  // is a concert of a show we track, not that show.
  const slugHit = EVENT_RE.exec(s);
  if (slugHit) return result('event', { title: pageTitle, reason: `"${slugHit[2]}" in the page name marks a concert, circus or dance event, not a stage production`, source: 'keyword' });

  // 3. A tracked production of this title in a market automatic discovery tours from.
  const parent = parentForSlug(s, shows, beforeIso, AUTO_TOUR_PARENT_CATEGORIES)
    || (pageTitle ? parentForSlug(titleKey(pageTitle), shows, beforeIso, AUTO_TOUR_PARENT_CATEGORIES) : null);
  if (parent) {
    return result('production', { parentId: parent.id, title: parent.title, type: parent.type || 'musical', reason: `title matches tracked production ${parent.id}`, source: 'title-match' });
  }

  // 4. One company of a tracked tour (Hamilton - Angelica, SIX - Boleyn).
  const company = companyOfSlug(s, shows);
  if (company) return result('company', { companyOf: company, title: pageTitle, reason: `one company of ${company} under its own page`, source: 'company-rule' });

  // 5. Many cities at once: a list of shows, not one tour.
  if (rows && rows.length) {
    const n = maxConcurrentCities(rows);
    if (n >= AGGREGATOR_MIN_CITIES) return result('aggregator', { title: pageTitle, reason: `${n} different cities have an engagement at the same moment; a touring show has a few companies at most`, source: 'structure' });
  }

  // 6. Event words in the page's title deny.
  const hit = EVENT_RE.exec(kebab(pageTitle));
  if (hit) return result('event', { title: pageTitle, reason: `"${hit[2]}" in the title marks a concert, circus or dance event, not a stage production`, source: 'keyword' });

  // 7. Wikipedia's infobox, when we have the article and it can be trusted for this page.
  const box = infoboxClass(wikiText);
  if (box) {
    const undecided = reason => result('unclassified', { title: pageTitle, reason, source: 'none' });
    if (!TOUR_MENTION_RE.test(bodyProse(wikiText))) return undecided(`the Wikipedia article${wikiTitle ? ` "${wikiTitle}"` : ''} never mentions a tour, so it may be a different production of the title`);
    const conflict = disambiguationConflict(wikiTitle, s, pageTitle);
    if (conflict) return undecided(`Wikipedia article does not fit the page: ${conflict}`);
    if (box.class === 'production') {
      const like = similarTrackedShow(shows, s, pageTitle);
      if (like) return undecided(`title resembles tracked show ${like.id} ("${like.title}"); this may be its tour rather than a new standalone show`);
      return result('production', { title: pageTitle, type: box.type, reason: `Wikipedia infobox "${box.kind}"`, source: 'wikipedia' });
    }
    return result('event', { title: pageTitle, reason: `Wikipedia infobox "${box.kind}" is not a stage production`, source: 'wikipedia' });
  }

  // 8. A human has to say.
  return result('unclassified', { title: pageTitle, reason: 'no tracked production, rule or Wikipedia infobox says what this page is', source: 'none' });
}

/** The classes the discovery reader never fetches a page for. */
const SKIPPED_CLASSES = new Set(['event', 'aggregator', 'template', 'company']);

/** Decode the few HTML entities a WordPress title carries. */
function decodeTitle(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&rsquo;|&lsquo;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** A show page's own title from its <title> ("Mystic Pizza - Tours To You"), or null. Page text, not the URL. */
function pageTitleFromHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  if (!m) return null;
  const t = decodeTitle(m[1]).replace(/\s*[–—|-]\s*Tours To You\s*$/i, '').trim();
  return t || null;
}

module.exports = {
  CLASSES,
  PRODUCTION_TYPES,
  SKIPPED_CLASSES,
  OVERRIDES_PATH,
  TEMPLATE_RE,
  EVENT_RE,
  AGGREGATOR_MIN_CITIES,
  classifyTourPage,
  loadTourPageClasses,
  overrideProblems,
  maxConcurrentCities,
  infoboxClass,
  bodyProse,
  similarTrackedShow,
  disambiguationConflict,
  TOUR_MENTION_RE,
  companyOfSlug,
  decodeTitle,
  pageTitleFromHtml,
};
