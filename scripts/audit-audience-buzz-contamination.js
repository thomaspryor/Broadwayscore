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
 *   OTHER_SOURCE_STALE          (warn) — a modern audience source (theatr,
 *                                          seatplan) has reviewCount > 0 on a
 *                                          show that closed AND opened more
 *                                          than STALE_YEARS_AGO years ago.
 *                                          theatr/seatplan are post-2020
 *                                          platforms; non-zero counts on
 *                                          pre-pandemic-closed shows mean the
 *                                          scraper attached modern listings
 *                                          (touring, Encores!, regional) to
 *                                          the wrong show. Catches the
 *                                          contamination class with rc<10
 *                                          that OTHER_SOURCE_DIVERGENCE
 *                                          misses. See sibling Notion
 *                                          36a637c5-416f-8199-baf6-ef195e30c59b.
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
const { isRedditVolumeInflated, otherSourceReviewCounts, isPreFixReddit, REDDIT_CONTAMINATION_FIX_DATE } = require('./lib/reddit-post-filters');
const { isRedditEligible } = require('./lib/audience-weighting');
const { normalizeTitle } = require('./lib/title-match');

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
  'OTHER_SOURCE_STALE',
  'REDDIT_GENERIC_VOLUME_INFLATION',
  'TITLE_COLLISION_SIBLING_DIVERGENCE',
]);

// TITLE_COLLISION_SIBLING_DIVERGENCE (task #57, 2026-08-03): a show whose title
// also belongs to a DIFFERENT production (revival, transfer, other-market run —
// e.g. Glengarry Glen Ross 2025 Broadway vs West End 2026) is a structural Reddit
// contamination risk, since scrape-reddit-sentiment.js searches by title. Direct
// sibling-vs-sibling comparison catches contamination that REDDIT_SCORE_DIVERGENCE
// misses when neither show has >=2 other credible sources to build its own median
// (small-audience/newly-opened shows). Threshold matches REDDIT_SCORE_DIVERGENCE
// (>=40) and both sides need reviewCount>=10 to rule out small-n noise.

// REDDIT_GENERIC_VOLUME_INFLATION (2026-06-15 music-city; 2026-07-11 title-
// independent rewrite, Notion 39a637c5): REDDIT_SCORE_DIVERGENCE misses
// contamination that inflates Reddit's VOLUME without moving its score far from
// the others. Combined-score weighting is proportional to reviewCount, so a
// bare-phrase search that swept up unrelated chatter gets outsized weight
// (music-city: reddit 148 vs showScore 37 → 72% weight → false "Biggest Mover").
// Detection is isRedditVolumeInflated() (scripts/lib/reddit-post-filters.js),
// shared with the neutralize suppressor. It is title-INDEPENDENT — the old
// isGenericTitle gate here only caught single-word / denylisted titles and
// missed multi-word generic phrases (Fear & Wonder, Misterman, Oscar Wao).

// theatr.com (founded ~2021) and seatplan.com's user-rating product are both
// post-2020 platforms — they cannot have organic users rating shows that
// closed before they existed. Non-zero counts on long-closed shows mean the
// scraper attached a modern same-titled listing (touring, Encores!, regional,
// RSC) to the historical revival. 8-year cutoff keeps post-COVID closures
// (2021-2025) safe (those CAN have legitimate modern app users).
const MODERN_APP_SOURCES = ['theatr', 'seatplan'];
const STALE_YEARS_AGO = 8;

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

// Groups show ids by normalized title, keeping only titles shared by 2+
// distinct productions (the revival/transfer/cross-market collision class).
function buildTitleSiblingGroups(shows) {
  const groups = new Map();
  if (!shows) return groups;
  for (const s of shows) {
    if (!s || !s.title || !s.id) continue;
    const key = normalizeTitle(s.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.id);
  }
  for (const [key, list] of groups) {
    if (list.length < 2) groups.delete(key);
  }
  return groups;
}

