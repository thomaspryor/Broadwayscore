#!/usr/bin/env node
/**
 * Turn a routed "missing-show" content-request action into a real shows.json
 * entry — WITHOUT a bespoke scraper and WITHOUT stubbing from memory
 * (CLAUDE.md §3: "Never add stub shows.json entries... regional feeder-venue
 * shows auto-promote off their PV/BWW roundup page").
 *
 * Flow (reuses the SAME pipeline the daily aggregator crawl uses, so the
 * acceptance bar is identical, not a looser ad hoc one):
 *   1. SERP-search for a BroadwayWorld Review Roundup for the title (the
 *      venue hint disambiguates a same-title collision).
 *   2. Fetch it via fetchPage() and classify it with the exact same
 *      classifyCandidate() the nightly crawl uses
 *      (scripts/lib/aggregator-candidate-extract.js) — same title/venue/date
 *      extraction, same rejection reasons.
 *   3. Stage the accepted candidate and promote it with
 *      promote-ob-venue-candidates.js --regional-only. Regional candidates
 *      auto-promote off the roundup page itself (CLAUDE.md §3) — this
 *      script never writes a shows.json entry directly.
 *
 * Any rejection (no roundup found, venue not a known feeder venue, title
 * mismatch, non-html fetch) exits non-zero with the reason. There is no
 * "stub it anyway" fallback.
 *
 * Origin: GH #505 / task #722 — "3 Summers of Lincoln" content request had
 * no Playbill /production/ page but does have a BWW Review Roundup, and its
 * venue (La Jolla Playhouse) is an already-configured regional feeder venue.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');
const { classifyCandidate, classifyTitleDelta } = require('./lib/aggregator-candidate-extract');
const { writeStagingCandidates, candidateHash, loadStaging } = require('./lib/venue-listing-discover');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `add-requested-show.js — Stage + promote a user-requested show via its BWW Review Roundup.

Usage:
  node scripts/add-requested-show.js --title="<title>" [--venue_hint="<venue>"]
  node scripts/add-requested-show.js --help, -h    print this usage and exit

Only promotes regional feeder-venue shows (CLAUDE.md §3 auto-promotion path).
Never stubs shows.json directly and never writes without a real roundup page.
`;

function parseArgs(argv) {
  const out = { title: null, venueHint: null, dryRun: argv.includes('--dry-run') };
  for (const a of argv) {
    if (a.startsWith('--title=')) out.title = a.slice('--title='.length);
    else if (a.startsWith('--venue_hint=') || a.startsWith('--venue-hint=')) out.venueHint = a.slice(a.indexOf('=') + 1);
  }
  return out;
}

const ROUNDUP_URL_RE = /broadwayworld\.com\/article\/Review-Roundup/i;
// A Playbill VERDICT article, not just any Playbill article. The SERP query
// asks for "The Verdict", but a search engine is free to return anything from
// the site — an interview, a casting notice, an obituary — and the URL filter
// is the only thing that stops it being handed to classifyCandidate() as
// `source: 'playbill-verdict'` and parsed with roundup assumptions
// (ship-check finding, 2026-08-05).
//
// The slug vocabulary is deliberately the SAME list scrape-playbill-verdict.js
// already uses to recognise a Verdict article (its verdictUrls filter), so the
// two cannot drift on what counts as one. Playbill keeps inventing phrasings
// ("what-do-critics-think", "what-did-reviews-say-about-X"); keep both lists
// in step when it does.
const PV_URL_RE =
  /playbill\.com\/article\/[^?#]*(?:review|verdict|critics|what-are|what-do|what-did|did-the|how-did)/i;

/**
 * Sources this script will accept as proof a production exists, in order.
 *
 * BWW-only was the original design and it is why GH #542's "The Outsiders at
 * La Jolla" could not be added: no BroadwayWorld Review Roundup exists for that
 * tryout, so the show was unaddable even though it plainly ran (owner:
 * "make sure we search for reviews beyond just aggregators", 2026-08-05).
 *
 * Playbill's Verdict column is a second, independent roundup source that
 * classifyCandidate() already understands (`source: 'playbill-verdict'`), so
 * adding it costs no new parser and keeps the acceptance bar identical — the
 * SAME classifier, the SAME venue allowlist, the SAME title-delta guard. What
 * changes is only how many places we look before giving up.
 *
 * Deliberately NOT added: the venue's own website. A theatre's production page
 * proves the show ran but is marketing copy, not a review roundup — it carries
 * no critic verdicts and no independent confirmation, and classifyCandidate
 * cannot parse it. Promoting off it would be closer to stubbing from memory
 * than to CLAUDE.md §3's "the roundup IS the validation".
 */
const ROUNDUP_SOURCES = [
  {
    source: 'bww-roundup',
    label: 'BroadwayWorld Review Roundup',
    urlRe: ROUNDUP_URL_RE,
    queries: (title, venueHint) => [
      venueHint ? `site:broadwayworld.com/article/Review-Roundup "${title}" "${venueHint}"` : null,
      `site:broadwayworld.com/article/Review-Roundup "${title}"`,
    ].filter(Boolean),
  },
  {
    source: 'playbill-verdict',
    label: 'Playbill Verdict',
    urlRe: PV_URL_RE,
    queries: (title, venueHint) => [
      venueHint ? `site:playbill.com/article "The Verdict" "${title}" "${venueHint}"` : null,
      `site:playbill.com/article "The Verdict" "${title}"`,
    ].filter(Boolean),
  },
];

/**
 * Best-effort roundup URL for a title, or null. Walks ROUNDUP_SOURCES in order,
 * trying a venue-scoped query first (disambiguates same-title collisions) then
 * a bare title query. Never throws — a SERP failure just yields null so the
 * caller reports "no roundup found" instead of crashing.
 *
 * @returns {{url: string, source: string, label: string}|null}
 */
