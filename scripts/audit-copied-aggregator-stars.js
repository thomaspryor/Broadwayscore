#!/usr/bin/env node
/**
 * audit-copied-aggregator-stars.js (BRO-6018): finds review-text files that carry a SOURCELESS
 * aggregatorStars (no aggregatorStarsSource) equal to the stars on a same-show sibling from the
 * same outlet family (same registrable host, or outlet names sharing a stem such as Daily Mail
 * and Mail on Sunday). Those stars were relayed from the sibling, not read from the critic's
 * own page, and they anchor the score. Report only: no prose, no writes.
 *
 *   node scripts/audit-copied-aggregator-stars.js [--json] [--show=ID]
 *   (needs data/review-texts; in cloud: scripts/cloud-run-script.js --review-texts ...)
 */
'use strict';
const fs = require('fs');
const path = require('path');
if (require('./lib/cli-help.js').hasHelpFlag(process.argv.slice(2))) {
  console.log('audit-copied-aggregator-stars.js [--json] [--show=ID] [--strong]: sourceless aggregatorStars equal to a same-outlet-family sibling (read-only)');
  process.exit(0);
}
const ROOT = path.join(__dirname, '..');

// Round-up / aggregator pages list many outlets, so a shared host there proves nothing.
const AGG_HOSTS = new Set(['westendtheatre.com', 'theatre-reviews.com', 'theatrereviews.com', 'londonboxoffice.co.uk', 'thestage.co.uk', 'stagedoor.com', 'showscore.com', 'didtheylikeit.com', 'playbill.com', 'broadwayworld.com', 'nytheatre.com', 'nyctheatre.com', 'theatre.reviews']);
function host(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '').split('.');
    const sl = /^(co|com|org|net|ac|gov)$/.test(h[h.length - 2] || '') && h[h.length - 1].length === 2;
    return h.slice(sl ? -3 : -2).join('.');
  } catch (_) { return ''; }
}
// Only the Daily Mail / Mail on Sunday pair is matched by name; generic shared words
// ("post", "news", "journal") are not a family.
const { foldDiacritics } = require('./lib/title-match');
const isMail = (rec) => /\bmail\b/.test(foldDiacritics(String(rec.outletId || rec.outlet || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' '));
function sameFamily(a, b) {
  if (a.outletId && a.outletId === b.outletId) return true;
  const ha = host(a.url); const hb = host(b.url);
  if (ha && ha === hb && !AGG_HOSTS.has(ha)) return true;
  return isMail(a) && isMail(b);
}
const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase();

// Does the article text itself carry any star rating? Boolean only, the prose never leaves this function.
const STAR_EVIDENCE = /[\u2605\u2606\u2B50]|\b[1-5](?:\.5)?\s*(?:\/|out of)\s*5\b|\b(?:one|two|three|four|five|[1-5])[- ]stars?\b|\bstar rating\b/i;
const textHasStarEvidence = (d) => (typeof d.fullText === 'string' && d.fullText.length > 200) ? STAR_EVIDENCE.test(d.fullText) : null;

/** Pure: files = [{file, data}] of one show -> findings (no prose). */
function findCopiedStars(files) {
  const out = [];
  for (const f of files) {
    const d = f.data;
    if (d.aggregatorStars == null || d.aggregatorStarsSource) continue;
    const sib = files.find((g) => g.file !== f.file && g.data.aggregatorStars != null
      && norm(g.data.aggregatorStars) === norm(d.aggregatorStars)
      && (g.data.criticName !== d.criticName || g.data.outletId !== d.outletId)
      && sameFamily(d, g.data));
    if (sib) {
      out.push({ file: f.file, outletId: d.outletId, critic: d.criticName || null, stars: d.aggregatorStars, scoreSource: d.scoreSource || null,
        assignedScore: d.assignedScore ?? null, hasOwnOriginalScore: d.originalScore != null, siblingFile: sib.file, siblingSourced: !!sib.data.aggregatorStarsSource, textHasStarEvidence: textHasStarEvidence(d),
        // 'copy' only when the sibling carries evidence the stars are its own (a source, or its own outlet rating) and this row does not;
        // otherwise 'ambiguous' (either side may be the original): read both before writing a plan, never clear both.
        verdict: (sib.data.aggregatorStarsSource || (sib.data.originalScore != null && d.originalScore == null)) ? 'copy' : 'ambiguous' });
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const dir = ['data/review-texts', '/home/user/broadway-review-texts/data/review-texts'].map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p));
  if (!dir) { console.error('data/review-texts not available'); process.exit(2); }
  const only = (argv.find((a) => a.startsWith('--show=')) || '').slice(7);
  const rows = [];
  for (const id of require('./lib/list-show-dirs').listShowDirs(dir, { silent: true }).filter((x) => !only || x === only)) {
    const base = path.join(dir, id);
    const files = fs.readdirSync(base).filter((f) => f.endsWith('.json')).map((f) => {
      try { return { file: f, data: JSON.parse(fs.readFileSync(path.join(base, f), 'utf8')) }; } catch (_) { return null; }
    }).filter(Boolean);
    for (const r of findCopiedStars(files)) rows.push({ showId: id, ...r });
  }
  // --strong: only rows whose own article text has no star rating at all (the stars cannot have come from this review).
  const shown = argv.includes('--strong') ? rows.filter((r) => r.textHasStarEvidence === false) : rows;
  rows.length = 0; rows.push(...shown);
  if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); return; }
  for (const r of rows) console.log(`${r.showId}/${r.file} outlet=${r.outletId} stars=${r.stars} score=${r.assignedScore} src=${r.scoreSource} ownOriginal=${r.hasOwnOriginalScore} verdict=${r.verdict} copiedFrom=${r.siblingFile}${r.siblingSourced ? ' (sourced)' : ''}`);
  console.log(`TOTAL ${rows.length} file(s) with copied sourceless aggregatorStars`);
}
module.exports = { findCopiedStars, sameFamily };
if (require.main === module) main();
