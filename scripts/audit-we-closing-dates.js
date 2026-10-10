#!/usr/bin/env node
/**
 * audit-we-closing-dates.js
 *
 * Daily bidirectional audit of closingDate values for open West End shows —
 * the West End analogue of audit-closing-dates.js (BRO-1158). Broadway's
 * script leans on broadway.com's per-show performance-calendar page; West
 * End has no equivalent central schedule endpoint, so this audit resolves
 * each show's booking page via westendtheatre.com SERP discovery (cached in
 * data/westend-slug-map.json) or the show's own officialUrl, then extracts
 * a single keyword-anchored "Booking until DD Month YYYY" style date rather
 * than a full calendar (scripts/lib/we-closing-date-extract.js).
 *
 * Logic (mirrors audit-closing-dates.js):
 *   - extracted > stored → EXTENSION, auto-applied (bounded by
 *     MAX_AUTO_EXTENSION_DAYS — a bigger jump is more likely a parser
 *     false-positive than a real extension).
 *   - extracted < stored by > AMBIGUOUS_DELTA_THRESHOLD_DAYS → AMBIGUOUS,
 *     flagged for human review only (never auto-retracted).
 *   - stored is null → NEW_CLOSING, flagged for review only.
 *   - otherwise → MATCH, no action.
 *   - page fetched but doesn't confirm the show (title_mismatch), or
 *     confirms it but has no anchored date (no_date_found) → routed through
 *     scripts/lib/closing-audit-classify.js's classifyMissingSchedule
 *     (shared with audit-closing-dates.js): if the show is stored open for a
 *     clear stretch, this is a POSSIBLY_CLOSED review flag, not a silent
 *     error — a page that stops confirming a show is at least as strong a
 *     "probably closed" signal as an empty one (see that lib's docstring for
 *     the Celebrity Autobiography incident this pattern exists to prevent).
 *
 * Output: data/audit/we-closing-date-discrepancies.json
 *
 * Usage:
 *   node scripts/audit-we-closing-dates.js [--dry-run] [--shows=id1,id2] [--time-budget-min=N]
 *
 * Env:
 *   BRIGHTDATA_TOKEN, BRIGHTDATA_ZONE, SCRAPINGBEE_API_KEY, SCRAPINGDOG_API_KEY
 *   LINEAR_API_KEY (required only if ambiguous findings need filing)
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const { extractWestEndClosingDateDetailed } = require('./lib/we-closing-date-extract');
const { classifyWeClosingDelta } = require('./lib/we-closing-date-classify');
const { classifyMissingSchedule } = require('./lib/closing-audit-classify');
const { discoverWestEndTheatreUrl } = require('./lib/westend-slug-discovery');
const { writeClosingDate, canWriteClosingDate } = require('./lib/closing-date-guard');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-we-closing-dates.js — Daily bidirectional audit of closingDate values for open West End shows.

Usage:
  node scripts/audit-we-closing-dates.js [options]
  node scripts/audit-we-closing-dates.js --help, -h    print this usage and exit
`;

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit', 'we-closing-date-discrepancies.json');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'we-closing-date-audit-config.json');
const SLUG_MAP_FILE = path.join(__dirname, '..', 'data', 'westend-slug-map.json');
const TODAY = new Date().toISOString().slice(0, 10);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SHOWS_FILTER = (argv.find(a => a.startsWith('--shows=')) || '').replace('--shows=', '').split(',').filter(Boolean);
const timeBudget = createRunBudget(parseTimeBudgetMin(argv));

const AMBIGUOUS_DELTA_THRESHOLD_DAYS = 30;
const MAX_AUTO_EXTENSION_DAYS = 180;
// Mirrors audit-closing-dates.js's POSSIBLY_CLOSED_MIN_DAYS: a page that no
// longer confirms the show (or confirms it with no bookable date) is only a
// meaningful "possibly closed" signal if the show claims to still be running
// for a clear stretch. Below this, an empty page during a show's final days
// is normal (last performances sell out / drop off the booking site).
const POSSIBLY_CLOSED_MIN_DAYS = 5;
const TITLE_MISMATCH_FLOOD_CAP = 5;

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const URL_OVERRIDES = CONFIG.urlOverrides || {};
const OPEN_RUN_SKIP = new Set(CONFIG.openRunSkip.ids);
const AMBIGUOUS_ALLOWLIST = (CONFIG.ambiguousAllowlist && CONFIG.ambiguousAllowlist.entries) || {};

function normalizeDate(d) {
  if (!d || typeof d !== 'string') return null;
  return d.slice(0, 10);
}

function isAllowlisted(showId, storedClosingDate) {
  const entry = AMBIGUOUS_ALLOWLIST[showId];
  if (!entry || !storedClosingDate) return false;
  return normalizeDate(entry.verifiedStored) === normalizeDate(storedClosingDate);
}

// Resolution order per show: explicit override > officialUrl > WET (cached
// or freshly SERP-discovered). officialUrl comes second, not first, despite
// the issue's suggestion that a direct site "usually has the cleanest
// copy" — officialUrl coverage on WE shows is ~1/38 today (grep, 2026-09-15),
// so WET is the workhorse source and officialUrl is only consulted when set.
async function resolveBookingUrl(show, log) {
  if (URL_OVERRIDES[show.id]) return { url: URL_OVERRIDES[show.id], source: 'override' };
  const wetUrl = await discoverWestEndTheatreUrl(show, SLUG_MAP_FILE, { log });
  if (wetUrl) return { url: wetUrl, source: 'westendtheatre.com' };
  if (show.officialUrl) return { url: show.officialUrl, source: 'officialUrl' };
  return null;
}

async function auditOneShow(show) {
  const resolved = await resolveBookingUrl(show, console.log);
  if (!resolved) {
    return { id: show.id, name: show.name, stored: show.closingDate || null, action: 'ERROR', reason: 'no_booking_url_discovered' };
  }

  let page;
  try {
    page = await fetchPage(resolved.url, { source: 'audit-we-closing-dates' });
  } catch (e) {
    return { id: show.id, name: show.name, stored: show.closingDate || null, url: resolved.url, action: 'ERROR', reason: `fetch_error: ${e.message.slice(0, 120)}` };
  }
  const content = page && page.content ? page.content : '';
  const extraction = extractWestEndClosingDateDetailed(content, show.name || show.title || '');
  const stored = show.closingDate || null;

  if (!extraction.date) {
    // 'title_mismatch' (page fetched but doesn't confirm the show) maps
    // straight onto classifyMissingSchedule's own kind vocabulary;
    // 'no_date_found' (page confirms the show but has no anchored date) is
    // the WE analogue of Broadway's 'empty_schedule' — the classifier
    // string-matches on that exact literal, so it's reused verbatim rather
    // than inventing a new kind name.
    const kind = extraction.kind === 'title_mismatch' ? 'title_mismatch' : 'empty_schedule';
    const verdict = classifyMissingSchedule({
      closingDate: stored,
      todayStr: TODAY,
      minDays: POSSIBLY_CLOSED_MIN_DAYS,
      allowlisted: isAllowlisted(show.id, stored),
      kind,
    });
    if (verdict.action === 'POSSIBLY_CLOSED_NEEDS_REVIEW') {
      return {
        id: show.id, name: show.name, stored, url: resolved.url, urlSource: resolved.source,
        delta: verdict.daysUntilStored == null ? null : -verdict.daysUntilStored,
        action: 'POSSIBLY_CLOSED_NEEDS_REVIEW',
        missingKind: kind,
      };
    }
    const reason = kind === 'title_mismatch' ? 'wet_title_mismatch' : 'no_date_found_on_page';
    return { id: show.id, name: show.name, stored, url: resolved.url, urlSource: resolved.source, action: 'ERROR', reason };
  }

  const verdict = { id: show.id, name: show.name, stored, extracted: extraction.date, quote: extraction.quote, url: resolved.url, urlSource: resolved.source };

  if (stored && isAllowlisted(show.id, stored)) {
    const delta = Math.round((new Date(extraction.date) - new Date(stored)) / 86400000);
    if (delta < 0 && Math.abs(delta) > AMBIGUOUS_DELTA_THRESHOLD_DAYS) {
      return { ...verdict, delta, action: 'MATCH', allowlistedFalsePositive: true };
    }
  }

  const { action, delta } = classifyWeClosingDelta({
    stored,
    extracted: extraction.date,
    ambiguousDeltaThresholdDays: AMBIGUOUS_DELTA_THRESHOLD_DAYS,
    maxAutoExtensionDays: MAX_AUTO_EXTENSION_DAYS,
  });

  return { ...verdict, delta, action };
}

async function notifyLinear(ambiguous, todayStr) {
  if (ambiguous.length === 0) return;
  if (!process.env.LINEAR_API_KEY) {
    throw new Error('notifyLinear: LINEAR_API_KEY not set — cannot file the audit finding, refusing to silently drop it');
  }
  const { spawnSync } = require('child_process');
  const brain = path.join(__dirname, 'linear-brain.js');

  const dedup = spawnSync('node', [brain, 'find', 'WE closing date audit'], { encoding: 'utf8', timeout: 60_000 });
  if (dedup.status !== 0) {
    throw new Error(`notifyLinear: dedup search failed (exit ${dedup.status}): ${(dedup.stderr || dedup.stdout || '').slice(0, 500)}`);
  }
  if (dedup.stdout && dedup.stdout.trim() !== 'null') {
    console.log('Linear: existing open WE closing-audit issue found — skipping create (dedup)');
    return;
  }

  const title = `WE closing date audit: ${ambiguous.length} show${ambiguous.length > 1 ? 's' : ''} need review (${todayStr})`;
  const rows = ambiguous.map(a => {
    if (a.action === 'POSSIBLY_CLOSED_NEEDS_REVIEW') {
      const evidence = a.missingKind === 'title_mismatch'
        ? 'booking page no longer mentions this show (removed/moved, or a slug collision)'
        : 'booking page confirms the show but states no booking-until date';
      const storedDesc = a.stored ? `stored=${a.stored} (${Math.abs(a.delta)}d out)` : 'no stored closingDate';
      return `- **${a.id}** (POSSIBLY-CLOSED): ${storedDesc} but ${evidence} — possibly closed. ${a.url}`;
    }
    const action = a.action === 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW' ? 'EXTENSION-CAP'
      : a.action === 'NEW_CLOSING_NEEDS_REVIEW' ? 'NEW-CLOSING' : 'EARLIER';
    return `- **${a.id}** (${action}): stored=${a.stored || 'null'}, ${a.urlSource} extracted ${a.extracted} (${a.delta == null ? 'n/a' : a.delta + 'd'}). "${(a.quote || '').slice(0, 160)}" — ${a.url}`;
  }).join('\n');

  const notes = [
    '## Problem',
    `WE closing-date audit found ${ambiguous.length} show(s) where the extracted booking-page date disagrees with stored closingDate, or no closingDate is stored at all.`,
    '',
    '## Shows flagged',
    rows,
    '',
    '## Resolution steps',
    '1. Click the URL and confirm the actual booking-until / closing date.',
    '2. If confirmed → update `data/shows.json` closingDate (private repo `thomaspryor/broadway-scorecard-data`, symlinked at `data/shows.json`).',
    '3. Commit + push private repo; Vercel cron picks up within ~5 min.',
    '4. If stored date is correct, add to `data/we-closing-date-audit-config.json` `ambiguousAllowlist` to suppress repeat alerts. Mark Done.',
    '',
    '## Acceptance criteria',
    "- Each show's stored closingDate matches the actual announced final performance, OR is confirmed correct with an allowlist entry added.",
    '',
    `_Auto-created by scripts/audit-we-closing-dates.js on ${todayStr}._`,
  ].join('\n');

  const create = spawnSync('node', [
    brain, 'create', title,
    '--priority', '2',
    '--notes', notes,
    '--park', 'Daily WE closing-date audit finding — needs human verification before any shows.json edit',
  ], { encoding: 'utf8', timeout: 60_000 });

  if (create.status !== 0) {
    throw new Error(`notifyLinear: create failed (exit ${create.status}): ${(create.stderr || create.stdout || '').slice(0, 500)}`);
  }
  const match = (create.stderr || '').match(/__BOARD_CARD_ID__=([A-Z]+-\d+)/);
  console.log(`Linear: created issue ${match ? match[1] : '(unknown id)'}`);
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('='.repeat(60));
  console.log('WE CLOSING DATE AUDIT (bidirectional)');
  console.log('='.repeat(60));
  console.log(`Date: ${TODAY}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const data = loadShows();
  const candidates = data.shows.filter(s => {
    if (s.status !== 'open' || s.category !== 'west-end') return false;
    if (OPEN_RUN_SKIP.has(s.id)) return false;
    if (SHOWS_FILTER.length && !SHOWS_FILTER.includes(s.id)) return false;
    return true;
  });

  console.log(`Auditing ${candidates.length} open West End shows...`);
  console.log('');

  const extensions = [];
  const newClosings = [];
  const ambiguous = [];
  const errors = [];
  const matches = [];
  let budgetExit = false;
  let budgetExitIndex = candidates.length;

  for (let ci = 0; ci < candidates.length; ci++) {
    if (timeBudget.exceeded()) {
      budgetExit = true;
      budgetExitIndex = ci;
      console.log(`\n⏱ Time budget (${timeBudget.minutes} min) reached — ${candidates.length - ci} shows deferred to next run.`);
      break;
    }

    const show = candidates[ci];
    let result;
    try {
      result = await auditOneShow(show);
    } catch (e) {
      result = { id: show.id, name: show.name, action: 'ERROR', reason: `unhandled: ${e.message.slice(0, 120)}` };
    }

    switch (result.action) {
      case 'ERROR':
        errors.push(result);
        break;
      case 'NEW_CLOSING_NEEDS_REVIEW':
        newClosings.push(result);
        break;
      case 'EXTENSION':
        if (!canWriteClosingDate(show)) {
          extensions.push({ ...result, action: 'EXTENSION_HUMAN_PROTECTED', skipped: true });
        } else {
          extensions.push(result);
          if (!DRY_RUN) {
            writeClosingDate(show, result.extracted, `${result.urlSource} (WE audit ${TODAY})`, { todayStr: TODAY });
          }
        }
        break;
      case 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW':
      case 'NEEDS_HUMAN_REVIEW':
        ambiguous.push(result);
        break;
      case 'POSSIBLY_CLOSED_NEEDS_REVIEW': {
        // Flood guard (mirrors audit-closing-dates.js's
        // TITLE_MISMATCH_FLOOD_CAP): a wave of title_mismatch flags in one
        // run is far more likely a pageMatchesShowTitle() regression or a
        // WET template change than that many shows all closing on the same
        // day. Route overflow to errors instead of spamming Linear with a
        // parser-breakage storm.
        const titleMismatchFlags = ambiguous.filter(x => x.missingKind === 'title_mismatch').length;
        if (result.missingKind === 'title_mismatch' && titleMismatchFlags >= TITLE_MISMATCH_FLOOD_CAP) {
          errors.push({ ...result, action: 'ERROR', reason: 'possibly_closed_flood_suspected_parser_breakage' });
        } else {
          ambiguous.push(result);
        }
        break;
      }
      case 'MATCH':
      default:
        matches.push(result);
        break;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'live',
    summary: {
      audited: budgetExitIndex,
      extensions: extensions.length,
      newClosings: newClosings.length,
      ambiguous: ambiguous.length,
      matches: matches.length,
      errors: errors.length,
      budgetExit,
      deferred: budgetExit ? candidates.length - budgetExitIndex : 0,
    },
    extensions,
    newClosings,
    ambiguous,
    matches,
    errors,
  };

  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote ${AUDIT_FILE}`);

  console.log('\nResults:');
  console.log(`  ✅ Matches:                    ${matches.length}`);
  console.log(`  📈 Extensions auto-applied:    ${extensions.length}`);
  console.log(`  🆕 New-closing candidates:     ${newClosings.length}`);
  console.log(`  ⚠️  Ambiguous (need review):    ${ambiguous.length}`);
  console.log(`  ❌ Errors:                     ${errors.length}`);

  for (const e of extensions) console.log(`  EXT  ${e.id}: ${e.stored} → ${e.extracted} (+${e.delta}d) [${e.urlSource}]`);
  for (const n of newClosings) console.log(`  NEW  ${n.id}: null → ${n.extracted} [${n.urlSource}]`);
  for (const a of ambiguous) {
    if (a.action === 'POSSIBLY_CLOSED_NEEDS_REVIEW') {
      console.log(`  AMB  ${a.id}: stored ${a.stored || 'null'}, possibly closed (${a.missingKind}) — ${a.url}`);
    } else {
      console.log(`  AMB  ${a.id}: stored ${a.stored}, ${a.urlSource} says ${a.extracted} (${a.delta}d)`);
    }
  }
  for (const e of errors) console.log(`  ERR  ${e.id}: ${e.reason}`);

  const changed = extensions.filter(e => !e.skipped).length;
  if (changed > 0 && !DRY_RUN) {
    saveShows(data);
    console.log(`\n✅ Wrote ${changed} closingDate updates to shows.json`);
  }

  if (ambiguous.length > 0) {
    await notifyLinear(ambiguous, TODAY);
  }

  await cleanup();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await cleanup();
  process.exit(1);
});
