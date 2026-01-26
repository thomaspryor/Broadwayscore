#!/usr/bin/env node
/**
 * sync-lottery-rush-tags.js
 *
 * Syncs lottery/rush tags in shows.json based on lottery-rush.json data.
 * This ensures the browse pages show accurate information.
 *
 * Usage: node scripts/sync-lottery-rush-tags.js
 */

const fs = require('fs');
const path = require('path');

const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const LOTTERY_PATH = path.join(__dirname, '../data/lottery-rush.json');

function main() {
  // Load data
  const showsFile = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const lotteryData = JSON.parse(fs.readFileSync(LOTTERY_PATH, 'utf8'));

  const shows = showsFile.shows;

  // Track changes
  const changes = {
    lotteryAdded: [],
    lotteryRemoved: [],
    rushAdded: [],
    rushRemoved: [],
    notFound: []
  };

  // Build sets of shows with lottery/rush
  const showsWithLottery = new Set();
  const showsWithRush = new Set();

  for (const [showId, data] of Object.entries(lotteryData.shows)) {
    if (data.lottery) {
      showsWithLottery.add(showId);
    }
    if (data.rush || data.digitalRush || data.studentRush) {
      showsWithRush.add(showId);
    }
  }

  // Update shows
  for (const show of shows) {
    if (!show.tags) {
      show.tags = [];
    }

    const hasLotteryData = showsWithLottery.has(show.id);
    const hasRushData = showsWithRush.has(show.id);
    const hasLotteryTag = show.tags.includes('lottery');
    const hasRushTag = show.tags.includes('rush');

    // Add lottery tag if needed
    if (hasLotteryData && !hasLotteryTag) {
      show.tags.push('lottery');
      changes.lotteryAdded.push(show.id);
    }

    // Remove lottery tag if no longer has lottery
    if (!hasLotteryData && hasLotteryTag) {
      show.tags = show.tags.filter(t => t !== 'lottery');
      changes.lotteryRemoved.push(show.id);
    }

    // Add rush tag if needed
    if (hasRushData && !hasRushTag) {
      show.tags.push('rush');
      changes.rushAdded.push(show.id);
    }

    // Remove rush tag if no longer has rush
    if (!hasRushData && hasRushTag) {
      show.tags = show.tags.filter(t => t !== 'rush');
      changes.rushRemoved.push(show.id);
    }
  }

  // Check for shows in lottery data that aren't in shows.json
  for (const showId of [...showsWithLottery, ...showsWithRush]) {
    if (!shows.find(s => s.id === showId)) {
      changes.notFound.push(showId);
    }
  }

  // Write updated shows.json
  fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsFile, null, 2) + '\n');

  // Report changes
  console.log('Lottery/Rush Tag Sync Complete');
  console.log('==============================');

  if (changes.lotteryAdded.length) {
    console.log(`\nAdded lottery tag to ${changes.lotteryAdded.length} shows:`);
    changes.lotteryAdded.forEach(id => console.log(`  + ${id}`));
  }

  if (changes.lotteryRemoved.length) {
    console.log(`\nRemoved lottery tag from ${changes.lotteryRemoved.length} shows:`);
    changes.lotteryRemoved.forEach(id => console.log(`  - ${id}`));
  }

  if (changes.rushAdded.length) {
    console.log(`\nAdded rush tag to ${changes.rushAdded.length} shows:`);
    changes.rushAdded.forEach(id => console.log(`  + ${id}`));
  }

  if (changes.rushRemoved.length) {
    console.log(`\nRemoved rush tag from ${changes.rushRemoved.length} shows:`);
    changes.rushRemoved.forEach(id => console.log(`  - ${id}`));
  }

  if (changes.notFound.length) {
    console.log(`\nShows in lottery-rush.json but not in shows.json:`);
    [...new Set(changes.notFound)].forEach(id => console.log(`  ? ${id}`));
  }

  const totalChanges = changes.lotteryAdded.length + changes.lotteryRemoved.length +
                       changes.rushAdded.length + changes.rushRemoved.length;

  if (totalChanges === 0) {
    console.log('\nNo changes needed - tags are already in sync.');
  } else {
    console.log(`\nTotal: ${totalChanges} tag changes made.`);
  }
}

main();
