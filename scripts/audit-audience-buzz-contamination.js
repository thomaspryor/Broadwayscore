#!/usr/bin/env node
/**
 * Audit data/audience-buzz.json for wrong-source LLM-extraction contamination.
 *
 * Background: scripts/scrape-reddit-sentiment.js searches Reddit threads (or
 * Broadway-qualified Google searches for generic titles like "Six" / "It" /
 * "Pride") and feeds them to Claude Sonnet for sentiment scoring. If the
 * search returns threads about a different "Six" (TV show, novel, history
 * documentary), the LLM emits a sentiment distribution for THAT subject,
 * which then gets stored against the Broadway show. The other audience
 * sources (Show Score, Mezzanine, Theatr, Broadway.com) are id-anchored
 * scrapers but their URL fields still carry a useful contamination signal.
 *
 * Companion to scripts/audit-cast-contamination.js. See Notion
 * 36a637c5-416f-81b7-a72b-f7e0dfbb24fc.
 *
 * Usage:
 *   node scripts/audit-audience-buzz-contamination.js          # human report
 *   node scripts/audit-audience-buzz-contamination.js --json
 *   node scripts/audit-audience-buzz-contamination.js --strict # warn = fail
 *
 * Signals:
 *   REDDIT_SCORE_DIVERGENCE     (fail) — reddit.score differs from median of
 *                                          other-source scores by >=40 AND
 *                                          reddit.reviewCount >= 10 AND
 *                                          there are >=2 credible (rc>=10)
 *                                          other-source anchors
 *                                          (signature of wrong-show Reddit threads;
 *                                           the dual-anchor requirement avoids
 *                                           the small-n median artifact)
 *   SHOW_NOT_IN_DB              (warn) — key not present in shows.json,
 *                                          even after market-segment-injection
 *                                          fallback matching (legacy key
 *                                          schemas predate the
 *                                          `-off-broadway-` segment)
 *   BROADWAYCOM_URL_NO_TITLE    (warn) — broadwayCom.url doesn't contain any
 *                                          >=4-char meaningful title token
 *   OTHER_SOURCE_DIVERGENCE     (warn) — any non-Reddit source differs from
 *                                          median of other-source scores by >=35
 *                                          AND reviewCount >= 10
 *                                          (real platform disagreement, not contamination)
 *
 * Thresholds chosen against live data (2026-05-24, 1,830 buzz records):
 *   - Reddit-only divergence with rc>=10 + diff>=40: 1 live hit
 *     (pied-a-terre-off-broadway-2026 — surfaced for manual review).
 *   - broadwayCom URL token check: 1 live hit (mj-2022 with title "MJ: The
 *     Musical"; falls through token filter and warns — exempt-handled below).
 *   - SHOW_NOT_IN_DB: 0 live hits (audience-buzz keys are canonical).
 *
 * Title-token tokeniser is shared with scripts/lib/cast-extraction-guards.js
 * to keep the contamination-defense vocabulary in one place.
 */

const fs = require('fs');
const path = require('path');
const { meaningfulTitleTokens } = require('./lib/cast-extraction-guards');

const ROOT = path.join(__dirname, '..');
const BUZZ_FILE = path.join(ROOT, 'data', 'audience-buzz.json');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');

const SOURCE_NAMES = ['showScore', 'mezzanine', 'reddit', 'theatr', 'broadwayCom'];

const FAIL_SIGNALS = new Set([
  'REDDIT_SCORE_DIVERGENCE',
]);

const WARN_SIGNALS = new Set([
  'SHOW_NOT_IN_DB',
  'BROADWAYCOM_URL_NO_TITLE',
  'OTHER_SOURCE_DIVERGENCE',
]);

function loadShows() {
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
    return data.shows || [];
  } catch {
    return null;
  }
}

