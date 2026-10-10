#!/usr/bin/env node
'use strict';
/**
 * Bridge: aggregator unmatched-article audit → OB-discovery candidate staging.
 *
 * Reads the unmatched-article audit files that the PV + BWW landing-page
 * scrapers write (data/audit/{playbill-verdict,bww-roundup}-unmatched.json),
 * fetches each article, and classifies it via the pure lib
 * (scripts/lib/aggregator-candidate-extract.js). Accepted candidates are
 * written into the SAME staging file the venue scrapers use
 * (ob-venue-candidates.json) via writeStagingCandidates() — so
 * promote-ob-venue-candidates.js reads one file and the existing per-venue
 * jaccard dedup + validate-show-venue gate apply unchanged. NO auto-add to
 * shows.json (CLAUDE.md §3).
 *
 * Rejections (infrastructure pages, bot-shells, typos, missing fields) are
 * logged to data/audit/ob-aggregator-rejections.json for human follow-up
 * (e.g. fixing a BWW slug typo at its source).
 *
 * Safety:
 *   - 3-signal bot-shell guard in the lib (a 200 from a Cloudflare/BD shell
 *     must NOT mint a candidate).
 *   - Abort gate: > MAX_ACCEPT accepted in one run aborts without writing
 *     (a regex/format regression would otherwise mass-pollute staging).
 *   - Idempotent: URLs already represented in staging are not re-fetched.
 *
 * Flags:
 *   --dry-run         classify + print; write nothing
 *   --limit=N         cap fetches this run (default 20; CI passes --limit=20)
 *   --source=pv|bww   only process one source
 *   --no-fetch        skip fetching (only processes records with usable slug/
 *                     title; mostly for offline debugging)
 */

const fs = require('fs');
const path = require('path');
const { classifyCandidate, slugCollidesWith, referenceTitle, collisionSlugSet, obRegionalShows, pruneStagedCandidates } = require('./lib/aggregator-candidate-extract');
const { writeStagingCandidates, loadStaging, updateStaging } = require('./lib/venue-listing-discover');

const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audit');
const PV_FILE = path.join(AUDIT_DIR, 'playbill-verdict-unmatched.json');
const BWW_FILE = path.join(AUDIT_DIR, 'bww-roundup-unmatched.json');
const REJECTIONS_FILE = path.join(AUDIT_DIR, 'ob-aggregator-rejections.json');

const MAX_ACCEPT = 50; // stability guard (mirrors update-lottery-rush abort)

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noFetch = args.includes('--no-fetch');
const onlySource = (args.find(a => a.startsWith('--source=')) || '').split('=')[1] || null;
const limit = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '20', 10);

function readJsonArray(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function loadExistingShows() {
  const candidates = [
    path.join(__dirname, '..', 'data', 'shows.json'),
    process.env.HOME ? path.join(process.env.HOME, 'broadway-scorecard-data', 'shows.json') : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return data.shows || data;
    } catch { /* try next */ }
  }
  console.warn('::warning::shows.json not found locally — slug-collision guard disabled this run.');
  return [];
}

