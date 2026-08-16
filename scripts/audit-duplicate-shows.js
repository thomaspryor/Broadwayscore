#!/usr/bin/env node
/**
 * audit-duplicate-shows.js — whole-corpus duplicate-SHOW detector.
 *
 * The discovery-time guard (scripts/lib/deduplication.js) only fires when a show
 * is ADDED. Duplicates still slip in when the two records arrive via different
 * paths or when canonicalVenue() doesn't alias two names for the same physical
 * venue (e.g. "Shakespeare's Globe" vs "Globe Theatre" — the Much Ado 2026 dup,
 * where the two records also had opening dates 2 days apart so the temporal
 * guard treated them as separate productions). Nothing re-scans the FULL catalog
 * for dups that already landed, so a duplicate splits a production's reviews and
 * score across two pages indefinitely.
 *
 * This audit groups open/previews shows by normalized title + year and flags a
 * pair as a DUPLICATE when:
 *   (a) the two venues share a distinctive token (after dropping generic words),
 *       e.g. "Shakespeare's Globe" & "Globe Theatre" → "globe"; OR
 *   (b) one record is an incomplete stub (venue TBA/empty, no reviews) — the
 *       Heated Rivalry word-order-swap case.
 * It does NOT flag genuine multi-productions: same title + same year but two
 * real, distinct venues with no shared token (e.g. A Midsummer Night's Dream
 * 2026 at Shakespeare's Globe vs Regent's Park Open Air Theatre).
 *
 * Usage:
 *   node scripts/audit-duplicate-shows.js [--json=PATH]       report only
 *   node scripts/audit-duplicate-shows.js --strict            exit 1 on new (non-baselined) pair
 *   node scripts/audit-duplicate-shows.js --update-baseline   regenerate baseline from current scan
 *
 * Baseline-diff (task #1675), same posture as audit-broadway-category-predicate.js
 * (#1665) / audit-outlet-registry.js (#1666) / audit-critic-outlets.js (#1668):
 * pre-existing clusters are frozen in data/audit/duplicate-shows-baseline.json and
 * never fail CI — a bare "flag any cluster" gate false-positives on genuinely
 * distinct same-title productions at different venues (the incomplete-stub branch
 * in particular, e.g. two markets' own Christmas Carol productions). Only a NEW
 * (showId, showId) pair not in the baseline fails under --strict. Identity is the
 * unordered show-id pair, not the cluster key or reason — see
 * scripts/lib/duplicate-shows-baseline.js for why. Default mode (no flags) always
 * exits 0 — report only, matching the sibling gates' advisory-first convention.
 *
 * Reuses normalizeTitle from scripts/lib/deduplication.js so the title grouping
 * matches the discovery guard (subtitle/genre-suffix/possessive stripping).
 */
const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('./lib/deduplication');
const { findTitleFragmentDupes } = require('./lib/show-duplicate-detection');
const { baselineKeySet, computeNewViolators } = require('./lib/duplicate-shows-baseline');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const BASELINE_PATH = path.join(ROOT, 'data', 'audit', 'duplicate-shows-baseline.json');

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const UPDATE_BASELINE = args.includes('--update-baseline');
const jsonArg = args.find((a) => a.startsWith('--json='));
const JSON_OUT = jsonArg ? jsonArg.split('=')[1] : path.join(ROOT, 'data', 'audit', 'duplicate-shows.json');

// Generic venue words that don't distinguish a physical venue.
const VENUE_GENERIC = new Set([
  'the', 'theatre', 'theater', 'playhouse', 'royal', 'new', 'old', 'studio',
  'stage', 'hall', 'house', 'arts', 'centre', 'center', 'london', 'west', 'end',
  'off', 'company', 'at', 'and', 'on', 'formerly', 'open', 'air', 'tba',
]);

function venueTokens(venue) {
  return new Set(
    String(venue || '')
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ') // drop parentheticals like "(formerly ...)"
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !VENUE_GENERIC.has(w)),
  );
}

function isStub(show, reviewCount) {
  const v = String(show.venue || '').trim().toLowerCase();
  return reviewCount === 0 && (!v || v === 'tba' || !show.openingDate);
}

// Title word-SET similarity (Jaccard). Distinguishes a word-order swap (same set,
// e.g. "Musical Parody" vs "Parody Musical" → 1.0, a real dup) from a genuinely
// different bill in a repertory engagement (e.g. Alvin Ailey "New Works" vs
// "Legacy" → low overlap, NOT a dup). Used to gate the incomplete-stub branch so
// distinct programs at one venue aren't flagged.
function titleWordSetJaccard(t1, t2) {
  const set = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3));
  const a = set(t1); const b = set(t2);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function showYear(s) {
  const d = s.openingDate || s.previewsStartDate || '';
  return /^\d{4}/.test(d) ? d.slice(0, 4) : null;
}

function reviewFileCount(id) {
  const dir = path.join(REVIEW_TEXTS_DIR, id);
  if (!fs.existsSync(dir)) return 0;
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; }
  catch { return 0; }
}

// Independent corpus-health probe for assertCorpusScanned (task #1063 class):
// the detection logic above only calls reviewFileCount() for shows that already
// landed in a same-title+year group, so on a run with zero such groups it would
// never touch data/review-texts at all — a healthy-but-quiet corpus and a
// missing/empty checkout would look identical to the per-pair count. Sums the
// actual .json review-file count across every show-id directory (same signal
// as reviewFileCount(), just totalled over the whole corpus instead of two
// specific ids) so a near-empty checkout containing only stray files/dirs
// (.git, .DS_Store, one leftover empty show dir) doesn't read as healthy —
// a bare top-level-directory count would have (ship-check adversarial review,
// task #1675).
function corpusHealthCount() {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true }); }
  catch { return 0; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try { total += fs.readdirSync(path.join(REVIEW_TEXTS_DIR, e.name)).filter((f) => f.endsWith('.json')).length; }
    catch { /* unreadable dir — skip */ }
  }
  return total;
}

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { pairs: [] };
  }
}

