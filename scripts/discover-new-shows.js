#!/usr/bin/env node
/**
 * Broadway New Show Discovery
 *
 * Discovers new Broadway shows by checking Broadway.org listings
 * and adds them to shows.json with basic metadata.
 *
 * Uses Playwright to scrape JavaScript-rendered content.
 *
 * Usage: node scripts/discover-new-shows.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { fetchPage, cleanup } = require('./lib/scraper');
const { checkKnownShow, detectPlayFromTitle } = require('./lib/known-shows');
const { slugify, checkForDuplicate } = require('./lib/deduplication');
const { batchLookupIBDBDates } = require('./lib/ibdb-dates');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'new-shows-pending.json');

const dryRun = process.argv.includes('--dry-run');

// Broadway.org shows page
const BROADWAY_ORG_URL = 'https://www.broadway.org/shows/';

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data;
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function fetchShowsFromBroadwayOrg() {
  console.log(`Fetching Broadway.org shows page...`);

  // Use shared scraper with automatic fallback
  const result = await fetchPage(BROADWAY_ORG_URL);

  console.log(`Received ${result.format} content from ${result.source}`);
  console.log('Parsing show data...');

  // Parse HTML with JSDOM
  const dom = new JSDOM(result.content);
  const document = dom.window.document;

  const showsList = [];

  // Try finding h4 headings (show titles)
  const h4s = Array.from(document.querySelectorAll('h4'));
  console.log(`Found ${h4s.length} h4 headings`);

  if (h4s.length > 0) {
    h4s.forEach(h4 => {
      const title = h4.textContent.trim();
      if (!title || title.length < 3) return;

      // Find container
      let container = h4.closest('div');
      if (container && container.parentElement) {
        container = container.parentElement;
      }

      const text = container?.textContent || '';
      const venueLink = container?.querySelector('a[href*="/broadway-theatres/"]');
      const venue = venueLink?.textContent?.trim() || 'TBA';

      // Extract dates from text
      const beginsMatch = text.match(/Begins:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
      const throughMatch = text.match(/Through:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);

      if (!showsList.find(s => s.title === title)) {
        showsList.push({
          title,
          venue,
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          openingDate: beginsMatch ? beginsMatch[1] : null,
          closingDate: throughMatch ? throughMatch[1] : null
        });
      }
    });
  } else {
    // Fallback: try to find show links
    const showLinks = Array.from(document.querySelectorAll('a[href^="/shows/"]'));
    console.log(`Found ${showLinks.length} show links`);

    for (const link of showLinks) {
      const href = link.getAttribute('href');
      if (!href || href === '/shows/') continue;

      const slug = href.replace('/shows/', '');
      const h4 = link.querySelector('h4');
      if (!h4) continue;

      const title = h4.textContent.trim();
      if (!title || title.length < 3) continue;

      let container = link.closest('div');
      if (container && container.parentElement) {
        container = container.parentElement;
      }

      const venueLink = container?.querySelector('a[href*="/broadway-theatres/"]');
      const venue = venueLink?.textContent?.trim() || 'TBA';
      const text = container?.textContent || '';

      const beginsMatch = text.match(/Begins:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
      const throughMatch = text.match(/Through:\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);

      if (!showsList.find(s => s.title === title)) {
        showsList.push({
          title,
          venue,
          slug,
          openingDate: beginsMatch ? beginsMatch[1] : null,
          closingDate: throughMatch ? throughMatch[1] : null
        });
      }
    }
  }

  console.log(`Extracted ${showsList.length} shows from Broadway.org`);
  return showsList;
}

async function discoverShows() {
  console.log('='.repeat(60));
  console.log('BROADWAY SHOW DISCOVERY');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();

  console.log(`Existing shows in database: ${data.shows.length}`);
  console.log('');

  // Fetch shows from Broadway.org using Playwright
  let discoveredShows;
  try {
    discoveredShows = await fetchShowsFromBroadwayOrg();
    console.log(`Found ${discoveredShows.length} shows on Broadway.org`);
    console.log('');
  } catch (e) {
    console.error('Error fetching Broadway.org:', e.message);
    console.log('');
    return { newShows: [], count: 0 };
  }

  // Find new shows not in our database using improved duplicate detection
  const newShows = [];
  const skippedDuplicates = [];

  for (const show of discoveredShows) {
    // Use the new comprehensive duplicate check
    const duplicateCheck = checkForDuplicate(show, data.shows);

    if (duplicateCheck.isDuplicate) {
      skippedDuplicates.push({
        title: show.title,
        reason: duplicateCheck.reason,
        existingId: duplicateCheck.existingShow?.id
      });
      continue;
    }

    // Convert date strings to ISO format
    let openingDate = null;
    if (show.openingDate) {
      const parsed = new Date(show.openingDate);
      if (!isNaN(parsed.getTime())) {
        openingDate = parsed.toISOString().split('T')[0];
      }
    }

    let closingDate = null;
    if (show.closingDate) {
      const parsed = new Date(show.closingDate);
      if (!isNaN(parsed.getTime())) {
        closingDate = parsed.toISOString().split('T')[0];
      }
    }

    // Use opening year for ID if available, otherwise current year
    const idYear = openingDate ? openingDate.split('-')[0] : new Date().getFullYear();
    const slug = slugify(show.title);

    newShows.push({
      ...show,
      slug: slug,
      id: `${slug}-${idYear}`,
      openingDate,
      closingDate,
    });
  }

  // IBDB date enrichment: get accurate preview/opening/closing dates
  if (newShows.length > 0) {
    console.log('');
    console.log('🔎 Enriching dates from IBDB...');
    try {
      const lookupList = newShows.map(s => ({
        title: s.title,
        openingYear: s.openingDate ? parseInt(s.openingDate.split('-')[0]) : new Date().getFullYear(),
        venue: s.venue
      }));

      const ibdbResults = await batchLookupIBDBDates(lookupList);

      for (const show of newShows) {
        const ibdb = ibdbResults.get(show.title);
        if (!ibdb || !ibdb.found) {
          // IBDB lookup failed: treat Broadway.org "Begins:" as previewsStartDate
          // since it's often the preview start, not the true opening
          if (show.openingDate) {
            show.previewsStartDate = show.openingDate;
            show.openingDate = null;
            console.log(`  ℹ️  "${show.title}": No IBDB data, treating Begins date as previewsStartDate`);
          }
          continue;
        }

        // IBDB opening date is authoritative - overwrite Broadway.org "Begins:"
        if (ibdb.openingDate) {
          show.openingDate = ibdb.openingDate;
        }

        // Fill in preview start date
        if (ibdb.previewsStartDate) {
          show.previewsStartDate = ibdb.previewsStartDate;
        }

        // Fill in closing date if available
        if (ibdb.closingDate && !show.closingDate) {
          show.closingDate = ibdb.closingDate;
        }

        // Store IBDB URL for reference
        if (ibdb.ibdbUrl) {
          show.ibdbUrl = ibdb.ibdbUrl;
        }
      }
    } catch (e) {
      console.log(`⚠️  IBDB enrichment failed (continuing without): ${e.message}`);
    }
    console.log('');
  }

  // Log skipped duplicates for debugging
  if (skippedDuplicates.length > 0) {
    console.log(`⏭️  Skipped ${skippedDuplicates.length} duplicate(s):`);
    for (const skip of skippedDuplicates) {
      console.log(`   - "${skip.title}" (${skip.reason}) → existing: ${skip.existingId}`);
    }
    console.log('');
  }

  if (newShows.length === 0) {
    console.log('✅ No new shows discovered - database is up to date');
    return { newShows: [], count: 0 };
  }

  console.log(`🎭 Found ${newShows.length} NEW show(s):`);
  console.log('-'.repeat(40));

  // Analyze shows for revival detection
  const revivalDetection = newShows.map(show => {
    const knownCheck = checkKnownShow(show.title);
    const isPlay = detectPlayFromTitle(show.title);

    let detectedType = 'musical'; // default
    let isRevival = false;
    let confidence = 'low';

    if (knownCheck.isKnown) {
      // Known classic - likely a revival
      detectedType = knownCheck.type === 'play' ? 'revival' : 'revival';
      isRevival = true;
      confidence = 'high';
    } else if (isPlay) {
      detectedType = 'play';
      confidence = 'medium';
    }

    return { show, detectedType, isRevival, confidence };
  });

  for (const { show, detectedType, isRevival, confidence } of revivalDetection) {
    const typeLabel = isRevival ? '🔄 REVIVAL' : detectedType === 'play' ? '🎭 PLAY' : '🎵 MUSICAL';
    const confidenceLabel = confidence === 'high' ? '✓' : confidence === 'medium' ? '~' : '?';
    console.log(`  ${confidenceLabel} ${show.title} → ${typeLabel} (${show.venue})`);
  }
  console.log('');

  if (!dryRun) {
    // Add new shows to database
    for (let i = 0; i < newShows.length; i++) {
      const show = newShows[i];
      const detection = revivalDetection[i];

      // Determine status based on opening date
      let openingDate;
      let status;

      if (show.openingDate) {
        // Show has an opening date (from IBDB or Broadway.org)
        openingDate = show.openingDate;
        const openingDateObj = new Date(openingDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // If opening date is in the future, mark as previews
        status = openingDateObj > today ? 'previews' : 'open';
      } else if (show.previewsStartDate) {
        // No opening date but have preview date - show is in previews
        openingDate = null;
        status = 'previews';
      } else {
        // No opening date found - show is already running
        // Use placeholder date (will need manual update)
        openingDate = new Date().toISOString().split('T')[0];
        status = 'open';
      }

      // Build tags based on detection
      const tags = status === 'previews' ? ['upcoming'] : [];
      if (detection.isRevival) {
        tags.push('revival');
      } else if (detection.confidence === 'low') {
        tags.push('new'); // Flag for manual verification
      }

      data.shows.push({
        id: show.id,
        title: show.title,
        slug: show.slug,
        venue: show.venue,
        openingDate: openingDate || null,
        closingDate: show.closingDate || null,
        status: status,
        type: detection.detectedType, // Auto-detected with revival logic
        runtime: null,
        intermissions: null,
        images: {},
        synopsis: '',
        ageRecommendation: null,
        previewsStartDate: show.previewsStartDate || null,
        tags: tags,
        ticketLinks: [],
        cast: [],
        creativeTeam: [],
      });
    }

    saveShows(data);
    console.log(`✅ Added ${newShows.length} shows to shows.json`);

    // Show detection summary
    const revivalsDetected = revivalDetection.filter(d => d.isRevival).length;
    const playsDetected = revivalDetection.filter(d => d.detectedType === 'play' && !d.isRevival).length;
    const needsReview = revivalDetection.filter(d => d.confidence === 'low').length;

    console.log('');
    console.log('📊 Detection Summary:');
    if (revivalsDetected > 0) console.log(`   🔄 ${revivalsDetected} revival(s) auto-detected`);
    if (playsDetected > 0) console.log(`   🎭 ${playsDetected} play(s) auto-detected`);
    if (needsReview > 0) console.log(`   ⚠️  ${needsReview} show(s) need manual type verification`);
    console.log('');

    // Save pending shows for review
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      discoveredAt: new Date().toISOString(),
      shows: newShows,
    }, null, 2));
    console.log(`📋 Saved pending shows to ${OUTPUT_FILE}`);
  }

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `new_shows_count=${newShows.length}\n`);
    fs.appendFileSync(outputFile, `new_shows=${newShows.map(s => s.title).join(', ')}\n`);
    fs.appendFileSync(outputFile, `new_slugs=${newShows.map(s => s.slug).join(',')}\n`);
  }

  return { newShows, count: newShows.length };
}

discoverShows()
  .catch(e => {
    console.error('Discovery failed:', e);
    process.exit(1);
  })
  .finally(() => {
    // Clean up scraper resources
    cleanup().catch(console.error);
  });
