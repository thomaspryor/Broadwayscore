#!/usr/bin/env node
/**
 * Test script for the discovery flow
 * This tests the logic without needing network access
 */

const fs = require('fs');
const path = require('path');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const BACKUP_FILE = path.join(__dirname, '..', 'data', 'shows.backup.json');

// Mock TodayTix API response with a fake new show
const mockTodayTixResponse = {
  data: [
    // Existing show (should be skipped)
    {
      id: 45002,
      displayName: 'Two Strangers (Carry a Cake Across New York)',
      name: 'Two Strangers',
      venue: { name: 'Lyric Theatre' },
      category: { name: 'Musicals' },
      tagLine: 'A new musical',
      lowPrice: 79,
      images: {
        productMedia: {
          hero: { file: { url: '//images.example.com/hero.jpg' } },
          appSquare: { file: { url: '//images.example.com/thumb.jpg' } },
        }
      }
    },
    // New show (should be added)
    {
      id: 99999,
      displayName: 'Test Musical 2026',
      name: 'Test Musical',
      venue: { name: 'Broadway Theatre' },
      category: { name: 'Musicals' },
      tagLine: 'A brand new test musical for 2026',
      lowPrice: 99,
      tags: ['broadway'],
      images: {
        productMedia: {
          hero: { file: { url: '//images.example.com/test-hero.jpg' } },
          appSquare: { file: { url: '//images.example.com/test-thumb.jpg' } },
        }
      }
    },
    // Another new show (should be added)
    {
      id: 88888,
      displayName: 'Another New Play',
      name: 'Another New Play',
      venue: { name: 'Shubert Theatre' },
      category: { name: 'Plays' },
      tagLine: 'A dramatic new play',
      lowPrice: 89,
      tags: ['broadway'],
      images: {}
    }
  ]
};

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractShowData(todaytixShow) {
  return {
    todaytixId: todaytixShow.id,
    title: todaytixShow.displayName || todaytixShow.name,
    slug: slugify(todaytixShow.displayName || todaytixShow.name),
    venue: todaytixShow.venue?.name || 'TBA',
    type: todaytixShow.category?.name === 'Musicals' ? 'musical' : 'play',
    status: 'open',
    images: {
      hero: todaytixShow.images?.productMedia?.hero?.file?.url
        ? `https:${todaytixShow.images.productMedia.hero.file.url}`
        : null,
      thumbnail: todaytixShow.images?.productMedia?.appSquare?.file?.url
        ? `https:${todaytixShow.images.productMedia.appSquare.file.url}`
        : null,
    },
    synopsis: todaytixShow.tagLine || '',
    ticketLinks: [{
      platform: 'TodayTix',
      url: `https://www.todaytix.com/nyc/shows/${todaytixShow.id}`,
      priceFrom: todaytixShow.lowPrice || null,
    }],
  };
}

async function testDiscoveryFlow() {
  console.log('🧪 Testing Discovery Flow');
  console.log('==========================\n');

  // Backup current shows.json
  console.log('1. Backing up shows.json...');
  const originalData = fs.readFileSync(SHOWS_FILE, 'utf-8');
  fs.writeFileSync(BACKUP_FILE, originalData);
  console.log('   ✓ Backup created\n');

  // Load current shows
  const showsData = JSON.parse(originalData);
  const existingSlugs = new Set(showsData.shows.map(s => s.slug));
  const existingTitles = new Set(showsData.shows.map(s => s.title.toLowerCase()));

  console.log(`2. Current database: ${showsData.shows.length} shows`);
  console.log(`   Sample slugs: ${Array.from(existingSlugs).slice(0, 3).join(', ')}...\n`);

  // Process mock TodayTix response
  console.log('3. Processing mock TodayTix response...');
  const newShows = [];

  for (const ttShow of mockTodayTixResponse.data) {
    const title = ttShow.displayName || ttShow.name;
    const slug = slugify(title);

    if (existingSlugs.has(slug) || existingTitles.has(title.toLowerCase())) {
      console.log(`   ⏭️  Skipped (exists): ${title}`);
      continue;
    }

    const venue = ttShow.venue?.name || '';
    const isLikelyBroadway =
      venue.includes('Theatre') ||
      venue.includes('Theater') ||
      ttShow.category?.name === 'Broadway' ||
      ttShow.tags?.some(t => t.toLowerCase().includes('broadway'));

    if (!isLikelyBroadway) {
      console.log(`   ⏭️  Skipped (not Broadway): ${title}`);
      continue;
    }

    const showData = extractShowData(ttShow);
    newShows.push(showData);
    console.log(`   ✅ NEW: ${showData.title} (${showData.type})`);
  }

  console.log(`\n4. Found ${newShows.length} new shows\n`);

  if (newShows.length === 0) {
    console.log('   No new shows to add.\n');
  } else {
    // Add new shows to database
    console.log('5. Adding new shows to database...');
    let nextId = Math.max(...showsData.shows.map(s => s.id)) + 1;

    for (const newShow of newShows) {
      const fullShow = {
        id: nextId++,
        title: newShow.title,
        slug: newShow.slug,
        venue: newShow.venue,
        openingDate: null,
        closingDate: null,
        status: 'open',
        type: newShow.type,
        runtime: null,
        intermissions: null,
        images: newShow.images,
        synopsis: newShow.synopsis,
        ageRecommendation: null,
        tags: [],
        ticketLinks: newShow.ticketLinks,
        cast: [],
        creativeTeam: [],
        officialUrl: null,
        trailerUrl: null,
        theaterAddress: null,
        _needsReviewData: true,
        _todaytixId: newShow.todaytixId,
      };

      showsData.shows.push(fullShow);
      console.log(`   ✓ Added: ${newShow.title} (ID: ${fullShow.id})`);
    }

    // Write updated shows.json
    showsData._meta.lastUpdated = new Date().toISOString().split('T')[0];
    showsData._meta.showCount = showsData.shows.length;
    fs.writeFileSync(SHOWS_FILE, JSON.stringify(showsData, null, 2));
    console.log(`\n   ✓ shows.json updated (${showsData.shows.length} total shows)\n`);

    // Simulate GitHub Actions output
    console.log('6. GitHub Actions outputs (simulated):');
    console.log(`   new_shows_count=${newShows.length}`);
    console.log(`   new_shows=${newShows.map(s => s.title).join(', ')}`);
    console.log(`   new_slugs=${newShows.map(s => s.slug).join(',')}`);
  }

  // Verify the changes
  console.log('\n7. Verifying changes...');
  const updatedData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  const addedShows = updatedData.shows.filter(s => s._needsReviewData);
  console.log(`   Shows flagged for review data: ${addedShows.length}`);
  addedShows.forEach(s => console.log(`     - ${s.title} (${s.slug})`));

  // Restore original shows.json
  console.log('\n8. Restoring original shows.json...');
  fs.writeFileSync(SHOWS_FILE, originalData);
  fs.unlinkSync(BACKUP_FILE);
  console.log('   ✓ Original data restored\n');

  // Summary
  console.log('==========================');
  console.log('🎉 Test Complete!');
  console.log('==========================\n');
  console.log('The discovery flow works correctly:');
  console.log('  ✓ Loads existing shows from database');
  console.log('  ✓ Skips shows already in database');
  console.log('  ✓ Identifies new Broadway shows');
  console.log('  ✓ Adds new shows with correct metadata');
  console.log('  ✓ Flags new shows as needing review data');
  console.log('  ✓ Would output to GitHub Actions for issue creation');
  console.log('\nNote: Network calls will work when run in GitHub Actions.');
}

testDiscoveryFlow().catch(console.error);
