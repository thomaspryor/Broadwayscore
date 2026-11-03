#!/usr/bin/env node
/**
 * audit-critic-splits.js (BRO-6928)
 *
 * Finds critic pages in data/reviews.json that are probably the same person
 * under two bylines (typo, transposed letters, nickname, extra words) using
 * scripts/lib/critic-variant-match.js.
 *
 *   node scripts/audit-critic-splits.js            # report
 *   node scripts/audit-critic-splits.js --json     # machine-readable
 *   node scripts/audit-critic-splits.js --strict   # exit 1 on a merge/review pair
 *                                                  # that is not in the baseline
 *   node scripts/audit-critic-splits.js --update-baseline
 *
 * Pairs a human confirmed are different people live in
 * data/audit/critic-distinct-people.json ({ "pairs": ["slug-a|slug-b", ...] },
 * sorted slugs). Pairs still waiting on a merge decision live in
 * data/audit/critic-splits-baseline.json so only NEW splits fail the gate.
 * Merges themselves go to data/auto-critic-aliases.json (scripts/detect-critic-typos.js
 * --from-reviews writes them), which review-normalization already applies at load.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { criticProfileKey } = require('./lib/url-slug');
const { classifyVariantPair, foldTokens } = require('./lib/critic-variant-match');

const ROOT = path.join(__dirname, '..');
const REVIEWS = path.join(ROOT, 'data', 'reviews.json');
const DISTINCT = path.join(ROOT, 'data', 'audit', 'critic-distinct-people.json');
const BASELINE = path.join(ROOT, 'data', 'audit', 'critic-splits-baseline.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Collapse reviews into critic pages the way src/lib/data-reviews.ts does. */
function buildPages(reviews) {
  const pages = new Map();
  for (const r of reviews) {
    if (r.inheritedFromShowId || !r.criticName) continue;
    const slug = criticProfileKey(r.criticName);
    if (!slug) continue;
    let p = pages.get(slug);
    if (!p) { p = { slug, name: r.criticName, count: 0, outlets: new Set(), spell: new Map() }; pages.set(slug, p); }
    p.count++;
    p.outlets.add(r.outlet);
    p.spell.set(r.criticName, (p.spell.get(r.criticName) || 0) + 1);
  }
  for (const p of pages.values()) {
    p.name = [...p.spell.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0][0];
  }
  return pages;
}

/** All candidate pairs, bucketed so this stays near-linear. */
function findSplitPairs(pages, opts = {}) {
  const buckets = new Map();
  const add = (key, p) => { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(p); };
  for (const p of pages.values()) {
    const t = foldTokens(p.name);
    if (!t.length) continue;
    add('L:' + t[t.length - 1], p);            // same last name
    add('F:' + t[0] + (t.length > 1 ? '' : '!'), p);  // same first name (last-name typos)
    if (t.length >= 3) add('L:' + t[t.length - 1], p);
    // extra leading words: also bucket under the last two tokens
    if (t.length >= 2) add('T:' + t.slice(-2).join(' '), p);
    // transposed or typo'd last names: bucket by first 3 letters of last name
    add('P:' + t[0] + ':' + t[t.length - 1].slice(0, 3), p);
    add('S:' + t[0].slice(0, 3) + ':' + t[t.length - 1].slice(-3), p);
  }
  const seen = new Set();
  const out = [];
  for (const list of buckets.values()) {
    if (list.length > 400) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.slug === b.slug) continue;
      const key = [a.slug, b.slug].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const res = classifyVariantPair(a, b, opts);
      if (res.verdict === 'distinct') continue;
      const [canon, typo] = res.canonical === 'a' ? [a, b] : [b, a];
      out.push({ key, verdict: res.verdict, relation: res.relation, reason: res.reason,
        canonical: { slug: canon.slug, name: canon.name, count: canon.count },
        variant: { slug: typo.slug, name: typo.name, count: typo.count } });
    }
  }
  // A name that contains TWO other pages' names is a joint byline, whatever the
  // pairwise rule said: one alias cannot serve both critics.
  const targets = new Map();
  for (const o of out) {
    if (o.relation !== 'extra') continue;
    if (!targets.has(o.variant.slug)) targets.set(o.variant.slug, new Set());
    targets.get(o.variant.slug).add(o.canonical.slug);
  }
  for (const o of out) {
    if (o.relation === 'extra' && targets.get(o.variant.slug).size > 1 && o.verdict === 'merge') {
      o.verdict = 'review';
      o.reason = 'joint byline: contains two critics\' names';
    }
  }
  // A critic whose name is also an outlet (Carole Di Tosti's own blog) cannot be an alias
  // key: critic-alias-picker.test.mjs forbids outlet-named keys. A human routes those.
  const outletSlugs = new Set();
  for (const p of pages.values()) for (const o of p.outlets) outletSlugs.add(criticProfileKey(o));
  for (const o of out) {
    if (o.verdict === 'merge' && outletSlugs.has(o.canonical.slug)) {
      o.verdict = 'review';
      o.reason = 'canonical name is also an outlet name';
    }
  }
  return out.sort((x, y) => (y.canonical.count + y.variant.count) - (x.canonical.count + x.variant.count));
}

