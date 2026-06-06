#!/usr/bin/env node
/**
 * Show Status Updater (Broadway, Off-Broadway, West End)
 *
 * Conservative status updates:
 * 1. Only marks shows as closed if closing date passed 7+ days ago
 *    (grace period allows time to catch extensions)
 * 2. Checks for previews → open transitions based on opening date
 * 3. Refreshes West End closing dates from TodayTix API (catches extensions)
 * 4. Does NOT make assumptions from ticket availability
 *
 * This is intentionally conservative to avoid false positives.
 * Closing dates should be discovered via audit-closing-dates.js
 *
 * Usage: node scripts/update-show-status.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { extractStatusFromHtml } = require('./lib/show-score-status');
const { writeClosingDate, canWriteClosingDate } = require('./lib/closing-date-guard');
const { countByShow, isStuckInPreviews, chooseOpeningDateBackfill } = require('./lib/opening-signal');
const { openingDateSourceHint } = require('./lib/opening-date-sources');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_FILE = path.join(__dirname, '..', 'data', 'reviews.json');
const OUTLET_REGISTRY_FILE = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const URLS_FILE = path.join(__dirname, '..', 'data', 'show-score-urls.json');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'show-score');
const dryRun = process.argv.includes('--dry-run');
const includeShowScore = process.argv.includes('--include-showscore');

// Grace period in days - don't auto-close until this many days after closing date
// This gives time for the audit-closing-dates script to catch extensions
// Override with --grace-period=N for launch prep (e.g., --grace-period=0)
const gracePeriodArg = process.argv.find(a => a.startsWith('--grace-period='));
const CLOSING_GRACE_PERIOD_DAYS = gracePeriodArg ? parseInt(gracePeriodArg.split('=')[1], 10) : 7;

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  if (!data._meta) data._meta = {};
  data._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function isDatePassed(dateStr) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date < today;
}

function isDatePassedByDays(dateStr, days) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  const threshold = new Date();
  threshold.setHours(0, 0, 0, 0);
  threshold.setDate(threshold.getDate() - days);
  date.setHours(0, 0, 0, 0);
  return date < threshold;
}

function isDateReached(dateStr) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date <= today;
}

// ── TodayTix API for West End date refresh ──

function fetchTodayTixPage(location, offset = 0, limit = 100) {
  const url = `https://api.todaytix.com/api/v2/shows?location=${location}&limit=${limit}&offset=${offset}`;
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix API HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('TodayTix JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function fetchAllTodayTixShows(location) {
  const allShows = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const result = await fetchTodayTixPage(location, offset, limit);
    const shows = result.data || [];
    allShows.push(...shows);
    if (shows.length < limit) break;
    offset += limit;
  }
  return allShows;
}

function showCategory(show) {
  return show.category || 'broadway';
}

/**
 * Refresh closing dates for all markets from TodayTix API.
 * Also detects wrongly-closed shows that TodayTix still lists as active.
 */
