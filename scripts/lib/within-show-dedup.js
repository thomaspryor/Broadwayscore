'use strict';

/**
 * The rebuild's within-show duplicate drop, as a reusable tracker: the same
 * URL twice, the same outlet+critic twice, or an "unknown"/"unnamed" critic
 * stub beside a named critic at the same outlet (rebuild-all-reviews.js
 * skippedUnknownCriticDedup). Shared by the drift probe
 * (review-count-probe.js countLocalIncluded, BRO-6438) and the Critics' Take
 * inputs (critic-consensus-inputs.js, BRO-6226) so both count what the site
 * publishes.
 */

const { canonicalizeUrlForDedup } = require('./review-guards');

function outletKey(r) {
  return String((r && r.outletId) || '').toLowerCase();
}

function personKey(r) {
  return `${outletKey(r)}|${String((r && r.criticName) || 'unknown').toLowerCase().replace(/\s+/g, '')}`;
}

function isUnknownCritic(r) {
  return /^(unknown|unnamed)$/i.test(String((r && r.criticName) || 'unknown').trim());
}

const UNKNOWN_FILE_RE = /--(unknown|unnamed)\b/i;

/** Sort comparator: named-critic files before unknown stubs, then by name (the rebuild's order). */
function namedBeforeUnknown(a, b) {
  return Number(UNKNOWN_FILE_RE.test(a)) - Number(UNKNOWN_FILE_RE.test(b)) || a.localeCompare(b);
}

/** A fresh tracker: isDuplicate(data) asks, add(data) records a kept row. */
function createWithinShowDedup() {
  const haveUrl = new Set();
  const havePerson = new Set();
  const namedOutlets = new Set();
  return {
    haveUrl,
    havePerson,
    isDuplicate(data) {
      const cu = canonicalizeUrlForDedup(data.url);
      if (cu && haveUrl.has(cu)) return true;
      if (havePerson.has(personKey(data))) return true;
      return isUnknownCritic(data) && namedOutlets.has(outletKey(data));
    },
    add(data) {
      const cu = canonicalizeUrlForDedup(data.url);
      if (cu) haveUrl.add(cu);
      havePerson.add(personKey(data));
      if (!isUnknownCritic(data)) namedOutlets.add(outletKey(data));
    },
  };
}

module.exports = { createWithinShowDedup, namedBeforeUnknown, personKey, outletKey, isUnknownCritic };
