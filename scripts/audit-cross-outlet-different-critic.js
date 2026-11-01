#!/usr/bin/env node
/**
 * audit-cross-outlet-different-critic.js (BRO-6759)
 *
 * Census of review-text files flagged crossOutletDuplicate whose primary file is
 * by a DIFFERENT critic. Such a flag hides a review, so it must be backed by
 * evidence: classifyCrossOutletPair() says flag (alias, verified family,
 * provenance, near-identical bylineless) or the file carries
 * crossOutletVerified=true (a person/agent confirmed the pair, with the proof in
 * crossOutletVerifiedReason). Anything else is UNVERIFIED: the earlier
 * detect-cross-outlet-duplicates.js hid a real Deadline rave (appropriate-2023)
 * behind a Guardian row that held Deadline's text.
 *
 * Also reports STALE flags: the primary's text no longer matches (<20% shared
 * 8-grams), so the flag hides a review for no current reason.
 *
 * Usage: node scripts/audit-cross-outlet-different-critic.js [--strict] [--json]
 *   --strict  exit 1 when any UNVERIFIED or STALE flag remains
 */
const fs = require('fs');
const path = require('path');
const { classifyCrossOutletPair, isPlaceholderCritic, sameCritic } = require('./lib/cross-outlet-pair-policy');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');

function grams(text, n = 8) {
  const w = String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const s = new Set();
  for (let i = 0; i <= w.length - n; i++) s.add(w.slice(i, i + n).join(' '));
  return s;
}

/** Share of the smaller text's 8-grams found in the other (0-100). */
function containment(a, b) {
  const ga = grams(a);
  const gb = grams(b);
  const small = ga.size <= gb.size ? ga : gb;
  const big = ga.size <= gb.size ? gb : ga;
  if (!small.size) return 0;
  let hit = 0;
  for (const g of small) if (big.has(g)) hit++;
  return Math.round((100 * hit) / small.size);
}

function audit(root) {
  const rows = [];
  for (const showId of fs.readdirSync(root)) {
    const dir = path.join(root, showId);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!d.crossOutletDuplicate || !d.crossOutletPrimaryFile) continue;
      let p;
      try { p = JSON.parse(fs.readFileSync(path.join(root, d.crossOutletPrimaryFile), 'utf8')); } catch {
        rows.push({ showId, file: f, status: 'primary-missing', primary: d.crossOutletPrimaryFile });
        continue;
      }
      if (sameCritic(d.criticName, p.criticName) && !isPlaceholderCritic(d.criticName) && !isPlaceholderCritic(p.criticName)) continue;
      const row = { showId, file: f, primary: d.crossOutletPrimaryFile, secondaryCritic: d.criticName, primaryCritic: p.criticName };
      if (d.crossOutletVerified === true) { rows.push({ ...row, status: 'verified-by-person' }); continue; }
      const shared = containment(d.fullText, p.fullText);
      if (shared < 20) { rows.push({ ...row, status: 'stale', shared }); continue; }
      const A = { outletId: p.outletId, outlet: p.outlet, criticName: p.criticName, text: p.fullText || '' };
      const B = { outletId: d.outletId, outlet: d.outlet, criticName: d.criticName, text: d.fullText || '' };
      const v = classifyCrossOutletPair(A, B, { similarity: d.crossOutletSimilarity || shared });
      if (v.action === 'review') rows.push({ ...row, status: 'unverified', shared });
      else if (v.copy === 'a') rows.push({ ...row, status: 'primary-is-the-copy', shared });
      else rows.push({ ...row, status: 'ok:' + v.reason, shared });
    }
  }
  return rows;
}

module.exports = { audit, containment };

if (require.main === module) {
  const args = process.argv.slice(2);
  const root = resolveReviewTextsDir ? resolveReviewTextsDir() : path.join(__dirname, '../data/review-texts');
  if (!root || !fs.existsSync(root)) { console.log('review-texts not available; skipping'); process.exit(0); }
  const rows = audit(root);
  const by = {};
  rows.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
  const bad = rows.filter((r) => ['unverified', 'stale', 'primary-is-the-copy', 'primary-missing'].includes(r.status));
  if (args.includes('--json')) console.log(JSON.stringify({ counts: by, bad }, null, 2));
  else {
    console.log('Different-critic cross-outlet flags:', JSON.stringify(by));
    bad.slice(0, 60).forEach((r) => console.log(`  ${r.status.padEnd(20)} ${r.showId}/${r.file} <- ${r.primary} (${r.secondaryCritic} / ${r.primaryCritic}) shared=${r.shared ?? '-'}`));
    if (bad.length > 60) console.log(`  ... ${bad.length - 60} more`);
  }
  process.exit(args.includes('--strict') && bad.length ? 1 : 0);
}