// Audience-buzz keys predate the market-segment-in-id convention (older
// rows are `stereophonic-2023`, the canonical id is now
// `stereophonic-off-broadway-2023`). Try direct, market-suffix-injection,
// and prefix-stem match before giving up. Returns the matched id or null.
function resolveBuzzKey(key, ids) {
  if (ids.has(key)) return key;
  // Try injecting a market segment in front of the year
  const m = key.match(/^(.*)-(20\d{2})$/);
  if (m) {
    const [, stem, year] = m;
    for (const seg of ['off-broadway', 'broadway', 'west-end', 'off-west-end']) {
      const guess = `${stem}-${seg}-${year}`;
      if (ids.has(guess)) return guess;
    }
  }
  // Prefix-stem match (key minus trailing -year): pick exact-stem id if unique
  const stem = key.replace(/-20\d{2}$/, '').replace(/-(off-)?(broadway|west-end)-20\d{2}$/, '');
  if (stem !== key) {
    const cands = [...ids].filter(id => id === stem || id.startsWith(stem + '-'));
    if (cands.length === 1) return cands[0];
  }
  return null;
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function audit() {
  const shows = loadShows();
  const ids = shows ? new Set(shows.map(s => s.id)) : null;
  const raw = JSON.parse(fs.readFileSync(BUZZ_FILE, 'utf-8'));
  const showsMap = raw.shows || {};
  const issues = [];

  for (const [id, x] of Object.entries(showsMap)) {
    if (!x || typeof x !== 'object') continue;

    const flags = [];

    let resolvedId = null;
    if (ids) {
      resolvedId = resolveBuzzKey(id, ids);
      if (!resolvedId) flags.push('SHOW_NOT_IN_DB');
    }

    const sources = x.sources || {};
    // Each source needs reviewCount >= 10 to count as a comparison anchor.
    // Otherwise a single n=2 score becomes the "median" and produces false
    // divergence (pied-a-terre-off-broadway-2026 case: 117-vote Reddit
    // compared against a single Mezzanine n=2 critic snapshot).
    const credibleOthers = (excluding) => SOURCE_NAMES
      .filter(n => n !== excluding)
      .map(n => sources[n])
      .filter(s => s && typeof s.score === 'number' && (s.reviewCount || 0) >= 10)
      .map(s => s.score);

    for (const name of SOURCE_NAMES) {
      const src = sources[name];
      if (!src || typeof src.score !== 'number') continue;
      const rc = src.reviewCount || 0;
      if (rc < 10) continue;
      const others = credibleOthers(name);
      // Reddit divergence is the contamination signal we care about — but
      // only meaningful if at least TWO other credible sources agree (so
      // the "median" actually reflects audience consensus). Other-source
      // divergence is platform disagreement, kept as a warning.
      if (name === 'reddit') {
        if (others.length < 2) continue;
        const m = median(others);
        const diff = Math.abs(src.score - m);
        if (diff >= 40) {
          flags.push(`REDDIT_SCORE_DIVERGENCE:score=${src.score},median=${m},diff=${diff},rc=${rc}`);
        }
      } else {
        if (others.length === 0) continue;
        const m = median(others);
        const diff = Math.abs(src.score - m);
        if (diff >= 35) {
          flags.push(`OTHER_SOURCE_DIVERGENCE:src=${name},score=${src.score},median=${m},diff=${diff},rc=${rc}`);
        }
      }
    }

    if (sources.broadwayCom && sources.broadwayCom.url) {
      const titleForTokens = x.title || id.replace(/-(off-)?(broadway|west-end)?-?20\d{2}$/, '').replace(/-/g, ' ');
      const tokens = meaningfulTitleTokens(titleForTokens);
      // Exempt: short titles whose only surviving token is a generic suffix
      // word like "musical" (mj-2022: title "MJ: The Musical").
      const GENERIC = new Set(['musical', 'play', 'show', 'theatre', 'theater']);
      const significant = tokens.filter(t => !GENERIC.has(t));
      if (significant.length > 0) {
        const url = sources.broadwayCom.url.toLowerCase();
        if (!significant.some(t => url.includes(t))) {
          flags.push(`BROADWAYCOM_URL_NO_TITLE:${sources.broadwayCom.url}`);
        }
      }
    }

    if (flags.length > 0) {
      const hasFail = flags.some(f => FAIL_SIGNALS.has(f.split(':')[0]));
      issues.push({
        id,
        resolvedId: resolvedId && resolvedId !== id ? resolvedId : null,
        title: x.title || null,
        severity: hasFail ? 'fail' : 'warn',
        flags,
      });
    }
  }

  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'fail' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function main() {
  const issues = audit();
  const json = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');

  if (json) {
    process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
  } else {
    const fails = issues.filter(i => i.severity === 'fail');
    const warns = issues.filter(i => i.severity === 'warn');
    console.log(`[audit-audience-buzz-contamination] ${fails.length} fail, ${warns.length} warn\n`);
    for (const i of issues) {
      console.log(`  [${i.severity}] ${i.id}${i.title ? ` "${i.title}"` : ''}`);
      for (const f of i.flags) console.log(`     ${f}`);
    }
  }

  const fails = issues.filter(i => i.severity === 'fail').length;
  const warns = issues.filter(i => i.severity === 'warn').length;
  if (fails > 0 || (strict && warns > 0)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { audit, FAIL_SIGNALS };
