/**
 * Last-line uniqueness guard for rebuild-all-reviews.js output (BRO-4809).
 *
 * The outlet-level dedup passes run BEFORE the manual-entry merge, and that
 * merge appends unchecked, so a row can still reach reviews.json twice (main
 * went red 2026-10-06: slam-frank-off-broadway-2026 / off-off-online / Marc
 * Miller, two byte-identical rows). This collapses rows that share the exact
 * ReviewsList key (scripts/lib/review-list-key.js) within a show — the same
 * invariant tests/unit/show-proof-rage-clicks.test.mjs enforces on the data —
 * keeping a manual / human-scored copy over a pipeline copy, else the first.
 *
 * Mutates nothing: returns { reviews, removed }.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { getReviewKey } = require('./review-list-key');
const { sameUrlDuplicateKey } = require('./review-url-collision');

const SAME_URL_BASELINE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'same-url-duplicate-baseline.json');

function preferenceRank(r) {
  return (r.manualEntry === true ? 2 : 0) + (r.humanReviewScore != null ? 1 : 0);
}

function dedupeByReviewKey(reviews) {
  const kept = new Map();
  for (const r of reviews) {
    const key = `${r.showId}|${getReviewKey(r)}`;
    const prev = kept.get(key);
    if (!prev) kept.set(key, r);
    else if (preferenceRank(r) > preferenceRank(prev)) kept.set(key, r);
  }
  // Map keeps first-insertion order, so output order is stable.
  const out = [...kept.values()];
  return { reviews: out, removed: reviews.length - out.length };
}

/**
 * The validator's same-URL baseline (known pre-existing pairs it does not fail
 * on). Read by BOTH validate-data.js and the rebuild's final same-URL pass, so
 * the gate and the producer agree on which pairs are tolerated.
 * Missing file => empty set. Unreadable file => throws (caller decides).
 */
function loadSameUrlBaseline(p = SAME_URL_BASELINE_PATH, { mustExist = false } = {}) {
  if (!fs.existsSync(p)) {
    // The rebuild deletes rows on this set's say-so: a missing file must not
    // widen that to every pair the baseline normally exempts.
    if (mustExist) throw new Error(`same-URL baseline missing: ${p}`);
    return new Set();
  }
  return new Set(JSON.parse(fs.readFileSync(p, 'utf8')).pairs || []);
}

/** A human-scored or hand-entered row. Rebuilt rows carry scoreSource, not humanReviewScore. */
function humanRank(r) {
  return preferenceRank(r) + (r.scoreSource === 'human-review' && r.humanReviewScore == null ? 1 : 0);
}

/**
 * Case-preserving identity: host lowercased, fragment and trailing slash cut,
 * path and query exactly as written. sameUrlDuplicateKey lowercases the whole
 * URL, which is fine for flagging but not for deleting: /Review-A and /review-a
 * can be two articles. Rows that differ only in path case are left for the gate.
 */
function exactUrlSig(url) {
  const s = String(url).trim().replace(/#.*$/, '').replace(/\/$/, '');
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i, (m) => m.toLowerCase());
}

const TIER_RANK = { complete: 4, truncated: 3, excerpt: 2, stub: 1, invalid: 0 };
function hasNamedCritic(r) {
  const c = String(r.criticName || '').trim().toLowerCase();
  return !!c && c !== 'unknown';
}
/** Higher sorts first; ties keep input order (the rebuild's own priority sort). */
function sameUrlRank(r) {
  return [
    humanRank(r),
    TIER_RANK[r.contentTier] != null ? TIER_RANK[r.contentTier] : -1,
    hasNamedCritic(r) ? 1 : 0,
  ];
}
function rankGreater(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * BRO-8228: the producer-side twin of validate-data.js's same-URL gate.
 *
 * validate-data.js fails main when two reviews.json rows of one show share a
 * URL (key: sameUrlDuplicateKey, NOT outlet-scoped) and the pair is not in the
 * baseline. The rebuild's in-loop URL dedup is looser: it deliberately lets a
 * same-URL pair through when the two files carry different named critics
 * ("multi-critic pages"), and rows added after that loop (manual-entry merge,
 * carried rows) never pass through it at all. That disagreement turned the
 * Data Validation step red three times in two weeks (oliver-west-end-2024,
 * body-language-regional-2026, death-of-a-salesman-2022), each a one-off card.
 *
 * This collapses every non-baselined same-URL group to one row, using the
 * gate's own key and baseline, so the rebuild can never emit what the gate
 * rejects (path-case-only differences excepted, see exactUrlSig). Keep order: manual/human row, then richer contentTier, then a
 * named critic, then the first in input order.
 *
 * Mutates nothing: returns { reviews, dropped: [{ dropped, kept, key }] }.
 */
function dedupeBySameUrl(reviews, baseline = new Set()) {
  const kept = new Map();
  const dropped = [];
  const order = [];
  for (const r of reviews) {
    const gateKey = r && sameUrlDuplicateKey(r.showId, r.url);
    if (gateKey === null || gateKey === undefined || baseline.has(gateKey)) {
      order.push({ row: r });
      continue;
    }
    const key = `${gateKey}\u0000${exactUrlSig(r.url)}`;
    const prev = kept.get(key);
    if (!prev) {
      kept.set(key, r);
      order.push({ key });
    } else if (rankGreater(sameUrlRank(r), sameUrlRank(prev))) {
      kept.set(key, r);
      dropped.push({ dropped: prev, kept: r, key: gateKey });
    } else {
      dropped.push({ dropped: r, kept: prev, key: gateKey });
    }
  }
  const out = order.map((o) => (o.key ? kept.get(o.key) : o.row));
  return { reviews: out, dropped };
}

module.exports = { dedupeByReviewKey, dedupeBySameUrl, loadSameUrlBaseline, SAME_URL_BASELINE_PATH };
