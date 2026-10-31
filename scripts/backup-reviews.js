#!/usr/bin/env node

/**
 * Backup script for reviews.json
 * Creates timestamped backups in data/backups/ directory
 *
 * Usage: node scripts/backup-reviews.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');

function formatTimestamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

function backupReviews() {
  // Check if reviews.json exists
  if (!fs.existsSync(REVIEWS_FILE)) {
    console.error('Error: reviews.json not found at', REVIEWS_FILE);
    process.exit(1);
  }

  // Create backups directory if it doesn't exist
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    console.log('Created backups directory:', BACKUPS_DIR);
  }

  // Generate timestamped filename
  const timestamp = formatTimestamp(new Date());
  const backupFilename = `reviews-${timestamp}.json`;
  const backupPath = path.join(BACKUPS_DIR, backupFilename);

  // Copy the file
  fs.copyFileSync(REVIEWS_FILE, backupPath);

  console.log('Backup created:', backupPath);
  return backupPath;
}

// Run if called directly
if (require.main === module) {
  const backupPath = backupReviews();
  process.exit(0);
}

module.exports = { backupReviews };
