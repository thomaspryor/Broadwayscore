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