async function main() {
  const shows = loadExistingShows();
  // MARKET-SCOPED (off-broadway/regional only), not the full catalog: this
  // pipeline only ever discovers OB/regional candidates, so a same-titled
  // Broadway/West End show must never gate a pre-fetch skip. Still title-only
  // (no venue at this stage — see the pre-fetch gate below) — the residual
  // same-market cross-venue risk is documented there and at
  // findKnownObShow/pruneUnmatchedAudit in the lib (P1 task #1246, 2026-08-11).
  const existingSlugs = collisionSlugSet(obRegionalShows(shows));

  // Prune staged candidates whose show has since landed in shows.json through
  // ANY path — not just this script's own promotion flow. The daily CI
  // promotion (promote-ob-venue-candidates.js --regional-only) explicitly
  // skips every non-regional candidate untouched, so nothing else ever
  // dedupes an OB candidate against shows.json on the scheduled path. Without
  // this sweep, a staged "Dad Don't Read This" or "Rosie O'Donnell: Common
  // Knowledge" — both already-closed shows in shows.json when this was added
  // 2026-08-11 — sits in staging (and the health-check "OB Discovery — Action
  // Needed" digest) forever. See pruneStagedCandidates() for the full story.
  // BRO-158 (the #788 class): this used to be loadStaging() + writeStaging()
  // — a plain read-modify-write racing promote-ob-venue-candidates.js's own
  // rewrite and every other producer of this file. Fixed by routing the
  // write through updateStaging(), which re-reads the file fresh under an
  // exclusive lock and removes ONLY the hashes this run decided to prune —
  // so a candidate another producer staged while this script was running
  // (fetches below can take a while) survives instead of being silently
  // dropped by an overwrite based on the stale `stagingBefore` snapshot.
  const stagingBefore = loadStaging();
  const { kept: stagingKept, pruned: stagingPruned } = pruneStagedCandidates(stagingBefore, shows);
  if (stagingPruned.length > 0) {
    console.log(`Pruning ${stagingPruned.length} staged candidate(s) already in shows.json:`);
    for (const p of stagingPruned) console.log(`  - ${p.title} @ ${p.venue || '?'} (${p.source || '?'})`);
    if (!dryRun) {
      const prunedHashes = new Set(stagingPruned.map((c) => c.candidateHash));
      updateStaging((current) => current.filter((c) => !prunedHashes.has(c.candidateHash)));
    }
  }

  // URLs already staged → don't re-fetch (idempotency without a bespoke cache).
  const stagedUrls = new Set(stagingKept.map(c => c.sourceUrl).filter(Boolean));

  const records = [];
  if (onlySource !== 'bww') {
    for (const r of readJsonArray(PV_FILE)) records.push({ source: 'playbill-verdict', record: r });
  }
  if (onlySource !== 'pv') {
    for (const r of readJsonArray(BWW_FILE)) records.push({ source: 'bww-roundup', record: r });
  }

  if (records.length === 0) {
    console.log('No unmatched audit entries to process.');
    return finish([], [], stagingPruned);
  }
  console.log(`Loaded ${records.length} unmatched audit entries (PV + BWW).`);

  let fetchPage = null;
  if (!noFetch) ({ fetchPage } = require('./lib/scraper'));

  const accepted = [];
  const rejected = [];
  let fetches = 0;

  for (const { source, record } of records) {
    if (onlySource && source !== ({ pv: 'playbill-verdict', bww: 'bww-roundup' }[onlySource])) continue;

    // Skip re-fetching URLs already staged.
    if (record.url && stagedUrls.has(record.url)) {
      console.log(`  [skip] already staged: ${record.url}`);
      continue;
    }

    // Cheap pre-filter: classify without HTML first to catch infrastructure /
    // low-confidence without spending a fetch.
    const pre = classifyCandidate({ source, record, html: null, shows });
    if (pre.status === 'reject' && pre.reason !== 'fetch-failed') {
      rejected.push({ url: record.url, slug: record.slug, source, reason: pre.reason, detail: pre.detail });
      continue;
    }

    // Pre-fetch shows.json check: if the title already maps to an existing
    // show slug, the URL is a leftover for an already-promoted show — skip the
    // fetch entirely. (ship-check P0: stops promoted shows re-fetching weekly.)
    //
    // TITLE-ONLY, deliberately (P1 task #1246, 2026-08-11): the audit record
    // has no venue pre-fetch, so this can't use the fully venue-scoped
    // findKnownObShow() the way classifyCandidate() does below once HTML is
    // in hand. existingSlugs is already MARKET-SCOPED (off-broadway/regional
    // only, built above), closing the cross-market half of the blind spot; a
    // new OB show that merely shares a title with an unrelated, different-
    // venue OB/regional show is the residual risk (documented at
    // findKnownObShow / pruneUnmatchedAudit in the lib). A hit here means the
    // fetch is skipped and the record stays in the audit file for a future
    // run to re-evaluate — it is not deleted — so the fix is bounded to a
    // deferred rather than a lost discovery unless pruneUnmatchedAudit's own
    // (also market-scoped, not venue-scoped) sweep removes it first.
    const refTitle = referenceTitle(source, record);
    if (slugCollidesWith(refTitle, existingSlugs)) {
      rejected.push({ url: record.url, slug: record.slug, source, reason: 'already-in-shows', detail: refTitle });
      continue;
    }

    let html = null;
    if (!noFetch) {
      if (fetches >= limit) {
        console.log(`  [limit] reached --limit=${limit}; deferring ${record.url || record.slug}`);
        rejected.push({ url: record.url, slug: record.slug, source, reason: 'deferred-over-limit' });
        continue;
      }
      try {
        const result = await fetchPage(record.url);
        html = result && result.content ? result.content : null;
      } catch (e) {
        console.warn(`  [fetch-failed] ${record.url}: ${e.message}`);
      }
      fetches++;
    }

    // Wrapped like the fetchPage() call above: uncontrolled third-party HTML/
    // JSON-LD feeds this (BRO-125's countDistinctReviewOutlets in particular
    // walks arbitrary JSON-LD field shapes) — one malformed article must
    // reject as unclassifiable, not crash the whole daily batch run.
    let r;
    try {
      r = classifyCandidate({ source, record, html, shows });
    } catch (e) {
      rejected.push({ url: record.url, slug: record.slug, source, reason: 'classify-error', detail: e.message });
      console.warn(`  [reject:classify-error] ${record.url || record.slug}: ${e.message}`);
      continue;
    }
    if (r.status === 'accept') {
      accepted.push(r.candidate);
      console.log(`  [accept] ${r.candidate.title} @ ${r.candidate.venue} (${source})`);
    } else {
      rejected.push({ url: record.url, slug: record.slug, source, reason: r.reason, detail: r.detail });
      console.log(`  [reject:${r.reason}] ${record.url || record.slug}`);
    }
  }

  return finish(accepted, rejected, stagingPruned);
}

