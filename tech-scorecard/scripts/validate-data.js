#!/usr/bin/env node
// Validates data/*.json before build. Exit 1 on any error.
// Guards the rules that keep scores honest: every review links to its source,
// published ratings convert exactly, and excerpts stay short quotes.
const fs = require('fs');
const path = require('path');

const errors = [];
const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const products = read('products.json');
const reviews = read('reviews.json');
const outlets = read('outlets.json');

const outletIds = new Set(outlets.map((o) => o.id));
const productIds = new Set(products.map((p) => p.id));
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
// Real calendar dates only (2026-13-40 fails).
const ISO = { test: (s) => ISO_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s };

for (const [label, ids] of [['product id', products.map((p) => p.id)], ['product slug', products.map((p) => p.slug)], ['outlet id', outlets.map((o) => o.id)]]) {
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dupes.length) errors.push(`duplicate ${label}: ${[...new Set(dupes)].join(', ')}`);
}

for (const o of outlets) {
  if (![1, 2, 3, 4].includes(o.tier)) errors.push(`outlet ${o.id}: tier must be 1-4`);
}
for (const p of products) {
  if (!ISO.test(p.releaseDate)) errors.push(`product ${p.id}: bad releaseDate`);
  for (const k of ['criticsTake', 'loved', 'gripes', 'specs', 'art']) if (!p[k]) errors.push(`product ${p.id}: missing ${k}`);
}

/** "4.5/5" -> 90, "9/10" -> 90, "4 stars" (out of 5) -> 80. null when the format is not numeric. */
function ratingToScore(rating) {
  const frac = rating.match(/^(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)(?:\s*stars?)?$/i);
  if (frac) return Math.round((parseFloat(frac[1]) / parseFloat(frac[2])) * 100);
  const pct = rating.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return Math.round(parseFloat(pct[1]));
  const stars = rating.match(/^(\d(?:\.\d)?)\s*stars?$/i);
  if (stars) return Math.round((parseFloat(stars[1]) / 5) * 100);
  return null;
}

const seen = new Set();
reviews.forEach((r, i) => {
  const at = `review #${i} (${r.productId}/${r.outletId})`;
  if (!productIds.has(r.productId)) errors.push(`${at}: unknown product`);
  if (!outletIds.has(r.outletId)) errors.push(`${at}: unknown outlet`);
  const key = `${r.productId}|${r.outletId}`;
  if (seen.has(key)) errors.push(`${at}: duplicate outlet for product`);
  seen.add(key);
  if (!/^https:\/\/[^\s]+$/.test(r.url || '')) errors.push(`${at}: url must be https`);
  else if (outletIds.has(r.outletId)) {
    // The link must go to the outlet the review is credited to (catches a swapped or pasted-wrong URL).
    const host = new URL(r.url).hostname.replace(/^www\./, '');
    const domain = outlets.find((o) => o.id === r.outletId).domain;
    if (host !== domain && !host.endsWith(`.${domain}`)) errors.push(`${at}: url host ${host} is not ${domain}`);
  }
  if (!ISO.test(r.date || '')) errors.push(`${at}: bad date`);
  if (!(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100)) errors.push(`${at}: score must be an integer 0-100`);
  if (!['rating', 'text'].includes(r.scoreSource)) errors.push(`${at}: scoreSource must be rating|text`);
  if (r.scoreSource === 'rating') {
    if (!r.rating) errors.push(`${at}: scoreSource "rating" needs a rating`);
    else {
      const expected = ratingToScore(r.rating);
      if (expected == null) errors.push(`${at}: cannot parse rating "${r.rating}"`);
      else if (expected !== r.score) errors.push(`${at}: rating ${r.rating} converts to ${expected}, not ${r.score}`);
    }
  }
  if (r.scoreSource === 'text' && r.rating) errors.push(`${at}: text-scored review must not carry a rating`);
  const words = (r.excerpt || '').trim().split(/\s+/).filter(Boolean).length;
  if (words === 0 || words > 45) errors.push(`${at}: excerpt must be 1-45 words (has ${words})`);
});

for (const p of products) {
  const n = reviews.filter((r) => r.productId === p.id).length;
  console.log(`${p.id}: ${n} reviews`);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log('data OK');
