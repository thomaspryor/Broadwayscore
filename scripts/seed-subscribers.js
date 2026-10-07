#!/usr/bin/env node
/**
 * seed-subscribers.js
 *
 * One-time utility: reads a Loops CSV export and POSTs each email to Formspree
 * with `action: 'subscribe'`. This seeds the Formspree subscriber list for
 * opening-night broadcast emails.
 *
 * IMPORTANT: Each POST consumes 1 Formspree submission. Free tier = 50/month.
 * If the CSV has >40 emails, upgrade Formspree first.
 *
 * Usage: node scripts/seed-subscribers.js path/to/loops-export.csv [--dry-run]
 *
 * Env: NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID (or FORMSPREE_SUBSCRIBER_FORM_ID)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run');
const csvPath = process.argv.find(a => a.endsWith('.csv'));

if (!csvPath) {
  console.log('Usage: node scripts/seed-subscribers.js path/to/loops-export.csv [--dry-run]');
  console.log('');
  console.log('Reads a Loops CSV export and POSTs each email to Formspree as a subscriber.');
  console.log('Each POST = 1 Formspree submission (free tier: 50/month).');
  process.exit(0);
}

if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

const FORMSPREE_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || process.env.FORMSPREE_SUBSCRIBER_FORM_ID;

if (!FORMSPREE_FORM_ID) {
  console.error('Missing NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID or FORMSPREE_SUBSCRIBER_FORM_ID');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function postFormspree(email) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      email: email.toLowerCase().trim(),
      action: 'subscribe',
      source: 'loops-seed',
    });

    const options = {
      hostname: 'formspree.io',
      path: `/f/${FORMSPREE_FORM_ID}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.statusCode);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const lines = csvContent.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    console.log('CSV is empty');
    process.exit(0);
  }

  // Find email column (header row)
  const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
  const emailIdx = header.findIndex(h => h === 'email' || h === 'email address');

  if (emailIdx === -1) {
    console.error('Could not find "email" column in CSV header:', header.join(', '));
    process.exit(1);
  }

  // Extract emails
  const emails = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    const email = (cols[emailIdx] || '').toLowerCase().trim();
    if (isValidEmail(email)) {
      emails.push(email);
    }
  }

  // Dedup
  const unique = [...new Set(emails)];
  console.log(`Found ${unique.length} unique emails in ${csvPath}`);

  if (unique.length > 40) {
    console.warn(`\nWARNING: ${unique.length} emails will consume ${unique.length} Formspree submissions.`);
    console.warn('Formspree free tier = 50/month. You may need to upgrade first.');
    console.warn('Continuing in 5 seconds... (Ctrl+C to abort)\n');
    if (!DRY_RUN) await sleep(5000);
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would POST ${unique.length} subscribe entries to Formspree`);
    for (const email of unique.slice(0, 5)) {
      console.log(`  Would seed: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
    }
    if (unique.length > 5) console.log(`  ... and ${unique.length - 5} more`);
    process.exit(0);
  }

  let success = 0;
  let errors = 0;

  for (const email of unique) {
    try {
      await postFormspree(email);
      success++;
      console.log(`  [${success}/${unique.length}] Seeded: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
    } catch (err) {
      errors++;
      console.error(`  ERROR seeding ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}: ${err.message}`);
      if (errors >= 5) {
        console.error('Too many errors — aborting');
        break;
      }
    }

    // Rate limit: 500ms between POSTs
    await sleep(500);
  }

  console.log(`\nDone: ${success} seeded, ${errors} errors`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
