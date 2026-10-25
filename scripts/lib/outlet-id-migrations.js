'use strict';

/**
 * Outlet-id migrations for review-texts files (BRO-4947).
 *
 * The BRO-4907 outlet-tier audit found ids that mix two publications or split one
 * publication across several ids, so reviews are weighted with the wrong tier and show
 * under the wrong outlet. Each rule here moves matching files to a canonical outlet id:
 * it rewrites `outletId`/`outlet` inside the file and renames `<from>--<critic>.json` to
 * `<to>--<critic>.json`. Pure: planOutletMigration() does no I/O; scripts/migrate-outlet-ids.js
 * applies the plans through safeRenameReview (sister LLM-score store and sibling
 * duplicateTextOf pointers move with the file).
 *
 * A rule matches on the record's outlet id (the field, or the filename prefix when the
 * field is missing) and an optional predicate on the record, usually its URL host.
 */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

const MIGRATIONS = [
  {
    id: 'dc-metro-domain-to-dc-theater-arts',
    note: 'dcmetrotheaterarts.com is DC Theater Arts (formerly DC Metro Theater Arts); its rows were filed under dctheatrescene (a different site, dctheatrescene.com).',
    from: ['dctheatrescene'],
    to: 'dc-theater-arts',
    toName: 'DC Theater Arts',
    match: (r) => hostOf(r.url) === 'dcmetrotheaterarts.com',
  },
  {
    id: 'dctheatrescene-bobs-blog-host-to-bobs-theater-blog',
    note: 'A row filed under dctheatrescene whose URL is Robert Sholiton\'s Bob\'s Theater Blog (the-play-that-goes-wrong-off-broadway-2019).',
    from: ['dctheatrescene'],
    to: 'bobs-theater-blog',
    toName: "Bob's Theater Blog",
    match: (r) => hostOf(r.url) === 'bobs-theater-blog.blogspot.com',
  },
  {
    id: 'dc-metro-theater-arts-to-dc-theater-arts',
    note: 'Same outlet under two ids.',
    from: ['dc-metro-theater-arts'],
    to: 'dc-theater-arts',
    toName: 'DC Theater Arts',
  },
  {
    id: 'vulture-nysd-host-to-newyorksocialdiary',
    note: 'A New York Social Diary review (lost-in-del-valle-off-broadway-2026) filed under vulture; restored from history by BRO-5133 plan c.',
    from: ['vulture'],
    to: 'newyorksocialdiary',
    toName: 'New York Social Diary',
    match: (r) => hostOf(r.url) === 'newyorksocialdiary.com',
  },
  {
    id: 'vulture-newyorknotebook-host-to-new-york-notebook',
    note: 'A New York Notebook (Substack) piece filed under vulture (liberation-2025, BRO-5179).',
    from: ['vulture'],
    to: 'new-york-notebook',
    toName: 'New York Notebook',
    match: (r) => hostOf(r.url) === 'newyorknotebook.substack.com',
  },
  {
    id: 'vulture-theater-nytimes-host-to-nytimes',
    note: 'A New York Times review (theater.nytimes.com) filed under vulture, a duplicate of the nytimes copy (la-cage-aux-folles-2010, BRO-5179). Same-article duplicates are resolved by migrate-outlet-ids.js.',
    from: ['vulture'],
    to: 'nytimes',
    toName: 'The New York Times',
    match: (r) => ['theater.nytimes.com', 'theater2.nytimes.com', 'nytimes.com'].includes(hostOf(r.url)),
  },
  {
    id: 'observer-fordham-host-to-fordham-observer',
    note: 'A Fordham University student paper review filed under observer (BRO-4976). The NY and UK Observer ids are NOT split: the registry models observer as dual-market and applies the NYC or London tier per show market already.',
    from: ['observer'],
    to: 'fordham-observer',
    toName: 'Fordham Observer',
    match: (r) => hostOf(r.url) === 'fordhamobserver.com',
  },
  {
    id: 'observer-theater-news-online-host-to-theater-news-online',
    note: 'A Theater News Online review filed under observer (BRO-4976).',
    from: ['observer'],
    to: 'theater-news-online',
    toName: 'Theater News Online',
    match: (r) => hostOf(r.url) === 'theaternewsonline.com',
  },
  {
    id: 'jfod-2024-maxwell-times-to-sunday-times',
    note: 'BRO-5420: Dominic Maxwell\'s Just for One Day review (Theatre Record row, no url) is dated Sunday 2024-02-18; The Times has no Sunday edition and its daily review of the show is Clive Davis\'s (2024-02-14, own row). Theatre Record filed it under The Times. One file only.',
    from: ['times-uk'],
    to: 'sunday-times',
    toName: 'The Sunday Times',
    match: (r) => r.showId === 'just-for-one-day-west-end-2024' && r.criticName === 'Dominic Maxwell'
      && r.source === 'theatre-record' && r.publishDate === '2024-02-18' && !r.url,
  },
  {
    id: 'dreamgirls-1981-campbell-nydailynews-to-ap',
    note: 'BRO-5442: an AP review by Mary Campbell ("NEW YORK (AP)", newspapers.com OCR of a syndicating paper, 1981-12-26) filed as the Daily News / Douglas Watt row; the scorer then scored the Watt quote in its closing roundup (42) instead of Campbell\'s rave. One file only; plan c renames it to ap--mary-campbell.json.',
    from: ['nydailynews'],
    to: 'ap',
    toName: 'Associated Press',
    match: (r) => r.showId === 'dreamgirls-1981' && r.criticName === 'Mary Campbell' && r.source === 'newspapers-com-ocr',
  },
  {
    id: 'gotham-playgoer-to-bobs-theater-blog',
    note: 'Same Blogspot blog, renamed in 2017.',
    from: ['gotham-playgoer'],
    to: 'bobs-theater-blog',
    toName: "Bob's Theater Blog",
  },
];

