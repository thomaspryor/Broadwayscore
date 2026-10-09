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
 *   3. title match: the page is a tracked production (any tour-parent market)
 *   4. company: "<tracked tour>-<one word>" is one company of that tour
 *   5. aggregator by structure: engagements overlapping in time in different
 *      cities (one company cannot be in two cities at once)
 *   6. event keywords (deny only): circus, tribute, concert, steamroller...
 *   7. Wikipedia infobox (musical / play => production; concert, circus,
 *      dance => event) when the caller supplies the article
 *   8. otherwise 'unclassified': never created by itself, recorded with
 *      needsClassification and sent to the owner digest
 *
 * Pure apart from loadTourPageClasses. Tour pages, parents and companies are
 * judged on our data and the page's own text, never on the URL's words except
 * the slug rules above, which only DENY.
 */

const fs = require('fs');
const path = require('path');

const CLASSES = ['production', 'event', 'aggregator', 'template', 'company', 'unclassified'];
const PRODUCTION_TYPES = ['musical', 'play', 'special', 'opera'];
const OVERRIDES_PATH = path.join(__dirname, '..', '..', 'data', 'tour-page-classes.json');

const TEMPLATE_RE = /(^|-)(template|tester|test|sample)(-|$)/;
// Deny only: a page matching these is an event unless a person said otherwise.
const EVENT_RE = /cirque|circus|tribute|concert|orchestra|symphony|illusionist|on-ice|steamroller|riverdance|stomp|nutcracker/;
// A company page needs a real suffix word; these are the same show's own page.
const NOT_A_COMPANY_WORD = new Set(['tour', 'the', 'musical', 'show', 'live', 'play', 'on', 'of', 'and', 'a']);
// Engagements overlapping another city's this often make a page an aggregator.
const AGGREGATOR_MIN_OVERLAPS = 3;

const kebab = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/['‘’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

/** How many engagements overlap an engagement in a different city. */
function overlappingEngagements(rows) {
  const list = (rows || []).filter(r => r && r.start && r.end);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const a = list[i];
      const b = list[j];
      if (cityKey(a.city) === cityKey(b.city)) continue;
      // Back-to-back stops that share a changeover day do not overlap; two
      // one-day dates that coincide do.
      const overlap = (a.start < b.end && b.start < a.end) || (a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime());
      if (overlap) { n++; break; }
    }
  }
  return n;
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

const result = (cls, extra) => ({ class: cls, title: null, type: null, reason: '', source: '', ...extra });

/**
 * @param {object} args
 * @param {string} args.slug Tours To You page slug
 * @param {string} [args.pageTitle] the page's title (WordPress title or its <title>), never the URL
 * @param {Array<{city, start: Date, end: Date}>} [args.rows] parsed engagements; omit to classify on the slug alone
 * @param {Array} args.shows all shows
 * @param {object} [args.overrides] loadTourPageClasses()
 * @param {string} [args.wikiText] the title's Wikipedia wikitext
 * @param {string} [args.beforeIso] a production counts as a parent only if it opened by then
 * @returns {{class: string, parentId?: string, companyOf?: string, title: string|null, type: string|null, reason: string, source: string}}
 */
function classifyTourPage({ slug, pageTitle = null, rows = null, shows = [], overrides = {}, wikiText = '', beforeIso = null }) {
  const { parentForSlug, titleKey } = require('./tour-discovery');
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

  // 3. A tracked production of this title, in any tour-parent market.
  const parent = parentForSlug(s, shows, beforeIso) || (pageTitle ? parentForSlug(titleKey(pageTitle), shows, beforeIso) : null);
  if (parent) {
    return result('production', { parentId: parent.id, title: parent.title, type: parent.type || 'musical', reason: `title matches tracked production ${parent.id}`, source: 'title-match' });
  }

  // 4. One company of a tracked tour (Hamilton - Angelica, SIX - Boleyn).
  const company = companyOfSlug(s, shows);
  if (company) return result('company', { companyOf: company, title: pageTitle, reason: `one company of ${company} under its own page`, source: 'company-rule' });

  // 5. Several cities at once: a list of shows, not one tour.
  if (rows && rows.length) {
    const n = overlappingEngagements(rows);
    if (n >= AGGREGATOR_MIN_OVERLAPS) return result('aggregator', { title: pageTitle, reason: `${n} engagements overlap another city's in time; one company cannot be in two cities at once`, source: 'structure' });
  }

  // 6. Event keywords deny.
  const words = `${s} ${kebab(pageTitle)}`;
  const hit = EVENT_RE.exec(words);
  if (hit) return result('event', { title: pageTitle, reason: `"${hit[0]}" marks a concert, circus or dance event, not a stage production`, source: 'keyword' });

  // 7. Wikipedia's infobox, when we have the article.
  const box = infoboxClass(wikiText);
  if (box) {
    return box.class === 'production'
      ? result('production', { title: pageTitle, type: box.type, reason: `Wikipedia infobox "${box.kind}"`, source: 'wikipedia' })
      : result('event', { title: pageTitle, reason: `Wikipedia infobox "${box.kind}" is not a stage production`, source: 'wikipedia' });
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
  AGGREGATOR_MIN_OVERLAPS,
  classifyTourPage,
  loadTourPageClasses,
  overrideProblems,
  overlappingEngagements,
  infoboxClass,
  companyOfSlug,
  decodeTitle,
  pageTitleFromHtml,
};
