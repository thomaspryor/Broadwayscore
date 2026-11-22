'use strict';
// BRO-7901: ONE definition of "the collector will never fetch this outlet's URLs": outlet-registry.json accessModel
// 'print-only' or 'defunct'. collect-review-texts.js skips these (skippedUncollectableOutlet) and
// uncollected-strand.js must agree, or a stub the collector refuses by design reads as "stranded" every hour
// (starburst-magazine, defunct, kept the health row "uncollected live review strands" open).
const fs = require('fs');
const path = require('path');

const UNCOLLECTABLE_ACCESS_MODELS = new Set(['print-only', 'defunct']);
let cached = null;

/** Set of outlet ids from outlet-registry.json whose accessModel is print-only or defunct. */
function loadUncollectableOutlets(registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json')) {
  const set = new Set();
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  for (const [id, info] of Object.entries(registry.outlets || {})) {
    if (info && UNCOLLECTABLE_ACCESS_MODELS.has(info.accessModel)) set.add(id);
  }
  return set;
}

/** True when this review file's outlet is one the collector never fetches. Fails open (false) if the registry cannot be read. */
function isUncollectableOutlet(review, outlets) {
  let set = outlets;
  if (!set) {
    if (!cached) { try { cached = loadUncollectableOutlets(); } catch { cached = new Set(); } }
    set = cached;
  }
  return !!review && set.has(String(review.outletId || '').toLowerCase());
}

module.exports = { loadUncollectableOutlets, isUncollectableOutlet, UNCOLLECTABLE_ACCESS_MODELS };