async function refreshTodayTixDates(data, updates) {
  console.log('\n--- TodayTix Date Refresh ---');

  // Track IDs of shows reopened by TodayTix so the main closing loop
  // doesn't immediately re-close them in the same run
  const reopenedIds = new Set();

  // TodayTix location 2 covers all London venues, not just SOLT West End houses.
  // Must include 'off-west-end' or fringe/subsidised shows (Bridge Theatre, Young Vic,
  // Donmar, Almeida, Park, etc.) never get closing-date extensions refreshed and
  // eventually cascade to status=closed once the stale date passes the grace period.
  const locations = [
    { id: 2, label: 'London (West End + Off-West End)', categories: new Set(['west-end', 'off-west-end']) },
    { id: 1, label: 'NYC (Broadway/OB)', categories: new Set(['broadway', 'off-broadway']) },
  ];

  // Build per-category maps to prevent cross-market title collisions
  // Key: category → { byTodayTixId, byTitle }
  const catMaps = {};
  for (const loc of locations) {
    for (const cat of loc.categories) {
      catMaps[cat] = { byTodayTixId: {}, byTitle: {} };
    }
  }

  // Index active shows (open/previews) into per-category maps
  const activeShows = data.shows.filter(s =>
    s.status === 'open' || s.status === 'previews'
  );
  for (const show of activeShows) {
    const cat = showCategory(show);
    const map = catMaps[cat];
    if (!map) continue; // unknown category
    if (show.todaytixId) map.byTodayTixId[show.todaytixId] = show;
    const normTitle = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normTitle) map.byTitle[normTitle] = show;
  }

  // Index closed shows with todaytixId for wrongly-closed detection.
  // Only use todaytixId matches (NOT title) — title matches on closed shows
  // are too risky due to revivals, transfers, and same-title different productions.
  const closedByTtId = {};
  for (const show of data.shows) {
    if (show.status !== 'closed') continue;
    if (!show.todaytixId) continue;
    const cat = showCategory(show);
    if (!catMaps[cat]) continue;
    if (!closedByTtId[cat]) closedByTtId[cat] = {};
    closedByTtId[cat][show.todaytixId] = show;
  }

  let dateUpdates = 0;
  let reopened = 0;
  let newTtIds = 0;
  const seenTtIds = new Set(); // Track all TodayTix IDs seen across locations

  for (const loc of locations) {
    try {
      const ttShows = await fetchAllTodayTixShows(loc.id);
      console.log(`  TodayTix ${loc.label}: ${ttShows.length} shows`);
      if (ttShows.length === 0) {
        console.error(`  ⚠️  WARNING: TodayTix ${loc.label} returned 0 shows — API may be down or format changed`);
      }

      for (const ttShow of ttShows) {
        seenTtIds.add(String(ttShow.id));
        const ttEndDate = ttShow.endDate === 'null' ? null : ttShow.endDate || null;
        const normTtTitle = (ttShow.displayName || ttShow.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        // Try to match within each category this location covers
        let match = null;
        for (const cat of loc.categories) {
          const map = catMaps[cat];
          match = map.byTodayTixId[ttShow.id] || map.byTitle[normTtTitle];
          if (match) break;
        }

        // Check wrongly-closed shows if no active match found
        // Only match by todaytixId (not title) to avoid false positives from
        // revivals, transfers, and same-title different productions
        if (!match) {
          for (const cat of loc.categories) {
            const closedMatch = (closedByTtId[cat] || {})[ttShow.id];
            if (closedMatch) {
              // Verify title similarity to guard against TodayTix ID recycling
              // (MEMORY.md: "TodayTix recycles numeric IDs")
              const closedNorm = (closedMatch.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              if (closedNorm && normTtTitle && closedNorm !== normTtTitle && !closedNorm.includes(normTtTitle) && !normTtTitle.includes(closedNorm)) {
                console.log(`  ⚠️  TodayTix ID ${ttShow.id} recycled: our "${closedMatch.title}" vs TT "${ttShow.displayName || ttShow.name}" — skipping`);
                break;
              }
              // Same todaytixId AND similar title — TodayTix still lists this exact show!
              const oldClosingDate = closedMatch.closingDate;
              console.log(`  🔄 ${closedMatch.title}: TodayTix (id=${ttShow.id}) still lists this show — reopening (was closed with closingDate=${oldClosingDate})`);
              if (!dryRun) {
                closedMatch.status = 'open';
                if (ttEndDate) {
                  writeClosingDate(closedMatch, ttEndDate, `update-show-status reopen (${new Date().toISOString().slice(0,10)})`);
                } else if (canWriteClosingDate(closedMatch)) {
                  delete closedMatch.closingDate;
                }
              }
              reopenedIds.add(closedMatch.id);
              updates.push({
                id: closedMatch.id,
                title: closedMatch.title,
                changes: {
                  status: { from: 'closed', to: 'open' },
                  closingDate: { from: oldClosingDate || 'none', to: ttEndDate || 'none (open-ended)' },
                  note: `Wrongly-closed show detected — TodayTix (${loc.label}) still lists it (todaytixId=${ttShow.id})`
                }
              });
              reopened++;
              break;
            }
          }
          continue; // Already handled (or no match) — skip date update logic
        }

        // Save todaytixId if we matched by title but show doesn't have one
        if (!match.todaytixId && ttShow.id) {
          if (!dryRun) match.todaytixId = ttShow.id;
          newTtIds++;
        }

        if (!ttEndDate) continue; // Open-ended run, skip date updates

        // Compare dates: only update if TodayTix date is LATER (extension)
        if (match.closingDate && ttEndDate > match.closingDate) {
          const oldDate = match.closingDate;
          if (!canWriteClosingDate(match)) {
            console.log(`  🔒 ${match.title}: humanCorrectedClosingDate=true — skipping TodayTix extension ${oldDate} → ${ttEndDate}`);
          } else {
            console.log(`  📅 ${match.title}: closing date extended ${oldDate} → ${ttEndDate}`);
            if (!dryRun) {
              writeClosingDate(match, ttEndDate, `TodayTix (${loc.label})`);
            }
            updates.push({
              id: match.id,
              title: match.title,
              changes: {
                closingDate: { from: oldDate, to: ttEndDate },
                note: `Extension detected via TodayTix (${loc.label})`
              }
            });
            dateUpdates++;
          }
        }

        // Also set closingDate if we had none and TodayTix has one
        if (!match.closingDate && ttEndDate) {
          if (!canWriteClosingDate(match)) {
            // Show has humanCorrectedClosingDate=true but no closingDate — bizarre,
            // but respect the human flag and don't write.
            console.log(`  🔒 ${match.title}: humanCorrectedClosingDate=true but stored closingDate is empty — skipping`);
          } else {
            console.log(`  📅 ${match.title}: closing date added ${ttEndDate} (was unknown)`);
            if (!dryRun) {
              writeClosingDate(match, ttEndDate, `TodayTix (${loc.label}) — discovered`);
            }
            updates.push({
              id: match.id,
              title: match.title,
              changes: {
                closingDate: { from: 'none', to: ttEndDate },
                note: `Closing date discovered via TodayTix (${loc.label})`
              }
            });
            dateUpdates++;
          }
        }
      }
    } catch (err) {
      console.error(`  ⚠️  TodayTix ${loc.label} fetch failed (non-fatal): ${err.message}`);
    }
  }

  if (newTtIds > 0) console.log(`  TodayTix IDs saved: ${newTtIds} (future matches use ID instead of title)`);
  if (reopened > 0) console.log(`  Wrongly-closed shows reopened: ${reopened}`);
  console.log(`  TodayTix date updates: ${dateUpdates}`);

  // Stale-open detection for OB/WE shows
  // Shows with todaytixId that are open/previews but NOT seen on TodayTix
  // may have closed without us detecting it. Use a 3-day grace period
  // to avoid false positives from transient API issues.
  const MAX_AUTO_CLOSE = 5; // Circuit breaker — mass disappearance = API problem
  let autoCloseCount = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const show of data.shows) {
    if (show.status !== 'open' && show.status !== 'previews') continue;
    if (!show.todaytixId) continue;
    const cat = showCategory(show);
    if (cat === 'broadway') continue; // Broadway has better closing date sources

    if (seenTtIds.has(String(show.todaytixId))) {
      // Show seen on TodayTix — clear any staleness tracking
      if (show._staleMissingSince && !dryRun) {
        delete show._staleMissingSince;
      }
      continue;
    }

    // Not seen on TodayTix
    if (!show._staleMissingSince) {
      if (!dryRun) show._staleMissingSince = today;
      console.log(`  🔍 ${show.title} (${cat}): first miss from TodayTix (tracking started)`);
      continue; // Don't close on first miss
    }

    // Check if missing for 3+ days (or 1+ day if closingDate is already past)
    const missingSince = new Date(show._staleMissingSince);
    const daysMissing = Math.floor((Date.now() - missingSince) / 86400000);
    const closingDatePast = show.closingDate && show.closingDate < today;
    const requiredDays = closingDatePast ? 1 : 3;
    if (daysMissing < requiredDays) {
      console.log(`  🔍 ${show.title} (${cat}): missing ${daysMissing} days (need ${requiredDays}+${closingDatePast ? ' — closing date past' : ''})`);
      continue;
    }

    // Don't auto-close if closingDate is still in the future — TodayTix listing may have
    // been removed early (presale ended, etc.) but the show is still running
    if (show.closingDate && show.closingDate >= today) {
      console.log(`  ⚠️  ${show.title} (${cat}): missing from TodayTix ${daysMissing} days but closingDate ${show.closingDate} is still future — skipping auto-close`);
      continue;
    }

    // Circuit breaker
    if (autoCloseCount >= MAX_AUTO_CLOSE) {
      console.log(`  ⚠️ Circuit breaker: ${MAX_AUTO_CLOSE} auto-closes reached, skipping remaining`);
      break;
    }

    console.log(`  📕 ${show.title} (${cat}): missing from TodayTix for ${daysMissing}+ days — auto-closing`);
    if (!dryRun) {
      show.status = 'closed';
      delete show._staleMissingSince;
      // Don't set closingDate — we don't know when it actually closed
    }
    autoCloseCount++;
    updates.push({
      id: show.id,
      title: show.title,
      changes: {
        status: { from: 'open', to: 'closed' },
        note: `Stale-open detection: missing from TodayTix for ${daysMissing}+ days`
      }
    });
  }

  if (autoCloseCount > 0) console.log(`  Stale-open auto-closes: ${autoCloseCount}`);

  // Build set of our show IDs that are confirmed active on TodayTix
  const ttActiveShowIds = new Set();
  for (const show of data.shows) {
    if (!show.todaytixId) continue;
    if (seenTtIds.has(String(show.todaytixId))) {
      ttActiveShowIds.add(show.id);
    }
  }

  return { count: dateUpdates + reopened + autoCloseCount, reopenedIds, ttActiveShowIds };
}

