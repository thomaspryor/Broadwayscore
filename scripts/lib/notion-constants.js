/**
 * Shared Notion brain-DB constants. Single source of truth — required by both
 * scripts/notion-brain.js (SDK client) and scripts/lib/stuck-work.js (raw REST,
 * used where npm ci doesn't run). Keep dependency-free.
 */
module.exports = {
  BRAIN_DATABASE_ID: 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6',
  NOTION_VERSION: '2025-09-03',
};