async function findRoundupUrl(title, venueHint, log) {
  for (const src of ROUNDUP_SOURCES) {
    for (const q of src.queries(title, venueHint)) {
      let results = null;
      try {
        results = await serpQuery(q, { nbResults: 5 });
      } catch (err) {
        log(`  SERP query failed (${q}): ${err.message}`);
        continue;
      }
      if (!Array.isArray(results)) continue;
      const hit = results.find((r) => src.urlRe.test(r.url || ''));
      if (hit) return { url: hit.url, source: src.source, label: src.label };
    }
    log(`  No ${src.label} found for "${title}" — trying the next source.`);
  }
  return null;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    process.exit(0);
  }
  const { title, venueHint, dryRun } = parseArgs(process.argv.slice(2));
  if (!title) {
    console.error('--title is required');
    console.error(USAGE);
    process.exit(1);
  }

  console.log(`Looking for a review roundup for "${title}"${venueHint ? ` (venue hint: "${venueHint}")` : ''} across ${ROUNDUP_SOURCES.length} source(s)...`);
  const found = await findRoundupUrl(title, venueHint, console.log);
  if (!found) {
    console.log(
      `No roundup found via SERP on any of: ${ROUNDUP_SOURCES.map((s) => s.label).join(', ')} — not staging. ` +
      '(Never stub shows.json from memory, CLAUDE.md §3.)'
    );
    process.exit(1);
  }
  const { url: roundupUrl, source: roundupSource, label: roundupLabel } = found;
  console.log(`Found candidate roundup (${roundupLabel}): ${roundupUrl}`);

  let fetched;
  try {
    fetched = await fetchPage(roundupUrl);
  } catch (err) {
    console.log(`Fetch failed: ${err.message}`);
    process.exit(1);
  }
  if (!fetched || !fetched.content) {
    console.log('Fetch returned no content.');
    process.exit(1);
  }
  if (fetched.format !== 'html') {
    console.log(`Fetch returned '${fetched.format}', not 'html' — classifier needs real markup to parse title/venue/date.`);
    process.exit(1);
  }

  const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
  const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = showsRaw.shows || showsRaw;

  const slug = roundupUrl.split('/').filter(Boolean).pop() || '';
  const classification = classifyCandidate({
    source: roundupSource,
    record: { url: roundupUrl, slug, firstSeen: new Date().toISOString() },
    html: fetched.content,
    shows,
  });

  if (classification.status === 'reject') {
    console.log(`Rejected: ${classification.reason}${classification.detail ? ` (${classification.detail})` : ''}`);
    process.exit(1);
  }

  const { candidate } = classification;
  console.log(`Accepted candidate: title="${candidate.title}" venue="${candidate.venue}" category="${candidate.category}" date=${candidate.articlePublishedAt}`);

  // The SERP query is a best-effort search, not proof — it can return a
  // same-title-collision or an unrelated roundup that merely mentions the
  // request's keywords. classifyCandidate() only checked the page against
  // ITS OWN slug, never against what the user actually asked for. Verify
  // the extracted title against `title` (the original request) before
  // trusting this page enough to promote off it (ship-check adversarial
  // review, task #722).
  const requestDelta = classifyTitleDelta(title, candidate.title);
  if (requestDelta === 'mismatch') {
    console.log(
      `Rejected: extracted title "${candidate.title}" does not match the requested title "${title}" ` +
      `(delta=${requestDelta}) — likely a same-query SERP collision, not the requested show.`
    );
    process.exit(1);
  }

  if (candidate.category !== 'regional') {
    console.log(
      `Candidate classifies as "${candidate.category}", not "regional" — this script only promotes the ` +
      `regional feeder-venue auto-promotion path (CLAUDE.md §3). Off-Broadway/Broadway candidates need the ` +
      `operator-run promote-ob-venue-candidates.js path with Playbill/Lortel cross-validation, not this one.`
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log('--dry-run: staging + promotion skipped.');
    return;
  }

  writeStagingCandidates([candidate]);
  // Scope the promoter run to exactly this candidate — without --only-hash
  // it would promote EVERY staged regional candidate, including ones staged
  // by the unrelated nightly crawl in the window between this staging write
  // and the promoter running (ship-check adversarial review, task #722).
  const hash = candidateHash({ title: candidate.title, venue: candidate.venue });
  console.log(`Staged (hash=${hash}). Promoting via promote-ob-venue-candidates.js --regional-only --only-hash=${hash}...`);
  execFileSync(
    'node',
    [path.join(__dirname, 'promote-ob-venue-candidates.js'), '--regional-only', `--only-hash=${hash}`],
    {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    }
  );

  // The promoter exits 0 whether it promoted our candidate, promoted nothing,
  // or (bug) silently no-op'd on a hash mismatch — a green run here does NOT
  // mean the show was added (ship-check second-opinion review, task #722).
  // Regional candidates auto-confirm deterministically (CLAUDE.md §3 — "the
  // roundup IS the validation"), so the ONLY legitimate outcome for a
  // regional candidate is promoted-and-removed-from-staging. If our hash is
  // still in the staging file after the promoter ran, nothing was actually
  // added — fail loudly instead of reporting success.
  const stillStaged = loadStaging().some((c) => c.candidateHash === hash);
  if (stillStaged) {
    console.log(
      `Promotion did not remove candidate hash=${hash} from staging — the show was NOT added despite the promoter exiting 0. ` +
      `Check the promoter's log above for the real reason.`
    );
    process.exit(1);
  }
  console.log('Confirmed: candidate left staging (promoted or already-present dedupe).');
}

main().catch((err) => {
  console.error('add-requested-show.js failed:', err.message);
  process.exit(1);
});
