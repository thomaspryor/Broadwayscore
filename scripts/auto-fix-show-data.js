#!/usr/bin/env node
/**
 * auto-fix-show-data.js
 *
 * Automatically fixes show data issues where possible:
 * - Missing images → triggers image fetch
 * - Missing/broken ticket links → fetches from TodayTix
 * - Missing metadata → creates GitHub issue (only if truly needed)
 *
 * Philosophy: Fix everything that can be automated, only flag what needs humans.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

// Results tracking
const results = {
  timestamp: new Date().toISOString(),
  fixed: [],
  needsHumanAttention: [],
  triggeredWorkflows: [],
  errors: []
};

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

// Check if a URL is valid (returns HTTP 200)
async function checkUrl(url, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const protocol = urlObj.protocol === 'https:' ? https : require('http');

      const req = protocol.get(url, { timeout }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// Generate TodayTix URL from show title
function generateTodayTixUrl(show) {
  // TodayTix URL pattern: https://www.todaytix.com/nyc/shows/{id}-{slug}
  // We can't know the ID, but we can try a search URL
  const slug = show.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `https://www.todaytix.com/nyc/shows?q=${encodeURIComponent(show.title)}`;
}

// Generate Telecharge URL from show title
function generateTelechargeUrl(show) {
  const slug = show.title
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, '-');

  return `https://www.telecharge.com/Broadway/${slug}`;
}

async function fixTicketLinks(show) {
  const fixes = [];

  // Skip closed shows
  if (show.status === 'closed') {
    return fixes;
  }

  // Check if ticket links are missing or empty
  if (!show.ticketLinks || show.ticketLinks.length === 0) {
    // Add placeholder ticket links that can be searched
    show.ticketLinks = [
      {
        platform: 'TodayTix',
        url: generateTodayTixUrl(show),
        priceFrom: null,
        needsUpdate: true
      }
    ];
    fixes.push(`Added TodayTix search link for ${show.title}`);
  } else {
    // Verify existing links work (sample check, don't hammer servers)
    for (const link of show.ticketLinks) {
      if (link.needsUpdate) {
        continue; // Already flagged
      }

      // Only check TodayTix links (they're most reliable)
      if (link.platform === 'TodayTix' && link.url) {
        const isValid = await checkUrl(link.url);
        if (!isValid) {
          link.needsUpdate = true;
          fixes.push(`Flagged broken TodayTix link for ${show.title}`);
        }
      }
    }
  }

  return fixes;
}

function checkMissingImages(show) {
  const missing = [];

  if (!show.images?.poster) missing.push('poster');
  if (!show.images?.hero) missing.push('hero');
  if (!show.images?.thumbnail) missing.push('thumbnail');

  return missing;
}

function checkMissingMetadata(show) {
  const issues = [];

  // Only check open shows
  if (show.status !== 'open' && show.status !== 'previews') {
    return issues;
  }

  // Synopsis - can't be auto-generated
  if (!show.synopsis || show.synopsis.length < 50) {
    issues.push({
      type: 'missing_synopsis',
      message: `${show.title} needs a synopsis`,
      severity: 'medium'
    });
  }

  // Cast - can't be auto-fetched reliably
  if (!show.cast || show.cast.length === 0) {
    issues.push({
      type: 'missing_cast',
      message: `${show.title} needs cast information`,
      severity: 'low'
    });
  }

  // Creative team
  if (!show.creativeTeam || show.creativeTeam.length === 0) {
    issues.push({
      type: 'missing_creative',
      message: `${show.title} needs creative team information`,
      severity: 'low'
    });
  }

  return issues;
}

async function main() {
  console.log('='.repeat(60));
  console.log('AUTO-FIX SHOW DATA');
  console.log('='.repeat(60));
  console.log(`Started: ${new Date().toISOString()}\n`);

  const data = loadShows();
  const openShows = data.shows.filter(s => s.status === 'open' || s.status === 'previews');

  console.log(`Checking ${openShows.length} open/preview shows...\n`);

  let showsWithMissingImages = [];
  let totalTicketFixes = 0;

  for (const show of openShows) {
    console.log(`Checking: ${show.title}`);

    // 1. Check and fix ticket links
    const ticketFixes = await fixTicketLinks(show);
    if (ticketFixes.length > 0) {
      totalTicketFixes += ticketFixes.length;
      results.fixed.push(...ticketFixes);
      ticketFixes.forEach(f => console.log(`  ✓ ${f}`));
    }

    // 2. Check for missing images (will trigger workflow)
    const missingImages = checkMissingImages(show);
    if (missingImages.length > 0) {
      showsWithMissingImages.push({
        id: show.id,
        title: show.title,
        missing: missingImages
      });
      console.log(`  ⚠ Missing images: ${missingImages.join(', ')}`);
    }

    // 3. Check for metadata that needs human attention
    const metadataIssues = checkMissingMetadata(show);
    if (metadataIssues.length > 0) {
      results.needsHumanAttention.push({
        showId: show.id,
        showTitle: show.title,
        issues: metadataIssues
      });
      metadataIssues.forEach(i => console.log(`  📋 ${i.message}`));
    }
  }

  // Save updated shows data
  if (totalTicketFixes > 0) {
    saveShows(data);
    console.log(`\n✅ Saved ${totalTicketFixes} ticket link fixes`);
  }

  // Output for GitHub Actions
  if (showsWithMissingImages.length > 0) {
    results.triggeredWorkflows.push('fetch-all-image-formats');
    console.log(`\n🖼️  ${showsWithMissingImages.length} shows need images - will trigger fetch workflow`);

    // Write shows needing images for the workflow to pick up
    fs.writeFileSync(
      path.join(__dirname, '..', 'data', 'shows-needing-images.json'),
      JSON.stringify(showsWithMissingImages, null, 2)
    );
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Auto-fixed: ${results.fixed.length} issues`);
  console.log(`Needs human attention: ${results.needsHumanAttention.length} shows`);
  console.log(`Workflows to trigger: ${results.triggeredWorkflows.join(', ') || 'none'}`);

  // Write results for workflow
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'auto-fix-results.json'),
    JSON.stringify(results, null, 2)
  );

  // GitHub Actions outputs
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `fixed_count=${results.fixed.length}\n`);
    fs.appendFileSync(outputFile, `needs_images=${showsWithMissingImages.length > 0}\n`);
    fs.appendFileSync(outputFile, `needs_human=${results.needsHumanAttention.length}\n`);
    fs.appendFileSync(outputFile, `shows_needing_attention=${results.needsHumanAttention.map(s => s.showTitle).join(',')}\n`);
  }

  return results;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
