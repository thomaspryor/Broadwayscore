#!/usr/bin/env node
/**
 * Promote venue-discovered OB candidates from staging → shows.json.
 *
 * Pipeline:
 *   1. Load data/audit/ob-venue-candidates.json (written by discover-new-shows.js)
 *   2. For each candidate: cross-validate against Playbill OB + Lortel
 *      (isCandidateConfirmed from scripts/lib/ob-cross-validation.js)
 *   3. Confirmed candidates → build a shows.json entry with safe defaults
 *      (status:'announced', openingDate:null, previewsStartDate:null)
 *   4. De-dupe against existing shows.json by id/slug — skip if already present
 *   5. Atomic-write shows.json (via scripts/lib/atomic-shows-write.js)
 *   6. Append promotion log to data/audit/ob-promotion-log.jsonl
 *
 * Modes:
 *   default                — strict cross-validation; safe for cron
 *   --admin-promote-all    — bypass cross-validation, promote ALL staged
 *                            candidates. ONE-TIME launch use only.
 *   --admin-force=<title>  — promote a specific title without confirmation
 *   --dry-run              — show what would be promoted; don't write
 *
 * Safety:
 *   - Atomic write with 5% shrink gate prevents truncation
 *   - status:'announced' + openingDate:null ensures orchestrator skips
 *     these until they're enriched by a real opening date (V-T9 audit)
 *   - Promotion log is JSONL append-only for audit trail
 */

