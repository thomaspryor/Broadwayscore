#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf-8')).shows;
const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf-8')).reviews;
const consensus = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/critic-consensus.json'), 'utf-8')).shows;

// Helper to calculate score
const reviewsByShow = {};
reviews.forEach(r => {
  if (!reviewsByShow[r.showId]) reviewsByShow[r.showId] = [];
  reviewsByShow[r.showId].push(r);
});

const showsToCheck = [
  'maybe-happy-ending-2024',
  'oh-mary-2024',
  'the-great-gatsby-2024',
  'hadestown-2019',
  'the-outsiders-2024',
  'wicked-2003',
  'hamilton-2015',
  'stereophonic-2024',
  'ragtime-2025',
  'boop-2025'
];

console.log('\\n🎭 CRITICS\' TAKE VALIDATION\\n');
console.log('Checking if summaries align with scores and review sentiment...\\n');

showsToCheck.forEach(showId => {
  const show = shows.find(s => s.id === showId);
  const cons = consensus[showId];
  const showReviews = reviewsByShow[showId] || [];

  if (!show || !cons) return;

  const avgScore = showReviews.length > 0
    ? Math.round(showReviews.reduce((sum, r) => sum + r.assignedScore, 0) / showReviews.length)
    : 0;

  let sentiment = 'Mixed';
  if (avgScore >= 85) sentiment = 'Must-See';
  else if (avgScore >= 75) sentiment = 'Great';
  else if (avgScore >= 65) sentiment = 'Good';
  else if (avgScore >= 55) sentiment = 'Tepid';
  else if (avgScore < 55) sentiment = 'Skip';

  console.log('========================================');
  console.log(`${show.title}`);
  console.log(`Score: ${avgScore}/100 (${sentiment}) - ${showReviews.length} reviews`);
  console.log('');
  console.log(`Critics' Take:`);
  console.log(cons.text);
  console.log('');
});

console.log('========================================');
