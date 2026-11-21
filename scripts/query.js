#!/usr/bin/env node
/**
 * query.js — Ad-hoc SQL queries against the Broadway SQLite database.
 *
 * Usage:
 *   node scripts/query.js "SELECT * FROM shows WHERE status = 'open'"
 *   node scripts/query.js "SELECT critic_name, COUNT(*) c FROM reviews GROUP BY critic_name ORDER BY c DESC LIMIT 10"
 *
 * Returns JSON to stdout. Row count to stderr.
 * Build the database first: npm run db:build
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const { execSync } = require('child_process');

const DB_PATH = path.join(__dirname, '..', 'data', 'broadway.db');
const DATA_DIR = path.join(__dirname, '..', 'data');

const sql = process.argv.slice(2).join(' ').trim();

if (!sql) {
  console.error('Usage: node scripts/query.js "SQL QUERY"');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/query.js "SELECT COUNT(*) FROM shows"');
  console.error('  node scripts/query.js "SELECT * FROM content_quality_summary ORDER BY total DESC"');
  console.error('  node scripts/query.js "SELECT * FROM duplicate_urls"');
  process.exit(1);
}

// Auto-rebuild if DB is missing or stale (older than source JSON files)
function needsRebuild() {
  if (!fs.existsSync(DB_PATH)) return true;
  const dbMtime = fs.statSync(DB_PATH).mtimeMs;
  const sources = ['shows.json', 'reviews.json', 'commercial.json', 'grosses.json', 'audience-buzz.json', 'critic-registry.json'];
  for (const src of sources) {
    const srcPath = path.join(DATA_DIR, src);
    if (fs.existsSync(srcPath) && fs.statSync(srcPath).mtimeMs > dbMtime) return true;
  }
  return false;
}

if (needsRebuild()) {
  console.error('Database is stale or missing — rebuilding...');
  try {
    execSync('node scripts/build-sqlite.js', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
    console.error('Rebuild complete.\n');
  } catch (err) {
    console.error('Error: Auto-rebuild failed. Run manually: npm run db:build');
    process.exit(1);
  }
}

let db;
try {
  db = new Database(DB_PATH, { readonly: true });

  // Integrity check on first open
  const integrity = db.pragma('integrity_check');
  if (integrity[0].integrity_check !== 'ok') {
    console.error('Error: Database is corrupt. Delete data/broadway.db and run: npm run db:build');
    process.exit(1);
  }

  const stmt = db.prepare(sql);

  // Detect if this is a read query or not
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA')) {
    const rows = stmt.all();
    console.log(JSON.stringify(rows, null, 2));
    console.error(`\n${rows.length} row(s)`);
  } else {
    console.error('Error: Only SELECT/WITH/PRAGMA queries are allowed (read-only database).');
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
} finally {
  if (db) db.close();
}