function currentOutletId(record, filename) {
  const prefix = String(filename || '').split('--')[0];
  return { field: record && record.outletId ? String(record.outletId) : '', prefix };
}

/**
 * @param {object} record parsed review-text file
 * @param {string} filename basename, `<outletId>--<critic>.json`
 * @param {Array} [migrations]
 * @returns {null | {rule: string, from: string, to: string, newFilename: string, newData: object}}
 */
function planOutletMigration(record, filename, migrations = MIGRATIONS) {
  if (!record || typeof record !== 'object' || !filename) return null;
  const { field, prefix } = currentOutletId(record, filename);
  for (const m of migrations) {
    const hit = m.from.includes(field) ? field : (m.from.includes(prefix) ? prefix : null);
    if (!hit) continue;
    if (m.match && !m.match(record)) continue;
    const dash = filename.indexOf('--');
    if (dash < 0) continue;
    const newFilename = `${m.to}${filename.slice(dash)}`;
    const newData = { ...record, outletId: m.to, outlet: m.toName };
    return { rule: m.id, from: hit, to: m.to, newFilename, newData };
  }
  return null;
}

// --- duplicate resolution (same article filed under two ids) ---

function canonUrl(url) {
  return String(url || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** Same article = same url once protocol, www, query/fragment and a trailing slash are ignored. */
function sameArticleUrl(a, b) {
  const x = canonUrl(a), y = canonUrl(b);
  return !!x && x === y;
}

/**
 * How much a copy deserves to be the one that stays. A copy already excluded from scoring
 * (duplicate pointer, wrong production/show, non-review, invalid tier) loses to one that
 * counts; then a scored copy beats an unscored one; then the longer text wins. Ties keep the
 * copy that already sits at the destination.
 */
function keeperScore(rec) {
  let score = 0;
  if (rec.duplicateOf || rec.wrongProduction || rec.wrongShow || rec.isNonReview || rec.isRoundupArticle || rec.contentTier === 'invalid') score -= 1000;
  if (rec.assignedScore != null) score += 100;
  score += Math.min(50, Math.floor(String(rec.fullText || '').length / 1000));
  return score;
}

/** @returns {'destination'|'incoming'} which of two same-article copies stays */
function chooseKeeper(destination, incoming) {
  return keeperScore(incoming) > keeperScore(destination) ? 'incoming' : 'destination';
}

module.exports = { MIGRATIONS, planOutletMigration, hostOf, sameArticleUrl, canonUrl, keeperScore, chooseKeeper };