function audit({ shows: injectedShows, buzz: injectedBuzz, today } = {}) {
  const shows = injectedShows !== undefined ? injectedShows : loadShows();
  const ids = shows ? new Set(shows.map(s => s.id)) : null;
  const showById = shows ? new Map(shows.map(s => [s.id, s])) : null;
  const raw = injectedBuzz !== undefined
    ? injectedBuzz
    : JSON.parse(fs.readFileSync(BUZZ_FILE, 'utf-8'));
  const showsMap = raw.shows || {};
  const titleSiblingGroups = buildTitleSiblingGroups(shows);
  // Canonical show id -> buzz record, so sibling lookups work regardless of
  // which legacy key schema the sibling's own buzz entry happens to use.
  const buzzByCanonicalId = new Map();
  if (ids) {
    for (const [key, rec] of Object.entries(showsMap)) {
      const resolved = resolveBuzzKey(key, ids);
      if (resolved) buzzByCanonicalId.set(resolved, rec);
    }
  }
  const issues = [];
  const currentYear = (today ? new Date(today) : new Date()).getFullYear();

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
      // Suppressed sources are acknowledged contamination already excluded from
      // weighting (isRedditEligible drops them); they shouldn't keep failing the
      // audit. The REDDIT_GENERIC_VOLUME_INFLATION check below already honors
      // `suppressed` — this keeps the divergence check consistent. Self-clearing:
      // the next clean scrape overwrites the source object and the flag drops.
      if (src.suppressed) continue;
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

    // TITLE_COLLISION_SIBLING_DIVERGENCE — direct sibling-vs-sibling comparison
    // for shows whose title collides with a different production (revival,
    // transfer, other-market run). Catches contamination that REDDIT_SCORE_
    // DIVERGENCE can't see when this show (or its sibling) lacks 2+ other
    // credible sources to build its own median.
    {
      const canonicalId = resolvedId || (ids && ids.has(id) ? id : null);
      const show = canonicalId && showById && showById.get(canonicalId);
      const reddit = sources.reddit;
      if (show && reddit && typeof reddit.score === 'number' && !reddit.suppressed && (reddit.reviewCount || 0) >= 10) {
        const siblingIds = (titleSiblingGroups.get(normalizeTitle(show.title)) || [])
          .filter(sid => sid !== canonicalId);
        for (const siblingId of siblingIds) {
          const siblingRec = buzzByCanonicalId.get(siblingId);
          const siblingReddit = siblingRec && siblingRec.sources && siblingRec.sources.reddit;
          if (!siblingReddit || typeof siblingReddit.score !== 'number' || siblingReddit.suppressed) continue;
          if ((siblingReddit.reviewCount || 0) < 10) continue;
          const diff = Math.abs(reddit.score - siblingReddit.score);
          if (diff >= 40) {
            flags.push(`TITLE_COLLISION_SIBLING_DIVERGENCE:sibling=${siblingId},score=${reddit.score},siblingScore=${siblingReddit.score},diff=${diff}`);
          }
        }
      }
    }

    // REDDIT_GENERIC_VOLUME_INFLATION — generic title + Reddit volume dwarfs
    // (or replaces) every other source. Catches the weight-inflation class that
    // score divergence misses. Restricted to generic/collision-prone titles so
    // legitimately Reddit-heavy distinctive shows don't false-positive.
    {
      const reddit = sources.reddit;
      const rc = reddit && reddit.reviewCount ? reddit.reviewCount : 0;
      const titleForGeneric = x.title
        || (showById && showById.get(resolvedId || id) || {}).title
        || id.replace(/-(off-)?(broadway|west-end)?-?20\d{2}$/, '').replace(/-/g, ' ');
      // Scope to score-eligible shows: Reddit is dropped from combined-score
      // weighting for shows closed >3yr ago (audience-weighting recency gate),
      // so inflation there can't affect a live score. Mirroring that gate keeps
      // the warn list to shows where the contamination actually matters.
      const showForScope = showById && showById.get(resolvedId || id);
      // Use the SAME date-precise cutoff as audience-weighting.js isRedditEligible
      // (closed < now-3yr) so we never flag a show whose Reddit the live score
      // already drops — a year-only comparison diverged at the boundary.
      let scoreEligible = true;
      if (showForScope && showForScope.status === 'closed' && showForScope.closingDate) {
        const cutoff = today ? new Date(today) : new Date();
        cutoff.setFullYear(cutoff.getFullYear() - 3);
        if (new Date(showForScope.closingDate) < cutoff) scoreEligible = false;
      }
      // Already manually suppressed (neutralize-contaminated-reddit-buzz.js) =
      // handled; don't keep warning until the next scrape clears the flag.
      if (scoreEligible && reddit && !reddit.suppressed) {
        // Shared source list + predicate with the neutralize suppressor so the
        // audit never flags a show the suppressor won't touch. The audit's local
        // SOURCE_NAMES (used by the other flag types) omits WE sources; the
        // contamination check MUST use the canonical list.
        const otherCounts = otherSourceReviewCounts(sources);
        const maxOther = otherCounts.length ? Math.max(...otherCounts) : 0;
        if (isRedditVolumeInflated(rc, otherCounts, titleForGeneric)) {
          flags.push(`REDDIT_GENERIC_VOLUME_INFLATION:rc=${rc},maxOther=${maxOther},title="${titleForGeneric}"`);
        }
      }
    }

    // OTHER_SOURCE_STALE — modern audience apps on long-closed shows
    if (showById) {
      const show = showById.get(resolvedId || id);
      if (show && show.status === 'closed' && show.openingDate) {
        const openYear = parseInt(show.openingDate.slice(0, 4), 10);
        if (openYear && (currentYear - openYear) > STALE_YEARS_AGO) {
          for (const name of MODERN_APP_SOURCES) {
            const src = sources[name];
            if (src && typeof src.score === 'number' && (src.reviewCount || 0) > 0) {
              flags.push(`OTHER_SOURCE_STALE:src=${name},score=${src.score},rc=${src.reviewCount},openYear=${openYear}`);
            }
          }
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
  // --gate: per-push trunk catastrophe floor (test.yml). The single FAIL signal
  // (REDDIT_SCORE_DIVERGENCE) is NOT zero-FP — a 40-point gap is as plausibly a
  // genuine audience/critic split as a misroute (it reddened main on glengarry-
  // glen-ross-west-end-2026, run f8abff972), so the gate blocks only on a SPIKE
  // (scraper regression) via the pure scripts/lib/audience-buzz-contamination-
  // gate.js (CLAUDE.md §15). Single divergences + all warns ride the digest. Full
  // --strict runs daily in check-corpus-drift.yml.
  const gate = process.argv.includes('--gate');

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

  // Informational backlog metric (stderr — never pollutes --json stdout, never
  // gates). Counts score-eligible shows whose Reddit predates the contamination
  // fix and so may carry pre-fix collision noise. This is coverage, not a per-show
  // contamination verdict (undetectable from aggregates — see isPreFixReddit doc);
  // it shrinks to 0 as `scrape-reddit-sentiment.js --refresh-stale` drains them.
  try {
    const shows = loadShows() || [];
    const showById = new Map(shows.map(s => [s.id, s]));
    const buzz = JSON.parse(fs.readFileSync(BUZZ_FILE, 'utf-8')).shows || {};
    let backlog = 0;
    for (const [id, rec] of Object.entries(buzz)) {
      const reddit = rec && rec.sources && rec.sources.reddit;
      if (!isPreFixReddit(reddit)) continue;
      const show = showById.get(id);
      if (!show) continue; // orphan buzz id (renamed/removed show) — not a live-score backlog
      const showInfo = { status: show.status, closingDate: show.closingDate };
      if (isRedditEligible(reddit, showInfo)) backlog++;
    }
    if (backlog > 0) {
      console.error(`[audit] ${backlog} score-eligible shows still on pre-fix Reddit (<${REDDIT_CONTAMINATION_FIX_DATE}); drained by scrape-reddit-sentiment.js --refresh-stale`);
    }
  } catch { /* informational only — never block the audit */ }

  if (gate) {
    // Fail LOUD if the source-of-truth is absent: loadShows() swallows a missing
    // data/shows.json to null, suppressing SHOW_NOT_IN_DB and resolved-show scoping.
    // (audience-buzz.json missing already throws ENOENT in audit() → exit 1.)
    if (loadShows() === null) {
      console.error('\n❌ GATE: data/shows.json missing or unparseable — cannot run the audience-buzz contamination gate.');
      process.exit(1);
    }
    const { shouldBlockAudienceBuzzContaminationGate } = require('./lib/audience-buzz-contamination-gate');
    if (shouldBlockAudienceBuzzContaminationGate({ gateHits: fails })) {
      console.error(`\n❌ GATE: ${fails} shows with REDDIT_SCORE_DIVERGENCE — a spike past the floor, the signature of a scraper regression that misrouted many titles.`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ GATE: REDDIT_SCORE_DIVERGENCE count (${fails}) within the spike floor; individual divergences surfaced in digest for triage.`);
    }
    return;
  }

  if (fails > 0 || (strict && warns > 0)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { audit, FAIL_SIGNALS, WARN_SIGNALS, MODERN_APP_SOURCES, STALE_YEARS_AGO };
