#!/usr/bin/env node
/**
 * audit-scored-other-critic.js — read-only (BRO-5420 follow-up).
 *
 * dreamgirls-1981: an AP review by Mary Campbell was filed as the Daily News /
 * Douglas Watt row; it closes with a "what the critics said" roundup quoting
 * Watt, and all three scoring models scored Watt's quote (42) instead of
 * Campbell's rave (87). Any review that quotes other critics (wire pieces,
 * newspaper roundups, features citing a review) can be scored on the wrong
 * verdict.
 *
 * Lists LIVE scored files whose stored llmScore evidence points at someone
 * other than the row's critic:
 *   - the reasoning says it used a quoted / target / roundup verdict
 *     ("target critic", "quoted", "roundup", "other critics", "according to"),
 *   - or a keyPhrase / the reasoning attributes the verdict to a named person
 *     ("X said", "X's assessment", "X calls") whose surname is not the critic's.
 * Prints the critic, score, the matched evidence and the reasoning head for a
 * hand check. Output is sealed by cloud-run-script; never paste review text
 * into public files.
 *
 * Usage: node scripts/audit-scored-other-critic.js [--show=a,b] [--shard=i/n] [--limit=N]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { explainExclusion } = require('./lib/review-guards');
const { otherCriticEvidence } = require('./lib/scored-other-critic');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const onlyShows = val('show') ? val('show').split(',') : null;
const limit = Number(val('limit') || 300);
const [shardIdx, shardCount] = (val('shard') || '0/1').split('/').map(Number);

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const showById = Object.fromEntries((Array.isArray(raw) ? raw : (raw.shows || [])).map((s) => [s.id, s]));
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }
  const shows = (onlyShows || fs.readdirSync(textsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort())
    .filter((_, i) => i % shardCount === shardIdx);
  const hits = [];
  let scored = 0;
  for (const show of shows) {
    const dir = path.join(textsDir, show);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (!r.llmScore || r.llmScore.score === undefined) continue;
      scored++;
      const ev = otherCriticEvidence(r);
      if (!ev) continue;
      let excl;
      try { excl = explainExclusion(r, showById[show] || null, path.join(dir, file)); } catch (e) { excl = `error: ${e.message}`; }
      if (excl) continue;
      hits.push({ show, file, critic: r.criticName || null, outlet: r.outletId || null, score: r.llmScore.score, ev,
        reasoning: String(r.llmScore.reasoning || '').replace(/\s+/g, ' ').slice(0, 260) });
    }
  }
  console.log(`scored files: ${scored}; live with other-critic evidence: ${hits.length}${shardCount > 1 ? ` (shard ${shardIdx}/${shardCount})` : ''}`);
  console.log('show | file | outlet | critic | score | evidence | reasoning head');
  for (const h of hits.slice(0, limit)) {
    console.log([h.show, h.file, h.outlet, h.critic, h.score, JSON.stringify(h.ev), JSON.stringify(h.reasoning)].join(' | '));
  }
}

if (require.main === module) main();
