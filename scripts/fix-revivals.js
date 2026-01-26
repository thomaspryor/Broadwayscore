#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const showsPath = path.join(__dirname, '../data/shows.json');
const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));

// Define revivals that need fixing
const revivalFixes = {
  'ragtime-2025': {
    name: 'Ragtime',
    currentType: 'musical',
    needsRevivalType: true,
    needsRevivalTag: false, // already has it
  },
  'death-of-a-salesman-2026': {
    name: 'Death of a Salesman',
    currentType: 'play',
    needsRevivalType: true,
    needsRevivalTag: false, // already has it
  },
  'mamma-mia-2025': {
    name: 'Mamma Mia!',
    currentType: 'musical',
    needsRevivalType: true,
    needsRevivalTag: true,
  },
  'chess-2025': {
    name: 'Chess',
    currentType: 'musical',
    needsRevivalType: true,
    needsRevivalTag: true,
    removeTag: 'new', // Remove "new" tag
  },
};

let fixedCount = 0;

data.shows.forEach(show => {
  const fix = revivalFixes[show.id];
  if (!fix) return;

  console.log(`\nFixing: ${show.title} (${show.id})`);

  if (fix.needsRevivalType) {
    console.log(`  - Changing type from "${show.type}" to "revival"`);
    show.type = 'revival';
    fixedCount++;
  }

  if (fix.needsRevivalTag && !show.tags?.includes('revival')) {
    show.tags = show.tags || [];
    show.tags.push('revival');
    console.log(`  - Added "revival" to tags`);
  }

  if (fix.removeTag && show.tags?.includes(fix.removeTag)) {
    show.tags = show.tags.filter(t => t !== fix.removeTag);
    console.log(`  - Removed "${fix.removeTag}" from tags`);
  }
});

if (fixedCount > 0) {
  fs.writeFileSync(showsPath, JSON.stringify(data, null, 2) + '\n');
  console.log(`\n✅ Fixed ${fixedCount} shows with incorrect revival tagging`);
} else {
  console.log('\n✅ No fixes needed - all revivals are correctly tagged');
}
