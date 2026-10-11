#!/usr/bin/env node
'use strict';
/**
 * audit-coverage-holes.js (BRO-4849, BRO-4838) — counts the classes of "found reviews that never reach the site
 * correctly" across every show open or opened in the last 120 days. Predicates live in scripts/lib/coverage-holes.js.
 *
 *   node scripts/audit-coverage-holes.js [--json=PATH] [--days=120] [--show=ID] [--strict] [--list=A|B|C|D|E|F]
 *                                        [--recent-days=14] [--alert]
 *
 * Advisory by default (exit 0). --strict exits 1 when A, B, C or a PUBLISHED D row (or an unreadable file) exists (arm only after the backlog is triaged,
 * CLAUDE.md section 19: new gates land advisory first).
 *
 * --alert (data-health-check.yml, daily): for shows opened within --recent-days, route the rows that need a person
 * (B: a review rejected although its verification says review; F: a published score outside the critic's band that
 * no re-score is queued for) to the owner digest, keyed per show so each show's line clears on its own. A, C, D and
 * E are counted in the step summary only: their remedies are automatic (the hourly gap audit's ingestion, the nightly
 * scorer, the rebuild's runtime block, the enrich-reviews star capture) or need a URL nobody has yet.
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage:\n  node scripts/audit-coverage-holes.js [--json=PATH] [--days=120] [--show=ID] [--strict] [--list=A|B|C|D|E|F] [--recent-days=14] [--alert]\n  --strict       exit 1 on any A, B or C row, a published D row, or an unreadable file (advisory by default)\n  --list=X       print every row of one class\n  --recent-days  window for the --alert rows (default 14)\n  --alert        route B and unqueued F rows of recently opened shows to the owner digest, per show');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');
const holes = require('./lib/coverage-holes');

const ROOT = path.join(__dirname, '..');
const CLASSES = ['A', 'B', 'C', 'D', 'E', 'F'];
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
// reviews.json URLs and review-file URLs differ in scheme, www, query and trailing slash.
const normUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();

function sweep({ root = ROOT, days = 120, only = null, now = Date.now(), recentDays = 14 } = {}) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
  const shows = (Array.isArray(raw) ? raw : raw.shows || []).filter((s) => (only ? s.id === only : holes.isCurrentShow(s, now, days)));
  // reviews.json is the source of truth for what the site shows: D rows that are PUBLISHED are the ones doing harm,
  // and F is judged on the published score.
  const published = new Map();
  try {
    for (const r of JSON.parse(fs.readFileSync(path.join(root, 'data', 'reviews.json'), 'utf8')).reviews || []) {
      if (r && r.showId && r.url) published.set(`${r.showId}|${normUrl(r.url)}`, r);
    }
  } catch { /* none readable: published counts stay 0 */ }
  const out = { shows: shows.length, files: 0, unreadable: 0, showsAffected: 0, recentShows: [] };
  for (const k of CLASSES) out[k] = [];
  const affected = new Set();
  for (const show of shows) {
    const opened = Date.parse(show.openingDate || '');
    const recent = Number.isFinite(opened) && opened <= now && now - opened <= recentDays * 864e5;
    if (recent) out.recentShows.push(show.id);
    const dir = path.join(root, 'data', 'review-texts', show.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
      const filePath = path.join(dir, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { out.unreadable++; continue; } // counted: corruption must not hide
      out.files++;
      const row = d.url ? published.get(`${show.id}|${normUrl(d.url)}`) : null;
      const c = holes.classify(d, show, filePath, row && typeof row.assignedScore === 'number' ? row.assignedScore : undefined);
      if (c.D) c.D = { ...c.D, published: !!row };
      for (const [k, v] of Object.entries(c)) {
        out[k].push({ file: `${show.id}/${f}`, show: show.id, outletId: d.outletId || null, recent, ...v });
        affected.add(show.id);
      }
    }
  }
  out.showsAffected = affected.size;
  return out;
}