/**
 * Write every 'merge' pair into data/auto-critic-aliases.json (the same table the
 * weekly typo detector fills). recordAlias refuses to claim a string another key
 * owns. Returns the number of aliases added.
 */
function applyMerges(pairs, aliasPath = path.join(ROOT, 'data', 'auto-critic-aliases.json')) {
  const { recordAlias } = require('./lib/critic-alias-picker');
  const doc = readJson(aliasPath, { aliases: {} });
  if (!doc.aliases || typeof doc.aliases !== 'object') doc.aliases = {};
  let added = 0;
  for (const p of pairs.filter(x => x.verdict === 'merge')) {
    const res = recordAlias(doc.aliases, p.canonical.slug, p.variant.slug.replace(/-/g, ' '));
    if (res.added) added++;
  }
  if (added) {
    doc._lastUpdated = new Date().toISOString();
    fs.writeFileSync(aliasPath, JSON.stringify(doc, null, 2) + '\n');
  }
  return added;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/audit-critic-splits.js [--json] [--strict] [--update-baseline] [--apply]\nFinds critic pages split by byline spelling variants (BRO-6928).');
    process.exit(0);
  }
  const reviews = readJson(REVIEWS, null);
  if (!reviews || !Array.isArray(reviews.reviews)) {
    console.log('data/reviews.json missing; nothing to audit (core data not attached).');
    process.exit(0);
  }
  const distinct = loadDistinct();
  const pairs = findSplitPairs(buildPages(reviews.reviews), { distinct });
  if (argv.includes('--update-baseline')) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({ pairs: pairs.map(p => p.key).sort() }, null, 2) + '\n');
    console.log(`baseline written: ${pairs.length} pairs`);
    process.exit(0);
  }
  if (argv.includes('--apply')) {
    console.log(`aliases added: ${applyMerges(pairs)}`);
    process.exit(0);
  }
  if (argv.includes('--json')) { console.log(JSON.stringify(pairs, null, 2)); process.exit(0); }
  for (const p of pairs) {
    console.log(`${p.verdict.toUpperCase().padEnd(6)} ${p.variant.slug} (${p.variant.count}) -> ${p.canonical.slug} (${p.canonical.count})  [${p.reason}]`);
  }
  console.log(`\n${pairs.filter(p => p.verdict === 'merge').length} merge, ${pairs.filter(p => p.verdict === 'review').length} review`);
  if (argv.includes('--strict')) {
    const base = new Set((readJson(BASELINE, { pairs: [] }).pairs) || []);
    const fresh = pairs.filter(p => !base.has(p.key));
    if (fresh.length) {
      console.error(`\n${fresh.length} NEW split pair(s) not in the baseline:`);
      fresh.forEach(p => console.error(`  ${p.variant.slug} -> ${p.canonical.slug}`));
      process.exit(1);
    }
  }
}

/** The confirmed-different-people allowlist as a Set of "slugA|slugB". */
function loadDistinct() {
  return new Set((readJson(DISTINCT, { pairs: [] }).pairs) || []);
}

module.exports = { buildPages, findSplitPairs, applyMerges, loadDistinct };
