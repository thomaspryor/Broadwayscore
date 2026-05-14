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

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit', 'closing-date-discrepancies.json');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'closing-date-audit-config.json');
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_YEAR = new Date().getFullYear();

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SHOWS_FILTER = (argv.find(a => a.startsWith('--shows=')) || '').replace('--shows=', '').split(',').filter(Boolean);
const AMBIGUOUS_DELTA_THRESHOLD_DAYS = 30;

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const SLUG_OVERRIDES = CONFIG.slugOverrides;
const OPEN_RUN_SKIP = new Set(CONFIG.openRunSkip.ids);

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

async function main() {
  console.log('='.repeat(60));
  console.log('CLOSING DATE AUDIT (bidirectional)');
  console.log('='.repeat(60));
  console.log(`Date: ${TODAY}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
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
        errors.push({ id: show.id, reason: 'no_future_dates_on_schedule', url: r.url });
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
      if (delta > 0) {
        extensions.push({ ...verdict, delta, action: 'EXTENSION' });
        if (!DRY_RUN) {
          show.closingDate = r.latest;
          show.closingDateSource = `broadway.com schedule (audit ${TODAY})`;
          show.closingDateUpdatedAt = TODAY;
        }
      } else if (delta < 0 && Math.abs(delta) > AMBIGUOUS_DELTA_THRESHOLD_DAYS) {
        // Schedule ends earlier than stored. Could be: (a) calendar
        // window short, stored is the real future close; (b) show actually
        // closing earlier than announced. We can't tell from this signal
        // alone — flag for human review.
        ambiguous.push({ ...verdict, delta, action: 'NEEDS_HUMAN_REVIEW' });
      } else {
        matches.push({ ...verdict, delta });
      }
    } catch (e) {
      errors.push({ id: show.id, reason: 'fetch_error', message: e.message.slice(0, 120) });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'live',
    summary: {
      audited: candidates.length,
      extensions: extensions.length,
      newClosings: newClosings.length,
      ambiguous: ambiguous.length,
      matches: matches.length,
      errors: errors.length,
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
  console.log(`  ✅ Matches (within ${AMBIGUOUS_DELTA_THRESHOLD_DAYS}d): ${matches.length}`);
  console.log(`  📈 Extensions auto-applied:    ${extensions.length}`);
  console.log(`  🆕 New-closing candidates (review only): ${newClosings.length}`);
  console.log(`  ⚠️  Ambiguous (>30d earlier):  ${ambiguous.length}`);
  console.log(`  ❌ Errors:                     ${errors.length}`);

  for (const e of extensions) console.log(`  EXT  ${e.id}: ${e.stored} → ${e.latestScheduled} (+${e.delta}d)`);
  for (const n of newClosings) console.log(`  NEW  ${n.id}: null → schedule ends ${n.latestScheduled} (review — may be open run)`);
  for (const a of ambiguous) console.log(`  AMB  ${a.id}: stored=${a.stored} schedule=${a.latestScheduled} (${a.delta}d)`);

  const changed = extensions.length;
  if (changed > 0 && !DRY_RUN) {
    fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log(`\n✅ Wrote ${changed} closingDate updates to shows.json`);
  }

  if (ambiguous.length > 0) {
    const lines = ambiguous.map(a => `• ${a.id}: stored ${a.stored}, schedule cuts off at ${a.latestScheduled} (${a.delta}d earlier)`).join('\n');
    await notifyDiscord(`⚠️ Closing-date audit found ${ambiguous.length} show(s) where stored closingDate is >30d after schedule end. Verify whether stored is correct (calendar window short) or stale.\n\n${lines}`);
  }

  await cleanup();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await cleanup();
  process.exit(1);
});