const fs = require('fs');
const path = require('path');
const { loadStaging, writeStagingCandidates } = require('./lib/venue-listing-discover');
const { isCandidateConfirmed, decideCriticListingPromotion } = require('./lib/ob-cross-validation');
const { AtomicWriteShrinkError } = require('./lib/atomic-shows-write');
const { scrapePlaybillOBData } = require('./lib/playbill-ob-schedule');
const { scrapeLortel } = require('./enrich-off-broadway-dates');
const { feederVenueCity } = require('./lib/aggregator-candidate-extract');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `promote-ob-venue-candidates.js — Promote venue-discovered OB candidates from staging → shows.json.

Usage:
  node scripts/promote-ob-venue-candidates.js [options]
  node scripts/promote-ob-venue-candidates.js --help, -h    print this usage and exit
`;
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const PROMOTION_LOG = path.join(__dirname, '..', 'data', 'audit', 'ob-promotion-log.jsonl');
// Machine-readable output for the CI workflow: which ids were promoted THIS
// run (always rewritten, empty array when none) so the workflow can trigger a
// same-run targeted review scrape without parsing stdout.
const LAST_PROMOTION_FILE = path.join(__dirname, '..', 'data', 'audit', 'last-promotion-ids.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const adminPromoteAll = args.includes('--admin-promote-all');
// --regional-only: the DAILY CI path (scrape-new-aggregators.yml). Considers
// ONLY category:'regional' candidates — no Playbill-OB/Lortel fetches, no OB
// promotions (those keep the operator-run path via health-check). Regional
// candidates validate off the aggregator roundup page itself (user rule
// 2026-07-08: a PV Verdict / BWW Review Roundup page IS the go-live signal).
const regionalOnly = args.includes('--regional-only');
// --email: send the owner a "went live" notification for promoted regional
// shows (best-effort — the promotion does NOT depend on delivery).
const emailAlerts = args.includes('--email');
const adminForceArgs = args
  .filter(a => a.startsWith('--admin-force='))
  .map(a => a.split('=').slice(1).join('=').toLowerCase());
// --only-hash=<candidateHash>: scope this run to ONE staged candidate.
// add-requested-show.js (task #722) stages exactly one candidate per
// dispatch and must promote only that one — without this, a single
// feedback-driven request would sweep and promote every OTHER already-staged
// regional candidate too (ship-check adversarial review caught this: the
// default --regional-only loop below iterates the whole staging file).
const onlyHash = args.find(a => a.startsWith('--only-hash='))?.split('=')[1] || null;

function logEntry(entry) {
  try {
    fs.mkdirSync(path.dirname(PROMOTION_LOG), { recursive: true });
    fs.appendFileSync(PROMOTION_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`Failed to append promotion log: ${e.message}`);
  }
}

function buildShowEntry(candidate) {
  // Build a minimal show entry. openingDate intentionally null so the
  // opening-night orchestrator doesn't fire on a venue-only stub
  // (see V-T9 — orchestrator must skip null-openingDate).
  const year = new Date().getFullYear();
  const slugBase = candidate.slug || candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `${slugBase}-off-broadway-${year}`;
  return {
    id,
    title: candidate.title,
    slug: slugBase,
    venue: candidate.venue,
    openingDate: null,
    previewsStartDate: null,
    closingDate: null,
    status: 'announced',
    category: 'off-broadway',
    market: 'broadway',
    type: null,
    discoverySource: candidate.source,
    discoveredAt: candidate.discoveredAt,
    // Provisional — opening-night orchestrator + Lortel/IBDB enrichment
    // will fill in dates, cast, runtime once they appear in those sources.
    provisional: true,
  };
}

// Sources whose staged candidates were minted from an aggregator ROUNDUP page
// (extract-aggregator-candidates.js). For regional feeder venues that page is
// the validation: it only exists once professional reviews are out.
const AGGREGATOR_ROUNDUP_SOURCES = new Set(['bww-roundup', 'playbill-verdict']);

/** Pure promotion rule for regional candidates (testable, CLAUDE.md §15). */
function decideRegionalPromotion(candidate) {
  if (!candidate || candidate.category !== 'regional') {
    return { confirmed: false, reason: 'not a regional candidate' };
  }
  if (!AGGREGATOR_ROUNDUP_SOURCES.has(candidate.source)) {
    return { confirmed: false, reason: `regional candidate from non-roundup source "${candidate.source}" — needs a PV/BWW roundup page to go live` };
  }
  if (!feederVenueCity(candidate.venue)) {
    // classifyVenueMarket and this check share REGIONAL_FEEDER_VENUES, so this
    // only fires on stale staged entries written before the venue table existed.
    return { confirmed: false, reason: `venue "${candidate.venue}" not in the feeder-venue table` };
  }
  return { confirmed: true, reason: 'aggregator roundup page exists (regional feeder venue)', source: 'aggregator-roundup' };
}

/** Show entry for an auto-promoted REGIONAL production. Differs from the OB
 *  stub: -regional- id/slug (useCurrentMarket detection requires it), market
 *  'regional' (fail-closed: every `.market !== 'broadway'` gate — broadcasts,
 *  recoupment/closure pollers, orchestrator — excludes it), status 'open'
 *  (a roundup only exists after press night), openingDate ≈ the roundup's
 *  publish date (roundups land on/within a day of opening). */
function buildRegionalShowEntry(candidate) {
  // Take the DATE PART of the publish timestamp verbatim — it's already in the
  // publisher's local zone. UTC conversion would roll an ET Dec-31 evening
  // publish into Jan 1 and mint a wrong-year id (QA 2026-07-08).
  const dm = String(candidate.articlePublishedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const year = dm ? Number(dm[1]) : new Date().getFullYear();
  const openingDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
  const slugBase = candidate.slug || candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `${slugBase}-regional-${year}`;
  const city = feederVenueCity(candidate.venue);
  // Regional runs are limited engagements (6-10 weeks). A fresh roundup ⇒ the
  // show just opened ⇒ 'open'. A roundup older than ~90 days reaching this
  // code is a backfill/seed — the run is almost certainly over, and 'open'
  // would show a closed production as running (Millions @ Alliance test seed,
  // 2026-07-09). closingDate stays null either way (unknown).
  const ageDays = openingDate ? (Date.now() - new Date(openingDate).getTime()) / 86400000 : 0;
  return {
    id,
    title: candidate.title,
    slug: id, // regional slugs must contain '-regional' (useCurrentMarket)
    venue: city ? `${candidate.venue}, ${city}` : candidate.venue,
    openingDate,
    openingDateSource: 'aggregator-roundup',
    previewsStartDate: null,
    closingDate: null,
    status: ageDays > 90 ? 'closed' : 'open',
    category: 'regional',
    market: 'regional',
    tags: ['regional'],
    type: /\bmusical\b/i.test(candidate.title || '') ? 'musical' : null,
    discoverySource: `aggregator-roundup:${candidate.source}`,
    discoveredAt: candidate.discoveredAt,
    // Provisional — reviews auto-ingest via the PV/BWW matchers now that the
    // show exists; images/cast/exact dates arrive via the enrichment email.
    provisional: true,
  };
}

function writeLastPromotionFile(promoted) {
  const out = {
    generatedAt: new Date().toISOString(),
    promoted: promoted.map(p => ({ id: p.entry.id, source: p.candidate.source, sourceUrl: p.candidate.sourceUrl || null })),
  };
  const tmp = LAST_PROMOTION_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, LAST_PROMOTION_FILE);
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const staged = loadStaging();
  // Reset the promotion record up front so a crash mid-run can never leave a
  // STALE file claiming yesterday's promotions happened again (the workflow
  // reads it to decide targeted scrapes and commits it).
  if (!dryRun) writeLastPromotionFile([]);
  if (staged.length === 0) {
    console.log('No staged candidates to promote.');
    return;
  }
  console.log(`Loaded ${staged.length} staged candidates from staging file.`);

  // Load existing shows.json for dedupe + atomic write base
  let showsData;
  try {
    showsData = loadShows();
  } catch (e) {
    console.error(`Failed to load ${SHOWS_FILE}: ${e.message}`);
    process.exit(1);
  }
  const existingIds = new Set(showsData.shows.map(s => s.id));
  // Build a per-venue index of existing OB shows so cross-source dedup can
  // do TOKEN-SET (jaccard) comparison instead of exact normalized-string.
  // Exact-string match misses word-order variants:
  //   "Heated Rivalry: The Unauthorized Musical Parody" (TodayTix)
  //   "HEATED RIVALRY: THE UNAUTHORIZED PARODY MUSICAL" (Playbill)
  // → same tokens, different word order, different normalized strings.
  // The bug: this exact pair shipped a duplicate to production on 2026-05-27.
  // Fix: jaccard >= DEDUP_JACCARD_THRESHOLD on titleTokens collapses them.
  const { normalizeTitle, canonicalVenue, titleTokens, jaccard } = require('./lib/title-match');
  // Subtitle-stripped compare, same venue: title-match's normalizeTitle keeps
  // colon/dash subtitles as tokens, so jaccard undercounts a base-title-only
  // listing against a subtitled one ("Ectoplasm" vs "Ectoplasm: Spit and
  // Vigor" → 0.33; "Bone Wars" vs "Bone Wars: A New Musical" → 0.67 — both
  // below the 0.80 gate). deduplication.js's normalizeTitle strips everything
  // after a colon/dash/paren, which is exactly the collapse this needs.
  // These two pairs shipped as duplicates to shows.json and blocked a
  // Vercel deploy until merged by hand (task #1011, 2026-08-04) — this check
  // is the fix for the class, not just those two shows.
  const { normalizeTitle: subtitleStrippedTitle } = require('./lib/deduplication');
  // 0.80 (not 0.85) because normalizeTitle's trailing-"musical" strip can
  // unbalance token sets — "Heated Rivalry: The Unauthorized Musical Parody"
  // keeps "musical" + "parody" but "...PARODY MUSICAL" loses trailing
  // "musical" → jaccard 0.8, not 1.0. 0.8 still requires 80% token overlap.
  const DEDUP_JACCARD_THRESHOLD = 0.80;
  const existingByVenue = new Map(); // canonicalVenue → [{ id, title, tokens, normalized, subtitleStripped }]
  // Include 'regional' alongside 'off-broadway': regional candidates are added
  // to shows.json manually (runbook), and without them in this index a staged
  // regional entry never matches → never drops → re-hits validation weekly
  // forever (Black Swan sat staged 3 weeks after shipping, 2026-07-08).
  for (const s of showsData.shows.filter(s => s.category === 'off-broadway' || s.category === 'regional')) {
    const venueKey = canonicalVenue(s.venue);
    if (!existingByVenue.has(venueKey)) existingByVenue.set(venueKey, []);
    existingByVenue.get(venueKey).push({
      id: s.id, title: s.title,
      tokens: titleTokens(s.title),
      normalized: normalizeTitle(s.title),
      subtitleStripped: subtitleStrippedTitle(s.title),
    });
  }

  /** Return the existing show that matches `c` by canonical venue +
   *  (normalized title OR subtitle-stripped title OR jaccard ≥ threshold). Else null. */
  function findExistingMatch(c) {
    const venueKey = canonicalVenue(c.venue);
    const cands = existingByVenue.get(venueKey) || [];
    if (cands.length === 0) return null;
    const cNorm = normalizeTitle(c.title);
    const cTokens = titleTokens(c.title);
    const cSubtitleStripped = subtitleStrippedTitle(c.title);
    // Same carve-out deduplication.js's checkForDuplicate applies right after this
    // exact normalized-equality check: if BOTH titles carry a subtitle marker but
    // their full titles differ, don't collapse — that's the Angels in
    // America: Millennium Approaches / Perestroika shape (distinct works sharing a
    // base title), not a listing-source variant of the same show. Porting the
    // strip without this guard would silently and permanently drop a real second
    // production at the same venue (no retry path — matched candidates never
    // re-enter staging).
    const hasSubtitleMarker = (t) => /[:\-–—[]/.test(t);
    for (const e of cands) {
      if (e.normalized === cNorm) return { match: e, reason: 'normalized-equal' };
      if (cSubtitleStripped.length >= 3 && cSubtitleStripped === e.subtitleStripped) {
        const bothHaveSubtitles = hasSubtitleMarker(c.title) && hasSubtitleMarker(e.title);
        const fullTitlesDiffer = c.title.toLowerCase().trim() !== e.title.toLowerCase().trim();
        if (!(bothHaveSubtitles && fullTitlesDiffer)) {
          return { match: e, reason: `subtitle-stripped-equal: "${cSubtitleStripped}"` };
        }
      }
      if (cTokens.size > 0 && e.tokens.size > 0) {
        const sim = jaccard(cTokens, e.tokens);
        if (sim >= DEDUP_JACCARD_THRESHOLD) return { match: e, reason: `jaccard=${sim.toFixed(2)}` };
      }
    }
    return null;
  }

  // Fetch cross-validation sources unless --admin-promote-all or
  // --regional-only (regional candidates never use Playbill-OB/Lortel; the
  // daily CI path must not spend those fetches).
  let playbillEntries = [];
  let lortelEntries = [];
  if (!adminPromoteAll && !regionalOnly) {
    console.log('Fetching Playbill OB for cross-validation...');
    const pb = await scrapePlaybillOBData();
    playbillEntries = pb.entries;
    console.log(`  Playbill OB: ${playbillEntries.length} entries.`);
    console.log('Fetching Lortel currently-playing for cross-validation...');
    try {
      lortelEntries = await scrapeLortel();
      console.log(`  Lortel: ${lortelEntries.length} entries.`);
    } catch (e) {
      console.warn(`  Lortel scrape failed (${e.message}); proceeding with Playbill only.`);
    }
  }

  const promoted = [];
  const skipped = [];
  const remainingStaged = [];
  for (const c of staged) {
    const titleLower = (c.title || '').toLowerCase();

    // --only-hash: everything except the targeted candidate is untouched
    // (stays staged for its normal path — nightly cron or a later dispatch).
    if (onlyHash && c.candidateHash !== onlyHash) {
      remainingStaged.push(c);
      continue;
    }

    // --regional-only: non-regional candidates are untouched (stay staged for
    // the operator-run OB promotion path). Keeps the daily CI blast radius to
    // exactly the regional feeder-venue class.
    if (regionalOnly && c.category !== 'regional') {
      remainingStaged.push(c);
      continue;
    }

    // Dedupe via per-venue jaccard match. Catches: cross-year duplicates,
    // venue-string variants ("Atlantic Theater Company - Linda Gross" vs
    // "Atlantic Theater"), cross-source same-venue (TNG → Signature Center),
    // AND word-order variants ("Musical Parody" vs "Parody Musical").
    const existingMatch = findExistingMatch(c);
    if (existingMatch) {
      skipped.push({ candidate: c, reason: `already in shows.json as ${existingMatch.match.id} (${existingMatch.reason})` });
      logEntry({ kind: 'skip-duplicate', title: c.title, venue: c.venue, matchedTo: existingMatch.match.id, matchReason: existingMatch.reason });
      continue;
    }

    let confirmed = false;
    let reason = '';
    let source = null;
    if (c.category === 'regional') {
      // Regional feeder-venue candidates auto-promote off the roundup page
      // itself (user rule 2026-07-08) — Playbill-OB/Lortel can never confirm
      // a DC/Chicago production, and admin flags are ignored for this class
      // (the OB buildShowEntry would mint a mislabeled entry).
      const r = decideRegionalPromotion(c);
      confirmed = r.confirmed; reason = r.reason; source = r.source || null;
    } else if (adminPromoteAll) {
      confirmed = true; reason = '--admin-promote-all'; source = 'admin';
    } else if (adminForceArgs.includes(titleLower)) {
      confirmed = true; reason = `--admin-force="${c.title}"`; source = 'admin-force';
    } else if (c.source === 'nyt-theater') {
      // Critic-listing candidates (newyorktheater.me — Sprint 1, task #997)
      // can never be corroborated by isCandidateConfirmed's Playbill/Lortel
      // check (Lortel is dead; Playbill's OB schedule carries none of these
      // shows — task #987). decideCriticListingPromotion is self-sufficient
      // instead; see scripts/lib/ob-cross-validation.js header (task #995).
      const r = decideCriticListingPromotion(c);
      confirmed = r.confirmed; reason = r.reason; source = r.source;
    } else {
      const r = isCandidateConfirmed(c, { playbillEntries, lortelEntries });
      confirmed = r.confirmed; reason = r.reason; source = r.source;
    }

    if (!confirmed) {
      skipped.push({ candidate: c, reason });
      remainingStaged.push(c); // keep in staging for next run
      logEntry({ kind: 'skip-unconfirmed', title: c.title, venue: c.venue, reason });
      continue;
    }

    // Build show entry + dedupe by ID
    const entry = c.category === 'regional' ? buildRegionalShowEntry(c) : buildShowEntry(c);
    if (existingIds.has(entry.id)) {
      skipped.push({ candidate: c, reason: `id ${entry.id} already exists` });
      logEntry({ kind: 'skip-id-collision', title: c.title, venue: c.venue, id: entry.id });
      continue;
    }
    promoted.push({ candidate: c, entry, confirmationSource: source, confirmationReason: reason });
    existingIds.add(entry.id);
    // Feed the promotion back into the jaccard dedup index under BOTH venue
    // spellings (candidate's bare venue and the entry's city-suffixed venue) so
    // a second candidate for the same show in the SAME run — PV + BWW both
    // roundup one opening, with slight title variants → different slugified
    // ids — hits findExistingMatch instead of minting a duplicate show.
    for (const vk of new Set([canonicalVenue(c.venue), canonicalVenue(entry.venue)])) {
      if (!existingByVenue.has(vk)) existingByVenue.set(vk, []);
      existingByVenue.get(vk).push({ id: entry.id, title: entry.title, tokens: titleTokens(entry.title), normalized: normalizeTitle(entry.title), subtitleStripped: subtitleStrippedTitle(entry.title) });
    }
    logEntry({ kind: 'promote', title: c.title, venue: c.venue, id: entry.id, confirmationSource: source });
  }

  console.log('');
  console.log(`Promotion summary: ${promoted.length} promote / ${skipped.length} skip (of ${staged.length} staged).`);
  // Tag each line with the candidate's discovery source (venue-page:* vs
  // playbill-verdict / bww-roundup) so the operator knows whether a row came
  // from a direct venue scrape or an aggregator-article extraction (the latter
  // warrants extra scrutiny — venue was parsed from prose). See plan-review.
  if (promoted.length > 0) {
    console.log('Promoting:');
    for (const p of promoted) console.log(`  + [${p.candidate.source || 'unknown'}] ${p.entry.id} (via ${p.confirmationSource}: ${p.confirmationReason})`);
  }
  if (skipped.length > 0) {
    console.log('Skipping:');
    for (const s of skipped.slice(0, 20)) console.log(`  - [${s.candidate.source || 'unknown'}] ${s.candidate.title} (${s.candidate.venue}): ${s.reason}`);
    if (skipped.length > 20) console.log(`  ... +${skipped.length - 20} more`);
  }

  if (dryRun) {
    console.log('');
    console.log('(dry-run: no writes)');
    return;
  }

  // Staging rewrite must NOT be gated on promotions: dedup-matched entries
  // (candidate's show since added to shows.json by hand — the regional flow)
  // leave staging via remainingStaged, and that cleanup has to land even on a
  // zero-promotion run or stale entries linger forever (QA 2026-07-08).
  const rewriteStaging = () => {
    const stagingPath = path.join(__dirname, '..', 'data', 'audit', 'ob-venue-candidates.json');
    fs.writeFileSync(stagingPath + '.tmp.' + process.pid, JSON.stringify(remainingStaged, null, 2));
    fs.renameSync(stagingPath + '.tmp.' + process.pid, stagingPath);
    console.log(`Staging file: ${remainingStaged.length} unpromoted candidates remain.`);
  };

  if (promoted.length === 0) {
    console.log('Nothing to promote; shows.json unchanged.');
    if (remainingStaged.length !== staged.length) rewriteStaging();
    return;
  }

  // Append to shows.json and atomic-write
  for (const p of promoted) showsData.shows.push(p.entry);
  try {
    const r = saveShows(showsData);
    console.log(`Wrote shows.json: ${r.lineCountBefore} → ${r.lineCountAfter} lines.`);
  } catch (e) {
    if (e instanceof AtomicWriteShrinkError) {
      console.error(`::error::${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  // Record promotions ONLY after the shows.json write landed — written before,
  // a shrink-gate abort would leave a file claiming promotions that never
  // happened, and the workflow would targeted-scrape ghosts (QA 2026-07-08).
  writeLastPromotionFile(promoted);

  // Rewrite staging file with only the unpromoted candidates.
  rewriteStaging();

  // "Went live" notification for regional promotions. The show is already
  // written — notification failure only logs (the site does not depend on it,
  // and the promotion-log JSONL is the durable record).
  //
  // Routed to the morning digest, NOT a standalone email (owner decision
  // 2026-07-26). This used to call sendEmailAlert({severity:'info'}), which the
  // actionable-only policy in discord-notify.js silently suppresses — so the
  // owner was never told a regional show went live and polled the URL by hand.
  // A regional go-live is real news but never same-hour urgent, so it belongs
  // in the digest rather than carving an exception into the email policy.
  //
  // conditionKey is PER SHOW: routeAlert dedups on conditionKey with a 7-day
  // default cooldown, so a shared key would swallow the second go-live in any
  // week that promotes two shows.
  const regionalPromoted = promoted.filter(p => p.entry.category === 'regional');
  if (emailAlerts && regionalPromoted.length > 0) {
    const { routeAlert } = require('./lib/owner-alert-router');
    for (const p of regionalPromoted) {
      try {
        await routeAlert({
          conditionKey: `regional-go-live:${p.entry.id}`,
          title: `${p.entry.title} @ ${p.entry.venue} — regional tryout live and scoring`,
          severity: 'info',
          disposition: 'digest',
          url: `https://broadwayscorecard.com/show/${p.entry.id}`,
          description:
            `Auto-promoted from an aggregator roundup (${p.candidate.sourceUrl || 'source n/a'}). ` +
            'Reviews ingest automatically via the daily aggregator scrape. Cosmetic enrichment still manual: ' +
            'images (poster/hero), cast + creative team, exact previews/opening/closing dates, audience scrapers ' +
            '(scrape-reddit-sentiment.js / scrape-mezzanine-audience.js). See memory/feedback_regional_show_add_runbook.md steps 5-6.',
        });
        console.log(`Queued regional go-live digest line for ${p.entry.id}.`);
      } catch (e) {
        console.warn(`::warning::regional go-live digest queue failed for ${p.entry.id}: ${e.message} (promotion unaffected)`);
      }
    }
  }
}

if (require.main === module) {
  main().catch(async err => {
    console.error('Fatal error:', err);
    // Self-monitoring: a silently-failing daily promotion means shows never go
    // live and nobody notices (the CI step is continue-on-error). Email the
    // failure when --email is on; best-effort.
    if (emailAlerts) {
      try {
        const { sendEmailAlert } = require('./lib/discord-notify');
        await sendEmailAlert({
          title: 'Regional auto-promotion FAILED',
          severity: 'error',
          description: `promote-ob-venue-candidates.js crashed: ${err.message}. Staged candidates are untouched and will retry next run, but investigate — repeated failures strand regional shows.`,
        });
      } catch { /* best-effort */ }
    }
    process.exit(1);
  });
}

module.exports = { buildShowEntry, buildRegionalShowEntry, decideRegionalPromotion };