// ── ShowScore Status Refresh (weekly) ──

/**
 * Refresh show statuses from ShowScore pages for OB + WE shows.
 * Uses archived HTML when fresh (<7 days), fetches live otherwise.
 * Cross-validates with TodayTix: never closes a show ShowScore says closed
 * if TodayTix still lists it (Hold On To Your Butts pattern).
 *
 * @param {object} data - shows.json data
 * @param {Array} updates - updates array to push changes into
 * @param {Set} ttActiveIds - set of show IDs confirmed active on TodayTix
 */
async function refreshShowScoreStatuses(data, updates, ttActiveIds) {
  console.log('\n--- ShowScore Status Refresh ---');

  let urlsData;
  try {
    urlsData = JSON.parse(fs.readFileSync(URLS_FILE, 'utf8'));
  } catch {
    console.log('  ⚠️  show-score-urls.json not found, skipping ShowScore refresh');
    return { count: 0 };
  }
  const ssUrls = urlsData.shows || {};

  // Filter to active OB/WE/Broadway shows with ShowScore URLs
  const targetShows = data.shows.filter(s =>
    (s.status === 'open' || s.status === 'previews') &&
    ssUrls[s.id]
  );

  console.log(`  Checking ${targetShows.length} active shows against ShowScore...`);

  const MAX_SS_STATUS_CHANGES = 20; // Circuit breaker — higher than TodayTix (routine refresh)
  let statusChanges = 0;
  let dateUpdates = 0;
  let fetchCount = 0;
  let errors = 0;
  const ARCHIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Lazy-load scraper only when we need to fetch
  let fetchPage = null;
  let cleanupScraper = null;

  for (const show of targetShows) {
    if (statusChanges >= MAX_SS_STATUS_CHANGES) {
      console.log(`  ⚠️  Circuit breaker: ${MAX_SS_STATUS_CHANGES} ShowScore status changes reached, skipping remaining`);
      break;
    }

    const archivePath = path.join(ARCHIVE_DIR, `${show.id}.html`);
    let html = null;

    // Try archive first, check freshness via mtime
    if (fs.existsSync(archivePath)) {
      const stat = fs.statSync(archivePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < ARCHIVE_MAX_AGE_MS) {
        html = fs.readFileSync(archivePath, 'utf8');
      }
    }

    // Live fetch if no fresh archive
    if (!html) {
      try {
        // Lazy-load scraper on first fetch
        if (!fetchPage) {
          const scraper = require('./lib/scraper');
          fetchPage = scraper.fetchPage;
          cleanupScraper = scraper.cleanup;
        }
        const url = ssUrls[show.id];
        const result = await fetchPage(url);
        if (result && result.content) {
          html = result.content;
          // Update archive
          if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
          const header = `<!--\n  Archived: ${new Date().toISOString()}\n  Source: ${url}\n  Status: 200\n-->\n`;
          fs.writeFileSync(archivePath, header + html);
        }
        fetchCount++;
        await new Promise(r => setTimeout(r, 800)); // Rate limit
      } catch (e) {
        console.log(`  ❌ ${show.id}: ShowScore fetch failed — ${e.message}`);
        errors++;
        continue;
      }
    }

    if (!html) continue;

    const ssData = extractStatusFromHtml(html);
    if (!ssData || !ssData.ssStatus) continue;

    const changes = [];
    const cat = showCategory(show);
    const ttActive = ttActiveIds.has(show.id);

    // Cross-validation: ShowScore says closed
    if (ssData.ssStatus === 'closed' && (show.status === 'open' || show.status === 'previews')) {
      if (ttActive) {
        // Hold On To Your Butts pattern — TodayTix still lists it, don't trust ShowScore
        console.log(`  ⚠️  ${show.title} (${cat}): ShowScore says "Closed" but TodayTix still active — NOT closing`);
      } else {
        changes.push({
          field: 'status',
          from: show.status,
          to: 'closed',
          note: `ShowScore says "${ssData.raw}", TodayTix not active`
        });
        if (!dryRun) show.status = 'closed';
        statusChanges++;
      }
    }

    // Status upgrade: previews → open
    if (show.status === 'previews' && (ssData.ssStatus === 'open')) {
      changes.push({
        field: 'status',
        from: 'previews',
        to: 'open',
        note: `ShowScore says "${ssData.raw}"`
      });
      if (!dryRun) show.status = 'open';
      statusChanges++;
    }

    // Fill opening date gap
    if (ssData.openingDate && !show.openingDate && show.status === 'previews') {
      changes.push({
        field: 'openingDate',
        from: 'null',
        to: ssData.openingDate,
        note: `ShowScore "Opens" date`
      });
      if (!dryRun) show.openingDate = ssData.openingDate;
      dateUpdates++;
    }

    // Fill closing date gap
    if (ssData.closingDate && !show.closingDate) {
      if (!canWriteClosingDate(show)) {
        // Human-protected with no stored closingDate — respect the flag, don't fill.
      } else {
        changes.push({
          field: 'closingDate',
          from: 'null',
          to: ssData.closingDate,
          note: `ShowScore "Ends" date`
        });
        if (!dryRun) writeClosingDate(show, ssData.closingDate, 'ShowScore "Ends" date');
        dateUpdates++;
      }
    }

    // Fill venue gap
    if (ssData.venue && (!show.venue || show.venue === 'TBA')) {
      changes.push({
        field: 'venue',
        from: show.venue || 'null',
        to: ssData.venue,
        note: 'ShowScore venue'
      });
      if (!dryRun) show.venue = ssData.venue;
    }

    if (changes.length > 0) {
      const changeDesc = changes.map(c => `${c.field}: ${c.from} → ${c.to}`).join(', ');
      console.log(`  ✓ ${show.title} (${cat}): ${changeDesc} [SS: "${ssData.raw}"]`);
      updates.push({
        id: show.id,
        title: show.title,
        changes: Object.fromEntries(changes.map(c => [c.field, { from: c.from, to: c.to, note: c.note }]))
      });
    }
  }

  // Cleanup scraper if we used it
  if (cleanupScraper) {
    await cleanupScraper();
  }

  console.log(`  ShowScore: ${statusChanges} status changes, ${dateUpdates} date updates, ${fetchCount} live fetches, ${errors} errors`);

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ss_updates_count=${statusChanges + dateUpdates}\n`);
  }

  return { count: statusChanges + dateUpdates };
}

async function updateShowStatuses() {
  console.log('='.repeat(60));
  console.log('SHOW STATUS UPDATER');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();
  const updates = [];

  // Review-driven open signal: reviews.json is the post-rebuild displayed set
  // (every entry scored 1-100, no wrongProduction/roundup flags), so a per-show
  // count == the site's review count. Used by Check 2d below to flip shows that
  // opened but never got their status flipped (null openingDate + no ShowScore).
  // We also count T1/T2 reviews per show (via the outlet-registry tier) so the
  // flip uses the SAME score-display threshold as the site — a T3-only show needs
  // +2 reviews, and flipping it early would label it "Now Playing" while the score
  // is still TBD (the original bug, inverted).
  let reviewCounts = {};
  try {
    const rraw = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
    let tierOf;
    try {
      const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_FILE, 'utf8'));
      const outlets = registry.outlets || registry;
      tierOf = (r) => {
        const o = outlets[r.outletId] || outlets[r.outlet];
        return o ? o.tier : undefined;
      };
    } catch (regErr) {
      console.log(`  ⚠️  Could not load outlet-registry.json for tier counts: ${regErr.message}`);
    }
    reviewCounts = countByShow(rraw.reviews || rraw, tierOf);
  } catch (err) {
    console.log(`  ⚠️  Could not load reviews.json for review-driven open signal: ${err.message}`);
  }

  // Refresh closing dates from TodayTix BEFORE status checks
  // so extensions are detected before the closing-grace-period logic runs
  const { reopenedIds, ttActiveShowIds } = await refreshTodayTixDates(data, updates);

  // ShowScore cross-validation (weekly, gated by --include-showscore)
  // Runs AFTER TodayTix so we can cross-validate: if TodayTix still lists a show,
  // don't trust ShowScore's "Closed" status (Hold On To Your Butts pattern)
  if (includeShowScore) {
    await refreshShowScoreStatuses(data, updates, ttActiveShowIds);
  }

  for (const show of data.shows) {
    const changes = {};

    // Check 1: Close shows whose closing date has passed (with grace period)
    // Skip shows just reopened by TodayTix — they were wrongly closed and TodayTix
    // confirms they're still running (even if the endDate is technically past)
    // Grace period gives audit-closing-dates.js time to catch extensions
    // Exception: if TodayTix also confirms the show is gone, skip the grace period
    const ttConfirmsClosed = show._staleMissingSince && !reopenedIds.has(show.id);
    const graceDays = ttConfirmsClosed ? 1 : CLOSING_GRACE_PERIOD_DAYS;
    if (show.status === 'open' && show.closingDate && isDatePassedByDays(show.closingDate, graceDays) && !reopenedIds.has(show.id)) {
      changes.status = { from: 'open', to: 'closed' };
      changes.note = ttConfirmsClosed
        ? `Closing date ${show.closingDate} passed and missing from TodayTix`
        : `Closing date ${show.closingDate} passed ${CLOSING_GRACE_PERIOD_DAYS}+ days ago`;
      if (!dryRun) {
        show.status = 'closed';
        if (show._staleMissingSince) delete show._staleMissingSince;
      }
    }

    // Flag shows approaching closing (but don't change status)
    if (show.status === 'open' && show.closingDate && isDatePassed(show.closingDate) && !isDatePassedByDays(show.closingDate, graceDays)) {
      console.log(`  ⚠️  ${show.title}: closing date ${show.closingDate} passed - in grace period (check for extension)`);
    }

    // Check 2: Move previews to open if opening date has passed
    if (show.status === 'previews' && show.openingDate && isDateReached(show.openingDate)) {
      changes.status = { from: 'previews', to: 'open' };
      if (!dryRun) {
        show.status = 'open';
      }
    }

    // Check 2c: Revert open → previews when openingDate is in the future.
    // Triggers when an enrichment script (enrich-off-broadway-dates.js,
    // enrich-west-end-dates.js, enrich-ibdb-dates.js) corrects an openingDate
    // FORWARD after a previous run had already flipped the show to 'open'.
    // Without this revert, the UI shows "Now Playing" during the previews
    // window. Requires today >= previewsStartDate so we don't pull a true
    // upcoming show into 'previews'. Skips Check 2's path because Check 2
    // requires status==='previews' (mutually exclusive with this branch).
    if (
      show.status === 'open' &&
      show.openingDate && !isDateReached(show.openingDate) &&
      show.previewsStartDate && isDateReached(show.previewsStartDate)
    ) {
      changes.status = { from: 'open', to: 'previews' };
      changes.note = `openingDate ${show.openingDate} is in the future; previews started ${show.previewsStartDate}`;
      if (!dryRun) {
        show.status = 'previews';
      }
    }

    // Check 2b: Move upcoming shows to open/previews based on dates
    if (show.status === 'upcoming' && show.openingDate && isDateReached(show.openingDate)) {
      changes.status = { from: 'upcoming', to: 'open' };
      if (!dryRun) {
        show.status = 'open';
      }
    } else if (show.status === 'upcoming' && show.previewsStartDate && isDateReached(show.previewsStartDate)) {
      changes.status = { from: 'upcoming', to: 'previews' };
      if (!dryRun) {
        show.status = 'previews';
      }
    }

    // Check 2d: Review-driven open. A show in previews/upcoming that has
    // accumulated enough scored reviews to display a score has demonstrably
    // opened — critics review on/after press night, not during previews. This
    // is the backstop for the failure mode where Check 2/2b can't fire because
    // openingDate is null and there's no ShowScore URL (rodeo/the-last-man/small,
    // 2026-06). The threshold equals the site's score-display threshold, so this
    // only ever flips shows that are already past the "enough reviews" bar.
    // Runs only when the earlier date-based checks didn't already change status.
    if (!changes.status) {
      const entry = reviewCounts[show.id];
      if (isStuckInPreviews(show, entry)) {
        const from = show.status;
        const reviewCount = entry.count;
        changes.status = { from, to: 'open' };
        // Marker: this is a catch-up flip driven by accumulated reviews, NOT a
        // live opening. It MUST be excluded from opened_count/opened_slugs so it
        // doesn't trigger opening-night automation (poller, broadcast) for a show
        // that opened days/weeks ago. See openedShows filter below. Trade-off:
        // this also withholds the catch-up show from the gather-reviews / cast /
        // indexing dispatches that key on opened_slugs — acceptable because those
        // self-heal on their own weekly schedules, and avoiding a wrong broadcast
        // (email about a weeks-old "opening") is the higher priority (CLAUDE.md §17).
        changes.reviewDriven = true;
        changes.note = `${reviewCount} scored reviews (${entry.tier1And2} T1/T2) — meets score-display threshold; opened but status never flipped`;
        if (!dryRun) show.status = 'open';
        // Backfill a missing openingDate from the review cluster (press night).
        // Only when the estimate is in the past — a future/today date would let
        // Check 2c revert open→previews next run (oscillation). When every review
        // is dateless we do NOT fabricate a date (previewsStartDate ≠ opening, and
        // openingDate is shown verbatim as "Opened {date}"); we leave it null —
        // an already-tolerated state for open shows — and log it for manual fill.
        if (!show.openingDate) {
          const backfill = chooseOpeningDateBackfill(show, entry.dates, isDateReached);
          if (backfill) {
            changes.openingDate = { from: 'null', to: backfill.date };
            if (!dryRun) {
              show.openingDate = backfill.date;
              show.openingDateSource = backfill.source;
            }
          } else {
            console.log(`  ℹ️  ${show.title} (${show.id}): flipped previews→open via review signal but no press-night date is derivable (reviews dateless) — openingDate left null; fill from ${openingDateSourceHint(show.category)}`);
          }
        }
      }
    }

    // Check 3: Flag shows that might need attention (but don't change them)
    if (show.status === 'open' && !show.closingDate) {
      // These are open-ended runs - no action needed
    }

    if (Object.keys(changes).length > 0) {
      updates.push({
        id: show.id,
        title: show.title,
        changes: changes,
      });
    }
  }

  // Report results
  if (updates.length === 0) {
    console.log('✅ All show statuses are up to date');
    console.log('');
    console.log('No changes needed.');
  } else {
    console.log(`Found ${updates.length} status update(s):`);
    console.log('-'.repeat(40));

    for (const update of updates) {
      console.log(`\n${update.title}:`);
      for (const [field, change] of Object.entries(update.changes)) {
        if (field === 'reviewDriven') continue; // internal marker, not a field change
        if (typeof change === 'string') {
          console.log(`  ${field}: ${change}`);
        } else {
          console.log(`  ${field}: ${change.from} → ${change.to}`);
        }
      }
    }
  }

  // Always stamp lastUpdated so health check knows the workflow ran
  if (!dryRun) {
    saveShows(data);
    if (updates.length > 0) {
      console.log('\n✅ shows.json updated successfully');
    }
  }

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const openShows = data.shows.filter(s => s.status === 'open');
  const closedShows = data.shows.filter(s => s.status === 'closed');
  const previewShows = data.shows.filter(s => s.status === 'previews');

  console.log(`Open: ${openShows.length}`);
  console.log(`Closed: ${closedShows.length}`);
  console.log(`Previews: ${previewShows.length}`);
  console.log(`Updates applied: ${updates.length}`);

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `updates_count=${updates.length}\n`);
    fs.appendFileSync(outputFile, `updated_shows=${updates.map(u => u.title).join(', ')}\n`);

    // Separate output for shows transitioning previews→open (for downstream triggers).
    // Exclude review-driven catch-up flips (Check 2d) — those shows opened days/weeks
    // ago, so triggering the opening-night poller/broadcast for them would be wrong.
    const openedShows = updates.filter(u =>
      u.changes.status?.from === 'previews' && u.changes.status?.to === 'open' && !u.changes.reviewDriven
    );
    fs.appendFileSync(outputFile, `opened_count=${openedShows.length}\n`);
    fs.appendFileSync(outputFile, `opened_slugs=${openedShows.map(u => u.id).join(',')}\n`);

    // TodayTix date refresh results
    const dateUpdates = updates.filter(u => u.changes.closingDate);
    fs.appendFileSync(outputFile, `date_updates_count=${dateUpdates.length}\n`);
  }

  return updates;
}

updateShowStatuses().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