async function finish(accepted, rejected, prunedStaged = []) {
  console.log('');
  console.log(`Summary: ${accepted.length} accepted / ${rejected.length} rejected.`);
  const byReason = {};
  for (const r of rejected) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  if (rejected.length) console.log('  Rejections:', JSON.stringify(byReason));

  if (accepted.length > MAX_ACCEPT) {
    console.error(`::error::Abort: ${accepted.length} accepted candidates exceeds MAX_ACCEPT=${MAX_ACCEPT}. ` +
      'A parser/format regression likely. Nothing written. Investigate before re-running.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('(dry-run: no writes)');
    for (const c of accepted) console.log(`  + ${c.title} @ ${c.venue} → ${c.slug} (${c.source})`);
    return;
  }

  const regional = accepted.filter(c => c.category === 'regional');
  if (regional.length > 0) {
    console.log(`::notice::${regional.length} regional feeder-venue candidate(s) staged — promote-ob-venue-candidates.js --regional-only auto-promotes them (go-live email sent there)`);
  }

  if (accepted.length > 0) {
    writeStagingCandidates(accepted);
    console.log(`Staged ${accepted.length} candidate(s) → data/audit/ob-venue-candidates.json`);
  }

  // Always refresh the rejection log (so stale entries don't linger).
  // prunedStaged carries a durable record of pruneStagedCandidates()'s deletes
  // from data/audit/ob-venue-candidates.json — without it, that write has no
  // audit trail at all (ship-check review 2026-08-11).
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const out = {
    generatedAt: new Date().toISOString(),
    counts: { accepted: accepted.length, rejected: rejected.length, prunedStaged: prunedStaged.length, byReason },
    rejected,
    prunedStaged,
  };
  const tmp = REJECTIONS_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, REJECTIONS_FILE);
  console.log(`Wrote rejection log → data/audit/ob-aggregator-rejections.json`);
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}

module.exports = { main };