function main() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = (raw.shows || raw).filter((s) => s && s.id && s.status !== 'closed');

  // Group by normalized title + year.
  const groups = new Map();
  for (const s of shows) {
    const yr = showYear(s);
    if (!yr) continue;
    const key = `${normalizeTitle(s.title || '')}|${yr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const clusters = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    // Pairwise classify within the same-title+year group.
    const dupPairs = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        const ra = reviewFileCount(a.id);
        const rb = reviewFileCount(b.id);
        const ta = venueTokens(a.venue);
        const tb = venueTokens(b.venue);
        const shared = [...ta].filter((t) => tb.has(t));
        // A real duplicate needs the SAME full-title word set (so a repertory
        // engagement's distinct bills — Alvin Ailey "New Works" vs "Legacy", same
        // venue + same normalized title — are NOT flagged) AND either a shared
        // distinctive venue token or an incomplete stub.
        let reason = null;
        if (titleWordSetJaccard(a.title, b.title) >= 0.8) {
          if (isStub(a, ra) || isStub(b, rb)) reason = 'incomplete-stub';
          else if (shared.length > 0) reason = `shared-venue-token:${shared.join(',')}`;
        }
        // else: two real distinct venues → multi-production, not a dup.
        if (reason) {
          dupPairs.push({
            a: { id: a.id, venue: a.venue, opening: a.openingDate, reviews: ra },
            b: { id: b.id, venue: b.venue, opening: b.openingDate, reviews: rb },
            reason,
          });
        }
      }
    }
    if (dupPairs.length) clusters.push({ key, pairs: dupPairs });
  }

  // Title-fragment pass: the title+year grouping above can only compare shows
  // that already share a normalized title, so a fragment dupe (one title is a
  // subset of another's at the same venue/run — e.g. "Godot's To-Do List" inside
  // a double-bill entry) never lands in the same group. This pass catches those.
  // See scripts/lib/show-duplicate-detection.js for the false-positive guards.
  for (const f of findTitleFragmentDupes(shows)) {
    const a = shows.find((s) => s.id === f.a);
    const b = shows.find((s) => s.id === f.b);
    clusters.push({
      key: `title-fragment@${f.venue}`,
      pairs: [{
        a: { id: f.a, venue: a?.venue, opening: a?.openingDate, reviews: reviewFileCount(f.a) },
        b: { id: f.b, venue: b?.venue, opening: b?.openingDate, reviews: reviewFileCount(f.b) },
        reason: 'title-fragment',
      }],
    });
  }

  // FAIL LOUD on an empty corpus (task #1675, same pattern as
  // audit-outlet-registry.js task #1666) BEFORE writing anything — a missing/
  // empty data/review-texts checkout would otherwise let --update-baseline
  // freeze a baseline computed with every isStub() check reading reviews=0,
  // and would let --strict report a vacuous "0 new" pass.
  if (STRICT || UPDATE_BASELINE) {
    try {
      assertCorpusScanned(corpusHealthCount(), { gate: STRICT || UPDATE_BASELINE });
    } catch (e) {
      if (!(e instanceof CorpusNotScannedError)) throw e;
      console.error(`\n❌ ${e.message}`);
      return 1;
    }
  }

  if (UPDATE_BASELINE) {
    const pairs = clusters.flatMap((c) => c.pairs.map((p) => ({ a: p.a.id, b: p.b.id, reason: p.reason })));
    const baseline = { generatedAt: new Date().toISOString().slice(0, 10), pairs };
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`✅ Baseline updated: ${pairs.length} known duplicate-show pair(s) across ${clusters.length} cluster(s) (${BASELINE_PATH})`);
    return 0;
  }

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedFor: 'duplicate-shows', clusters }, null, 2) + '\n');

  const baselineSet = baselineKeySet(loadBaseline().pairs);
  const newClusters = computeNewViolators(clusters, baselineSet);
  const totalPairs = clusters.reduce((sum, c) => sum + c.pairs.length, 0);
  const newPairs = newClusters.reduce((sum, c) => sum + c.pairs.length, 0);

  if (clusters.length === 0) {
    console.log('✓ No duplicate shows found.');
  } else {
    console.log(`Found ${clusters.length} duplicate-show cluster(s), ${totalPairs} pair(s) (baselined: ${totalPairs - newPairs}, new: ${newPairs}):\n`);
    for (const c of clusters) {
      for (const p of c.pairs) {
        console.log(`  [${p.reason}] ${c.key}`);
        console.log(`    ${p.a.id}  (${p.a.venue}, ${p.a.reviews} review files)`);
        console.log(`    ${p.b.id}  (${p.b.venue}, ${p.b.reviews} review files)`);
      }
    }
    console.log(`\nDetail written to ${path.relative(ROOT, JSON_OUT)}`);
    if (newClusters.length > 0) {
      console.log(`\n⚠️  NEW duplicate pair(s) not in the baseline (${BASELINE_PATH}):`);
      for (const c of newClusters) {
        for (const p of c.pairs) console.log(`  [${p.reason}] ${c.key}: ${p.a.id} <-> ${p.b.id}`);
      }
      console.log(`\nIf this is deliberate progress (an intentional carve-out for a genuinely distinct`);
      console.log(`production), refresh the baseline: node scripts/audit-duplicate-shows.js --update-baseline`);
    }
  }

  if (STRICT && newClusters.length > 0) return 1;
  return 0;
}

process.exit(main());
