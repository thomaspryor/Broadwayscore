#!/usr/bin/env node
/**
 * audit-closing-dates.js
 *
 * Daily bidirectional audit of closingDate values for open shows.
 *
 * Replaces the brittle Broadway.org "Through:" scraper. Compares stored
 * closingDate against authoritative on-sale calendar pages:
 *   - Broadway: https://www.broadway.com/shows/{slug}/schedule/
 *   - West End: TODO (separate workflow — westendtheatre.com has no central calendar)
 *
 * Logic:
 *   - latestScheduled = max scheduled performance date on the show's
 *     official schedule page. This is a LOWER BOUND on the announced
 *     closing date (the show plays at least through that day).
 *   - If latestScheduled > stored closingDate → EXTENSION confirmed,
 *     auto-update (high confidence — calendars don't list performances
 *     for closed shows).
 *   - If latestScheduled < stored closingDate → AMBIGUOUS. Calendar
 *     window often only goes ~5 months out, so a far-future close is
 *     normal. Flag for human review only if delta > 30 days AND stored
 *     date is within the calendar window (i.e. shorter run, not longer).
 *   - If stored is null → NEW CLOSING detected, auto-update.
 *
 * Output:
 *   - data/audit/closing-date-discrepancies.json (full report)
 *   - shows.json (only EXTENSION + NEW updates applied)
 *   - Discord alert if any AMBIGUOUS flagged
 *
 * Why this exists:
 *   The previous check-closing-dates.js scraped broadway.org's /shows/ page
 *   which often lists "Through: <date>" that's months behind the announced
 *   close. update-show-status.js uses TodayTix endDate which is the on-sale
 *   window, not the final performance. Both are monotonic-extension-only.
 *   See memory/feedback_closing_date_audit_gaps.md.
 *
 * Usage:
 *   node scripts/audit-closing-dates.js [--dry-run] [--shows=id1,id2]
 *
 * Env:
 *   BRIGHTDATA_TOKEN, BRIGHTDATA_ZONE, SCRAPINGBEE_API_KEY
 *   DISCORD_WEBHOOK_ALERTS (optional)
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const { discoverAnnouncedClosingDate } = require('./lib/closing-date-discovery');
const { writeClosingDate, canWriteClosingDate } = require('./lib/closing-date-guard');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit', 'closing-date-discrepancies.json');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'closing-date-audit-config.json');
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_YEAR = new Date().getFullYear();

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SHOWS_FILTER = (argv.find(a => a.startsWith('--shows=')) || '').replace('--shows=', '').split(',').filter(Boolean);
const AMBIGUOUS_DELTA_THRESHOLD_DAYS = 30;
// "Possibly closed early" signal: broadway.com page matched the show by title
// but lists ZERO future performances, while the stored closingDate claims the
// show still runs for at least this many more days. A genuinely-running show
// would have those near-term performances on its calendar — their total absence
// means it almost certainly closed earlier than stored. This is the Burnout
// Paradise class (stored 2026-06-28, actually closed 2026-05-23): an OB show
// that was never audited AND whose empty calendar was silently dropped to
// `errors`. Flag for human review instead. Threshold of 5 days avoids
// false-positives on shows in their final days (calendars can legitimately go
// empty when the last performances sell out / drop off the on-sale window).
const POSSIBLY_CLOSED_MIN_DAYS = 5;
// Cap auto-applied extensions per run. Broadway.com calendar windows
// expand in ~3-month chunks, so any single observed jump > 180d is more
// likely a parseScheduleDates() false-positive (e.g. promo banner showing
// the 2027 Tony Awards date) than a real extension. Fall through to
// ambiguous review instead of writing a fabricated date.
const MAX_AUTO_EXTENSION_DAYS = 180;
// Triple-signal auto-fix: when broadway.com schedule + press article + LLM
// extraction agree within ±7 days, auto-apply the new closingDate. Bounds
// hallucination risk: a single wrong article can't move the date unless the
// schedule and a second source corroborate. See clusterDates() in
// scripts/lib/closing-date-discovery.js.
const TRIPLE_SIGNAL_TOLERANCE_DAYS = 7;
// Cap auto-fix attempts per run. With ~$0.10 of SERP+SB+LLM per show, this
// caps a runaway audit (e.g., 50 ambiguous after a broadway.com layout
// change) at ~$1. Excess flows through to the Notion card path normally.
const MAX_TRIPLE_SIGNAL_ATTEMPTS = 10;

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const SLUG_OVERRIDES = CONFIG.slugOverrides;
const OPEN_RUN_SKIP = new Set(CONFIG.openRunSkip.ids);
// Self-cleaning allowlist for known calendar-window-short false positives.
// Entry honored only while stored closingDate still matches verifiedStored —
// any drift (extension or retraction) bypasses the allowlist and the show
// re-enters the normal ambiguous-flagging path.
const AMBIGUOUS_ALLOWLIST = (CONFIG.ambiguousAllowlist && CONFIG.ambiguousAllowlist.entries) || {};

// Normalize a date value to YYYY-MM-DD before equality. shows.json today
// stores plain YYYY-MM-DD, but if a future writer emits ISO-with-time
// (2027-02-14T00:00:00Z), the raw string comparison would fail and break the
// allowlist — silently turning verified false-positives back into daily
// Notion noise. Slicing to first 10 chars is field-format-agnostic.
function normalizeDate(d) {
  if (!d || typeof d !== 'string') return null;
  return d.slice(0, 10);
}

function isAllowlisted(showId, storedClosingDate) {
  const entry = AMBIGUOUS_ALLOWLIST[showId];
  if (!entry || !storedClosingDate) return false;
  return normalizeDate(entry.verifiedStored) === normalizeDate(storedClosingDate);
}

function slugFor(s) {
  if (SLUG_OVERRIDES[s.id]) return SLUG_OVERRIDES[s.id];
  return (s.slug || s.id.replace(/-\d{4}$/, '')).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Years we'll accept in the schedule. Window relative to TODAY_YEAR so this
// doesn't silently break in 2030.
function buildYearPattern() {
  const years = [TODAY_YEAR, TODAY_YEAR + 1, TODAY_YEAR + 2, TODAY_YEAR + 3];
  return `(${years.join('|')})`;
}

function parseScheduleDates(html) {
  const text = html
    .replace(/<script[^]*?<\/script>/g, ' ')
    .replace(/<style[^]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const re = new RegExp(`\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s*${buildYearPattern()}`, 'g');
  const dates = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const d = new Date(m[0].replace(/Sept/, 'Sep'));
    if (!isNaN(d.getTime())) dates.add(d.toISOString().slice(0, 10));
  }
  return [...dates].sort();
}

// Title-confirmation guard against broadway.com slug collisions across
// revivals. `cabaret-2014` (id) → `cabaret` (slug) → could resolve to a
// later revival's schedule. Require the page to mention a recognisable
// keyword from the stored title before we trust its dates.
function pageMatchesShow(html, showName) {
  if (!html || !showName) return false;
  // Strip HTML, lowercase, normalize whitespace
  const haystack = html
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  // Use the longest word from the title as the keyword (skips articles).
  // For multi-word titles, also try the first 2 words concatenated.
  const words = showName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  if (words.length === 0) return true; // single-syllable title: skip guard
  // Require at least one of the meaningful words
  return words.some(w => haystack.includes(w));
}

async function fetchLatestSchedule(show, slug) {
  const url = `https://www.broadway.com/shows/${slug}/schedule/`;
  const r = await fetchPage(url, { source: 'audit-closing-dates' });
  const content = r.content || '';
  if (!pageMatchesShow(content, show.name || show.title || '')) {
    return { url, latest: null, count: 0, source: r.source, error: 'title_mismatch' };
  }
  const dates = parseScheduleDates(content).filter(d => d >= TODAY);
  return { url, latest: dates.length ? dates[dates.length - 1] : null, count: dates.length, source: r.source };
}

async function notifyDiscord(message) {
  const webhook = process.env.DISCORD_WEBHOOK_ALERTS;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message.slice(0, 1900) }),
    });
  } catch (e) {
    console.warn('Discord notify failed:', e.message);
  }
}

// Route ambiguous flags into Notion (the user's source of truth per CLAUDE.md §6).
// Discord alerts were silently ignored — Beaches stored=2026-09-06 was flagged
// every day for >1 week before the actual close (2026-05-24) was caught manually.
// One rollup card per audit run, deduped against existing open audit cards so
// daily re-flagging of the same shows doesn't spam Notion.
async function notifyNotion(ambiguous, todayStr) {
  if (ambiguous.length === 0) return;
  if (!process.env.NOTION_API_KEY) {
    console.log('NOTION_API_KEY not set — skipping Notion card creation');
    return;
  }

  const { spawnSync } = require('child_process');
  const brain = path.join(__dirname, 'notion-brain.js');

  // Dedup: skip create if a prior closing-date audit card exists in ANY
  // non-Done state (In progress / Paused / Not started). Searching only
  // "In progress" let a user-Paused card slip through and the next run
  // created a duplicate. Done = user has actioned it, fresh card OK.
  // We do two searches (status=In progress + status=Paused) because the
  // CLI doesn't take a "not Done" filter; cards in "Not started" are also
  // checked since manual triage may set that status.
  const dedupStatuses = ['In progress', 'Paused', 'Not started'];
  let dedupHit = false;
  for (const status of dedupStatuses) {
    const search = spawnSync('node', [brain, 'search', '--text=Closing date audit', `--status=${status}`], { encoding: 'utf8' });
    if (search.status === 0 && /Closing date audit/.test(search.stdout || '')) {
      dedupHit = true;
      console.log(`Notion: existing ${status} audit card found — skipping create (dedup)`);
      break;
    }
  }
  if (dedupHit) return;

  const title = `Closing date audit: ${ambiguous.length} show${ambiguous.length > 1 ? 's' : ''} need review (${todayStr})`;
  // For each row, render the basic schedule discrepancy + (if present) the
  // triple-signal discovery result. When the audit found credible press
  // articles but their date disagreed with broadway.com schedule by >7d
  // (action: NEEDS_HUMAN_REVIEW with tripleSignalConflict attached), surface
  // the discovered date AND its sources so the human reviewer doesn't repeat
  // the same SERP search the audit just did.
  const rows = ambiguous.map(a => {
    if (a.action === 'POSSIBLY_CLOSED_NEEDS_REVIEW') {
      // Empty calendar while stored date is still days/weeks out → likely
      // already closed (no latestScheduled to report). |delta| = days the
      // stored date is still in the future.
      return `- **${a.id}** (POSSIBLY-CLOSED): stored=${a.stored} (${Math.abs(a.delta)}d out) but broadway.com lists NO future performances — likely closed earlier than stored. ${a.url}`;
    }
    const action = a.action === 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW' ? 'EXTENSION-CAP' : 'EARLIER';
    let line = `- **${a.id}** (${action}): stored=${a.stored}, broadway.com schedule ends ${a.latestScheduled} (${a.delta}d). ${a.url}`;
    if (a.tripleSignalConflict) {
      const c = a.tripleSignalConflict;
      const sourceLinks = c.sources.slice(0, 3).map(s => s.url).join(', ');
      line += `\n  📰 Press cluster: **${c.pressDate}** (${c.sources.length} source${c.sources.length > 1 ? 's' : ''}: ${sourceLinks}) — ${c.dayDelta}d off broadway.com schedule.`;
      if (c.sources[0] && c.sources[0].quote) {
        line += `\n  💬 “${c.sources[0].quote.replace(/[\n\r]+/g, ' ').slice(0, 200)}”`;
      }
    } else if (a.tripleSignalWriteFailed) {
      line += `\n  ⚠️ Triple-signal would have applied ${a.tripleSignalWriteFailed.newDate} but write was skipped (${a.tripleSignalWriteFailed.reason}). Apply manually.`;
    }
    return line;
  }).join('\n');

  const notes = [
    '## Problem',
    `Closing-date audit found ${ambiguous.length} show(s) where stored closingDate disagrees with broadway.com schedule by more than ${AMBIGUOUS_DELTA_THRESHOLD_DAYS} days. Could be either (a) calendar window short and stored is correct, or (b) show actually closing earlier than stored.`,
    '',
    '## Shows flagged',
    rows,
    '',
    '## Resolution steps',
    '1. For each show, check the 📰 Press cluster line — if present, that date is what credible theater press is announcing. Click the source URLs to verify, then update `data/shows.json`.',
    '2. If no press cluster shown, search Variety / Playbill / Deadline for closing or extension announcements yourself.',
    '3. If retraction confirmed → update closingDate in shows.json (lives in private repo `thomaspryor/broadway-scorecard-data` — symlinked at `data/shows.json`).',
    '4. Commit + push private repo; Vercel cron picks up within ~5 min.',
    '5. If stored date is correct (calendar window short), no action — add to `data/closing-date-audit-config.json` `ambiguousAllowlist` to suppress repeat alerts. Mark Done.',
    '',
    '## Acceptance criteria',
    "- Each show's stored closingDate matches the actual announced final performance, OR is confirmed as far-future with calendar-window short being the cause.",
    '',
    `_Auto-created by scripts/audit-closing-dates.js on ${todayStr}._`,
  ].join('\n');

  const create = spawnSync('node', [
    brain, 'create', title,
    '--priority', 'P1 Next',
    '--category', 'Data',
    '--type', 'Bug',
    '--tags', 'closing-date,audit,data-quality',
    '--notes', notes,
  ], { encoding: 'utf8' });

  if (create.status === 0) {
    const match = (create.stderr || '').match(/__NOTION_CARD_ID__=([a-f0-9-]+)/);
    console.log(`Notion: created card ${match ? match[1] : '(unknown id — check stdout)'}`);
  } else {
    console.warn('Notion: create failed:', (create.stderr || create.stdout || '').slice(0, 500));
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('CLOSING DATE AUDIT (bidirectional)');
  console.log('='.repeat(60));
  console.log(`Date: ${TODAY}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  // Broadway only. broadway.com reliably lists the full performance calendar
  // for Broadway shows, but NOT for Off-Broadway: empirically (2026-06-21
  // probe) 4/5 running OB shows returned zero future dates and the OB slug
  // pattern often doesn't resolve (broadway.com uses /shows/heathers-the-musical/
  // not /heathers-the-musical-off-broadway/). Extending this audit to OB
  // therefore produces false "possibly closed" flags on shows that are running
  // (Heathers, stored 2026-09-30, is open and extended — it got falsely flagged
  // in that probe). OB/WE closing-date verification needs a different source
  // (Playbill / TodayTix production pages) — tracked as a separate gap; do NOT
  // shoehorn it onto broadway.com. See memory/feedback_closing_date_audit_gaps.md.
  const candidates = data.shows.filter(s => {
    if (s.status !== 'open' || s.category !== 'broadway') return false;
    if (OPEN_RUN_SKIP.has(s.id)) return false;
    if (SHOWS_FILTER.length && !SHOWS_FILTER.includes(s.id)) return false;
    return true;
  });

  console.log(`Auditing ${candidates.length} open Broadway shows...`);
  console.log('');

  const extensions = [];   // applied auto
  const newClosings = [];  // applied auto
  const ambiguous = [];    // logged, NOT applied
  const errors = [];
  const matches = [];

  for (const show of candidates) {
    const slug = slugFor(show);
    try {
      const r = await fetchLatestSchedule(show, slug);
      if (r.error === 'title_mismatch') {
        errors.push({ id: show.id, reason: 'broadway_com_title_mismatch', url: r.url, hint: 'Slug may resolve to a different production — add a SLUG_OVERRIDE in data/closing-date-audit-config.json or add to openRunSkip.' });
        continue;
      }
      if (!r.latest) {
        // Title matched the broadway.com page but it lists ZERO future
        // performances. If the show claims to still be running for a clear
        // stretch (stored close is a future date >= POSSIBLY_CLOSED_MIN_DAYS
        // out), it almost certainly closed earlier than stored — the Burnout
        // Paradise class. Flag for human review rather than dropping silently
        // to errors. Allowlisted human-verified dates short-circuit.
        const daysUntilStored = show.closingDate
          ? Math.round((new Date(show.closingDate) - new Date(TODAY)) / 86400000)
          : null;
        if (show.closingDate && daysUntilStored >= POSSIBLY_CLOSED_MIN_DAYS && !isAllowlisted(show.id, show.closingDate)) {
          ambiguous.push({
            id: show.id, name: show.name, stored: show.closingDate,
            latestScheduled: null, url: r.url, delta: -daysUntilStored,
            action: 'POSSIBLY_CLOSED_NEEDS_REVIEW',
          });
        } else {
          errors.push({ id: show.id, reason: 'no_future_dates_on_schedule', url: r.url });
        }
        continue;
      }

      const stored = show.closingDate;
      const verdict = { id: show.id, name: show.name, stored, latestScheduled: r.latest, url: r.url };

      if (!stored) {
        // Shows with no closingDate are typically open-run musicals (Wicked,
        // MJ, Lion King). The latest scheduled date is the broadway.com
        // calendar window, NOT an announced close. Flag for human review;
        // never auto-assign.
        newClosings.push({ ...verdict, action: 'NEW_CLOSING_NEEDS_REVIEW' });
        continue;
      }

      const delta = Math.round((new Date(r.latest) - new Date(stored)) / 86400000);
      if (delta > 0 && delta > MAX_AUTO_EXTENSION_DAYS) {
        // Suspiciously large jump — likely a parseScheduleDates() false-positive
        // (unrelated date on the page). Surface to human instead of auto-applying.
        ambiguous.push({ ...verdict, delta, action: 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW' });
      } else if (delta > 0) {
        if (!canWriteClosingDate(show)) {
          // Human override in effect — log the extension finding but don't write.
          // The audit report still records it for transparency.
          extensions.push({ ...verdict, delta, action: 'EXTENSION_HUMAN_PROTECTED', skipped: true });
        } else {
          extensions.push({ ...verdict, delta, action: 'EXTENSION' });
          if (!DRY_RUN) {
            writeClosingDate(show, r.latest, `broadway.com schedule (audit ${TODAY})`, { todayStr: TODAY });
          }
        }
      } else if (delta < 0 && Math.abs(delta) > AMBIGUOUS_DELTA_THRESHOLD_DAYS) {
        // Schedule ends earlier than stored. Could be: (a) calendar
        // window short, stored is the real future close; (b) show actually
        // closing earlier than announced. We can't tell from this signal
        // alone — flag for human review.
        //
        // Allowlist short-circuit: if the show is human-verified-correct in
        // data/closing-date-audit-config.json AND stored still matches the
        // verified value, treat as a silent match. Drift (extension or
        // retraction) makes the stored date diverge from verifiedStored,
        // which bypasses this branch and resumes ambiguous flagging.
        if (isAllowlisted(show.id, stored)) {
          matches.push({ ...verdict, delta, allowlistedFalsePositive: true });
        } else {
          ambiguous.push({ ...verdict, delta, action: 'NEEDS_HUMAN_REVIEW' });
        }
      } else {
        matches.push({ ...verdict, delta });
      }
    } catch (e) {
      errors.push({ id: show.id, reason: 'fetch_error', message: e.message.slice(0, 120) });
    }
  }

  // ── Triple-signal auto-fix pass ────────────────────────────────────────
  // For each ambiguous show, SERP credible theater press for closing
  // announcements within the last month and LLM-extract dates. Auto-apply
  // when the press cluster and broadway.com schedule agree within ±7 days.
  // Cap attempts to bound cost; sort by stored-closing-date ascending so
  // the most-urgent retractions (closing soonest) get the auto-fix budget.
  const autoFixedTripleSignal = [];
  if (process.env.ANTHROPIC_API_KEY && ambiguous.length > 0) {
    // Run discovery for BOTH earlier-than-stored (NEEDS_HUMAN_REVIEW) and
    // suspicious-large-jump extensions (EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW) —
    // a real 200-day extension shouldn't be locked out of the LLM rescue path.
    const byUrgency = ambiguous
      .filter(a => a.action === 'NEEDS_HUMAN_REVIEW' || a.action === 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW')
      .sort((a, b) => new Date(a.stored) - new Date(b.stored))
      .slice(0, MAX_TRIPLE_SIGNAL_ATTEMPTS);
    console.log(`\nTriple-signal auto-fix: attempting ${byUrgency.length} ambiguous show(s)`);
    for (const a of byUrgency) {
      const show = candidates.find(c => c.id === a.id);
      if (!show) continue;
      // Title-field consistency: rest of the file uses show.name, fall through
      // to show.title only if name is missing. shows.json schema uses `title`,
      // but the audit script normalized to `name` earlier — use both as a
      // safety net.
      const showTitle = show.name || show.title || a.id;
      let discovery;
      try {
        discovery = await discoverAnnouncedClosingDate(showTitle, { log: (msg) => console.log(msg) });
      } catch (e) {
        console.warn(`  [auto-fix] ${a.id}: discovery error: ${e.message.slice(0, 120)}`);
        continue;
      }
      if (!discovery) continue;

      const dayDelta = Math.abs((new Date(discovery.date) - new Date(a.latestScheduled)) / 86400000);
      if (dayDelta > TRIPLE_SIGNAL_TOLERANCE_DAYS) {
        // Press article disagrees with broadway.com schedule. Don't apply;
        // log for human review (the Notion card will surface it).
        a.tripleSignalConflict = {
          pressDate: discovery.date,
          scheduleDate: a.latestScheduled,
          dayDelta,
          sources: discovery.sources,
        };
        continue;
      }

      // All three signals agree (stored disagrees by definition since this
      // is ambiguous). Auto-apply the press date — it's the authoritative
      // announcement; broadway.com schedule is just the lower-bound proof.
      const newDate = discovery.date;
      const targetShow = !DRY_RUN ? data.shows.find(s => s.id === a.id) : null;
      if (!DRY_RUN && !targetShow) {
        // Found in `candidates` but missing in `data.shows`: this means the
        // arrays diverged (concurrent reformat, hot-rebuild). Don't claim
        // we fixed it; log and surface to Notion review.
        console.warn(`  [auto-fix] ${a.id}: in candidates but not data.shows — skipping write`);
        a.tripleSignalWriteFailed = { reason: 'target_not_in_data_shows', newDate };
        continue;
      }
      if (targetShow) {
        if (!canWriteClosingDate(targetShow)) {
          console.warn(`  [auto-fix] ${a.id}: humanCorrectedClosingDate=true — skipping triple-signal write`);
          a.tripleSignalWriteFailed = { reason: 'humanCorrectedClosingDate', newDate };
          continue;
        }
        // Record what we replaced BEFORE overwriting — single field to roll back from.
        targetShow.closingDatePrevious = a.stored;
        // Cite ALL corroborating sources, not just the first — preserves
        // the audit trail when reviewing a wrong auto-fix later.
        const sourceList = discovery.sources.map(s => s.url).join(', ');
        writeClosingDate(targetShow, newDate,
          `triple-signal audit (${TODAY}): broadway.com + ${sourceList}`,
          { todayStr: TODAY });
      }
      autoFixedTripleSignal.push({
        id: a.id,
        previousStored: a.stored,
        newClosingDate: newDate,
        scheduleDate: a.latestScheduled,
        pressDate: discovery.date,
        dayDelta,
        sources: discovery.sources,
      });
    }
    // Remove auto-fixed shows from ambiguous so they don't double-flag
    // in the Discord/Notion path.
    if (autoFixedTripleSignal.length > 0) {
      const fixedIds = new Set(autoFixedTripleSignal.map(x => x.id));
      for (let i = ambiguous.length - 1; i >= 0; i--) {
        if (fixedIds.has(ambiguous[i].id)) ambiguous.splice(i, 1);
      }
    }
  } else if (ambiguous.length > 0 && !process.env.ANTHROPIC_API_KEY) {
    console.log('\nTriple-signal auto-fix: skipped (ANTHROPIC_API_KEY not set)');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'live',
    summary: {
      audited: candidates.length,
      extensions: extensions.length,
      autoFixedTripleSignal: autoFixedTripleSignal.length,
      newClosings: newClosings.length,
      ambiguous: ambiguous.length,
      matches: matches.length,
      errors: errors.length,
    },
    extensions,
    autoFixedTripleSignal,
    newClosings,
    ambiguous,
    matches,
    errors,
  };

  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote ${AUDIT_FILE}`);

  console.log('\nResults:');
  console.log(`  ✅ Matches (within ${AMBIGUOUS_DELTA_THRESHOLD_DAYS}d): ${matches.length}`);
  console.log(`  📈 Extensions auto-applied:    ${extensions.length}`);
  console.log(`  🤖 Triple-signal auto-fixed:   ${autoFixedTripleSignal.length}`);
  console.log(`  🆕 New-closing candidates (review only): ${newClosings.length}`);
  console.log(`  ⚠️  Ambiguous (>30d earlier):  ${ambiguous.length}`);
  console.log(`  ❌ Errors:                     ${errors.length}`);

  for (const e of extensions) console.log(`  EXT  ${e.id}: ${e.stored} → ${e.latestScheduled} (+${e.delta}d)`);
  for (const f of autoFixedTripleSignal) console.log(`  AUTO ${f.id}: ${f.previousStored} → ${f.newClosingDate} (3-signal: broadway.com + ${f.sources.length} press source(s))`);
  for (const n of newClosings) console.log(`  NEW  ${n.id}: null → schedule ends ${n.latestScheduled} (review — may be open run)`);
  for (const a of ambiguous) console.log(`  AMB  ${a.id}: stored=${a.stored} schedule=${a.latestScheduled} (${a.delta}d)`);

  const changed = extensions.length + autoFixedTripleSignal.length;
  if (changed > 0 && !DRY_RUN) {
    fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log(`\n✅ Wrote ${changed} closingDate updates to shows.json`);
  }

  if (ambiguous.length > 0) {
    const lines = ambiguous.map(a => `• ${a.id}: stored ${a.stored}, schedule cuts off at ${a.latestScheduled} (${a.delta}d earlier)`).join('\n');
    await notifyDiscord(`⚠️ Closing-date audit found ${ambiguous.length} show(s) where stored closingDate is >30d after schedule end. Verify whether stored is correct (calendar window short) or stale.\n\n${lines}`);
    await notifyNotion(ambiguous, TODAY);
  }

  await cleanup();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await cleanup();
  process.exit(1);
});
