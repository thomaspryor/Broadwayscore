#!/usr/bin/env node
/**
 * audit-feature-as-review.js — read-only (BRO-5420).
 *
 * Lists LIVE review files (explainExclusion null) that look like a feature,
 * news item, interview or blog post rather than a critic's review, by two
 * signals:
 *   url  — the path is a blog / news / interview / feature / Q&A page
 *          (artsbeat.blogs.nytimes.com, /blogs/, /news/, /interview, /feature,
 *          /q-and-a/, /behind-the-scenes, /the-men-behind ...);
 *   text — the body reports another critic's verdict ("In his review, Charles
 *          Isherwood calls ...", "the Times critic wrote ...").
 * million-dollar-quartet-2010 counted an ArtsBeat post on the actors as an NYT
 * review (75), diluting Isherwood's real one.
 *
 * Prints ids, outlet, critic, url, the signal and up to 160 characters of text
 * around a text match for the hand check. Output is sealed by cloud-run-script;
 * never paste it into public files.
 *
 * Usage: node scripts/audit-feature-as-review.js [--show=a,b] [--shard=i/n] [--limit=N]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { explainExclusion } = require('./lib/review-guards');
const { featureUrlSignal, paraphrasedReviewSignal } = require('./lib/feature-as-review');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const onlyShows = val('show') ? val('show').split(',') : null;
const limit = Number(val('limit') || 400);
const [shardIdx, shardCount] = (val('shard') || '0/1').split('/').map(Number);

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const showById = Object.fromEntries((Array.isArray(raw) ? raw : (raw.shows || [])).map((s) => [s.id, s]));
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }
  const shows = (onlyShows || fs.readdirSync(textsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort())
    .filter((_, i) => i % shardCount === shardIdx);
  const hits = [];
  let scanned = 0;
  for (const show of shows) {
    const dir = path.join(textsDir, show);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      const urlSig = featureUrlSignal(r.url);
      const textSig = paraphrasedReviewSignal(r.fullText);
      if (!urlSig && !textSig) continue;
      scanned++;
      let excl;
      try { excl = explainExclusion(r, showById[show] || null, path.join(dir, file)); } catch (e) { excl = `error: ${e.message}`; }
      if (excl) continue;
      hits.push({ show, file, outlet: r.outletId || null, critic: r.criticName || null, url: r.url || null,
        urlSig, textSig: textSig ? textSig.match : null, ctx: textSig ? textSig.context : null,
        score: r.llmScore && r.llmScore.score !== undefined ? r.llmScore.score : null });
    }
  }
  console.log(`candidate files: ${scanned}; live: ${hits.length}${shardCount > 1 ? ` (shard ${shardIdx}/${shardCount})` : ''}`);
  console.log('show | file | outlet | critic | score | url signal | text signal | url | context');
  for (const h of hits.slice(0, limit)) {
    console.log([h.show, h.file, h.outlet, h.critic, h.score, h.urlSig || '-', h.textSig || '-', h.url, h.ctx ? JSON.stringify(h.ctx) : '-'].join(' | '));
  }
}

if (require.main === module) main();
