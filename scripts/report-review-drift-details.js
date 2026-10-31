#!/usr/bin/env node
/**
 * report-review-drift-details.js (BRO-5274 / BRO-5275 / BRO-4270)
 *
 * Read-only. Prints metadata (never review text) for the corpus-drift classes
 * that need a per-row decision, so an approved-fix plan can be written from
 * facts. Run in cloud with:
 *   node scripts/cloud-run-script.js --review-texts scripts/report-review-drift-details.js --class=dups
 *
 *   --class=dups      duplicate (showDir|outlet|critic) groups (audit-review-key-duplicates.js)
 *   --class=outlets   unregistered outlet ids (audit-unknown-outlets.js)
 *   --class=bwwhub    files whose url is a broadwayworld.com/shows/<Title>-<id>.html hub
 */

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isRejectedNonReview } = require('./lib/review-guards');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const RT = path.join(ROOT, 'data', 'review-texts');

function* eachReview(opts = {}) {
  for (const showDir of listShowDirs(RT, opts)) {
    const dir = path.join(RT, showDir);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!isReviewTextFile(file)) continue;
      try {
        yield { showDir, file, data: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) };
      } catch { /* unreadable: the audits skip it too */ }
    }
  }
}

function bylineHit(nameOrSlug, d) {
  const name = String(nameOrSlug || '').replace(/-/g, ' ').trim().toLowerCase();
  if (!name || name === 'unknown') return null;
  const body = String(d.fullText || d.text || '').toLowerCase();
  const zone = body.slice(0, 900) + ' ' + body.slice(-500);
  const surname = name.split(/\s+/).pop();
  return surname.length >= 3 && zone.includes(surname);
}

const brief = (r) => {
  const d = r.data;
  const textLen = Math.max((d.fullText || '').length, (d.text || '').length);
  return {
    f: `${r.showDir}/${r.file}`,
    url: d.url || null,
    critic: d.criticName || null,
    textLen,
    tier: d.contentTier || null,
    hrs: d.humanReviewScore ?? null,
    orig: d.originalScore ?? null,
    llm: d.llmScore?.score ?? d.llmScore ?? null,
    assigned: d.assignedScore ?? null,
    collected: d.dateCollected || d.collectedAt || null,
    src: d.source || null,
    dupOf: d.duplicateOf || null,
    // Byline evidence without printing text: does the article's head/tail name the
    // critic the filename claims, and the one criticName claims?
    bylineFile: bylineHit(`${r.file}`.replace(/\.json$/, '').split('--')[1], d),
    bylineField: bylineHit(d.criticName, d),
    locked: d._locked || undefined,
  };
};

function dups() {
  const groups = new Map();
  for (const r of eachReview({ skipHolding: true })) {
    const d = r.data;
    if (d.duplicateOf || d.wrongProduction || d.wrongShow || d.wrongUrl || isRejectedNonReview(d)) continue;
    const key = `${r.showDir}|${(d.outletId || '').toLowerCase() || (d.outlet || '').toLowerCase()}|${(d.criticName || 'unknown').toLowerCase().trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(brief(r));
  }
  const out = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.log(JSON.stringify(out.map(([key, files]) => ({ key, files })), null, 0));
}

function outlets() {
  const registry = require(path.join(ROOT, 'data', 'outlet-registry.json'));
  const valid = new Set(Object.keys(registry.outlets || {}));
  for (const a of Object.keys(registry._aliasIndex || {})) valid.add(a);
  for (const o of Object.values(registry.outlets || {})) (o.aliases || []).forEach((a) => valid.add(a));
  const by = new Map();
  for (const r of eachReview()) {
    const d = r.data;
    if (d.duplicateOf || d.wrongProduction || d.wrongShow || d.wrongUrl || isRejectedNonReview(d)) continue;
    const id = d.outletId;
    if (!id || id === 'unknown' || valid.has(id) || id.split('-').length > 6) continue;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push({ ...brief(r), outlet: d.outlet || null });
  }
  console.log(JSON.stringify([...by.entries()].map(([id, files]) => ({ id, n: files.length, files: files.slice(0, 6) }))));
}

function bwwhub() {
  const HUB = /^https?:\/\/(www\.)?broadwayworld\.com\/shows\/[^/]+$/i;
  const rows = [];
  for (const r of eachReview()) {
    const u = r.data.url || '';
    if (HUB.test(u) || /dailymail\.co\.uk\/mailonsunday\/index\.html/.test(u)) {
      const siblings = fs.readdirSync(path.join(RT, r.showDir)).filter((f) => f.endsWith('.json') && f !== r.file && !f.startsWith('_'));
      rows.push({ ...brief(r), outlet: r.data.outlet || null, outletId: r.data.outletId || null, excluded: !!(r.data.duplicateOf || r.data.wrongProduction || r.data.wrongShow || r.data.wrongUrl), nSiblings: siblings.length, head: String(r.data.fullText || r.data.text || '').replace(/\s+/g, ' ').slice(0, 220), sameTextSibling: siblings.find((sf) => { try { const o = JSON.parse(fs.readFileSync(path.join(RT, r.showDir, sf), 'utf8')); const a = String(o.fullText || '').slice(0, 300); return a && a === String(r.data.fullText || '').slice(0, 300); } catch { return false; } }) || null, urlCorrectedFrom: r.data.urlCorrectedFrom || null });
    }
  }
  console.log(JSON.stringify(rows));
}

if (require.main === module) {
  if (hasHelpFlag(process.argv)) {
    console.log('Usage: node scripts/report-review-drift-details.js --class=dups|outlets|bwwhub');
    process.exit(0);
  }
  const cls = (process.argv.find((a) => a.startsWith('--class=')) || '').slice(8);
  if (!fs.existsSync(RT)) { console.error('review-texts corpus missing'); process.exit(2); }
  ({ dups, outlets, bwwhub })[cls] ? ({ dups, outlets, bwwhub })[cls]() : (console.error('need --class=dups|outlets|bwwhub'), process.exit(2));
}

module.exports = { brief };
