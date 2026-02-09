#!/usr/bin/env node
/**
 * sync-followers.js
 *
 * Fetches Formspree submissions for the Follow Show form and builds/updates
 * data/followers.json with deduplicated follower lists per show.
 *
 * Usage: node scripts/sync-followers.js [--dry-run]
 *
 * Env: FORMSPREE_TOKEN, FORMSPREE_FOLLOW_FORM_ID
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const FOLLOWERS_PATH = path.join(__dirname, '..', 'data', 'followers.json');
const DRY_RUN = process.argv.includes('--dry-run');

function loadFollowers() {
  try {
    return JSON.parse(fs.readFileSync(FOLLOWERS_PATH, 'utf8'));
  } catch {
    return { _meta: { lastSynced: null, totalFollowers: 0 }, followers: {} };
  }
}

function saveFollowers(data) {
  // Count total unique emails
  const allEmails = new Set();
  for (const emails of Object.values(data.followers)) {
    for (const e of emails) allEmails.add(e);
  }
  data._meta.totalFollowers = allEmails.size;
  data._meta.lastSynced = new Date().toISOString();

  fs.writeFileSync(FOLLOWERS_PATH, JSON.stringify(data, null, 2));
  console.log(`Saved ${allEmails.size} unique followers across ${Object.keys(data.followers).length} shows`);
}

function fetchJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { ...headers, 'Accept': 'application/json' },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function main() {
  const token = process.env.FORMSPREE_FOLLOW_API_KEY || process.env.FORMSPREE_TOKEN;
  const formId = process.env.FORMSPREE_FOLLOW_FORM_ID;

  if (!token || !formId) {
    console.log('Missing FORMSPREE_FOLLOW_API_KEY/FORMSPREE_TOKEN or FORMSPREE_FOLLOW_FORM_ID — skipping sync');
    process.exit(0);
  }

  console.log(`Syncing followers from Formspree form ${formId}...`);
  if (DRY_RUN) console.log('(DRY RUN — no files will be written)\n');

  const data = loadFollowers();
  const existingCount = Object.values(data.followers).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Existing: ${existingCount} follow entries across ${Object.keys(data.followers).length} shows`);

  // Fetch all submissions (paginated)
  let allSubmissions = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    let url = `https://formspree.io/api/0/forms/${formId}/submissions?limit=${limit}&offset=${offset}`;
    // Only fetch new submissions if we have a lastSynced date
    if (data._meta.lastSynced) {
      url += `&since=${encodeURIComponent(data._meta.lastSynced)}`;
    }

    try {
      const result = await fetchJSON(url, {
        'Authorization': `Bearer ${token}`,
      });

      const submissions = result.submissions || result;
      if (!Array.isArray(submissions) || submissions.length === 0) break;

      allSubmissions = allSubmissions.concat(submissions);
      console.log(`  Fetched ${submissions.length} submissions (offset ${offset})`);

      if (submissions.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error(`  Error fetching submissions: ${err.message}`);
      if (offset === 0) {
        console.log('No submissions could be fetched. If this is the first run, this is normal.');
        process.exit(0);
      }
      break;
    }
  }

  console.log(`\nTotal new submissions: ${allSubmissions.length}`);

  // Process submissions
  let added = 0;
  let removed = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  for (const sub of allSubmissions) {
    const email = (sub.email || sub._replyto || '').toLowerCase().trim();
    const showId = sub.showId;
    const action = (sub.action || 'follow').toLowerCase();

    if (!showId || !isValidEmail(email)) {
      skippedInvalid++;
      continue;
    }

    // Handle unfollow
    if (action === 'unfollow') {
      if (data.followers[showId]) {
        const idx = data.followers[showId].indexOf(email);
        if (idx !== -1) {
          data.followers[showId].splice(idx, 1);
          removed++;
          console.log(`  - ${showId}: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} (unfollowed)`);
          if (data.followers[showId].length === 0) {
            delete data.followers[showId];
          }
        }
      }
      continue;
    }

    // Handle follow
    if (!data.followers[showId]) {
      data.followers[showId] = [];
    }

    if (data.followers[showId].includes(email)) {
      skippedDuplicate++;
      continue;
    }

    data.followers[showId].push(email);
    added++;
    console.log(`  + ${showId}: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
  }

  console.log(`\nResults: ${added} added, ${removed} removed, ${skippedDuplicate} duplicates skipped, ${skippedInvalid} invalid skipped`);

  if (!DRY_RUN && (added > 0 || removed > 0)) {
    saveFollowers(data);
  } else if (DRY_RUN) {
    console.log('(Dry run — no changes saved)');
  } else {
    console.log('No changes to save');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