/** Rows a person has to act on for one show: B, and F with no re-score queued. */
function needsPerson(out, showId) {
  return [
    ...out.B.filter((r) => r.show === showId).map((r) => ({ cls: 'B', ...r })),
    ...out.F.filter((r) => r.show === showId && !r.queued).map((r) => ({ cls: 'F', ...r })),
  ];
}

function summary(out) {
  const tally = (rows, key) => rows.reduce((a, r) => { const k = String(r[key]); a[k] = (a[k] || 0) + 1; return a; }, {});
  const recent = (rows) => rows.filter((r) => r.recent).length;
  return [
    `shows=${out.shows} files=${out.files} unreadable=${out.unreadable} showsAffected=${out.showsAffected} recentShows=${out.recentShows.length}`,
    `A noUsableText=${out.A.length} (recent ${recent(out.A)}) ${JSON.stringify(tally(out.A, 'bucket'))}`,
    `B rejectedYetVerified=${out.B.length} (recent ${recent(out.B)}) urlOtherShow=${out.B.filter((r) => r.urlOtherShow).length} (repair the URL) / ${out.B.filter((r) => !r.urlOtherShow).length} (read the text) blockedBy=${JSON.stringify(tally(out.B, 'blockedBy'))}`,
    `C neverScored=${out.C.length} (recent ${recent(out.C)}) alreadyQueued=${out.C.filter((r) => r.queued).length}`,
    `D blockedUrlUnflagged=${out.D.length} ${JSON.stringify(tally(out.D, 'kind'))} publishedOnSite=${out.D.filter((r) => r.published).length} (the harm; the rest is hygiene)`,
    `E uncapturedStar=${out.E.length} (recent ${recent(out.E)})`,
    `F scoreOutsideBand=${out.F.length} (recent ${recent(out.F)}) queued=${out.F.filter((r) => r.queued).length}`,
  ].join('\n');
}

async function alert(out) {
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router.js');
  let raised = 0;
  for (const showId of out.recentShows) {
    const key = `coverage-holes:${showId}`;
    const rows = needsPerson(out, showId);
    if (!rows.length) { resolveCondition(key, { reason: 'no rejected-but-verified review and no unqueued out-of-band score' }); continue; }
    raised++;
    const lines = rows.map((r) => (r.cls === 'B'
      ? `- rejected as not-a-review, verification says review: ${r.file}${r.urlOtherShow ? ' (stored URL looks like another show: repair the URL)' : ''}`
      : `- published ${r.score} outside the critic's band ${r.band} (${r.rating}): ${r.file}`));
    await routeAlert({
      conditionKey: key,
      title: `${showId}: ${rows.length} review(s) need a decision (rejected real review or score outside the critic's rating)`,
      description: `${lines.join('\n')}\n\nRead each text. Genuine review: clear isNonReview / rejectionReason (and rejectedAt/rejectedBy from the same verdict) with nonReviewManualClear via data/pending-fixes (model: bro-4838-b.json). Out-of-band score: store the outlet's own rating as originalScore if it is real, else correct the rating.`,
      severity: 'warning',
      disposition: 'digest',
      cooldownHours: 20,
    });
  }
  return raised;
}

module.exports = { sweep, summary, needsPerson, normUrl };

if (require.main === module) {
  (async () => {
    const out = sweep({ days: Number(arg('days') || 120), only: arg('show'), recentDays: Number(arg('recent-days') || 14) });
    const text = summary(out);
    console.log(text);
    const list = arg('list');
    if (list && out[list]) for (const r of out[list]) console.log(JSON.stringify(r));
    if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(out, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Coverage holes\n\`\`\`\n${text}\n\`\`\`\n`); } catch { /* cosmetic */ }
    }
    if (process.argv.includes('--alert')) console.log(`alert: ${await alert(out)} recently opened show(s) routed to the digest`);
    // D only counts when published: a blocked URL the rebuild already drops is hygiene, not a leak.
    if (process.argv.includes('--strict') && (out.A.length || out.B.length || out.C.length || out.D.some((r) => r.published) || out.unreadable)) process.exit(1);
  })().catch((err) => { console.error(`[coverage-holes] ${err.stack || err.message}`); process.exitCode = 0; });
}
