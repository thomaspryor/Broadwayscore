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
const SUBSCRIBERS_PATH = path.join(__dirname, '..', 'data', 'subscribers.json');
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

    let result;
    try {
      result = await fetchJSON(url, {
        'Authorization': `Bearer ${token}`,
      });
    } catch (err) {
      console.error(`  Error fetching submissions: ${err.message}`);
      if (offset === 0) {
        console.log('No submissions could be fetched. If this is the first run, this is normal.');
        process.exit(0);
      }
      // Partial fetch failure: abort and retain previous data (Pre-Mortem P0 guard)
      console.error('  Aborting pagination — retaining previous data to prevent partial overwrites');
      break;
    }

    const submissions = result.submissions || result;
    if (!Array.isArray(submissions) || submissions.length === 0) break;

    allSubmissions = allSubmissions.concat(submissions);
    console.log(`  Fetched ${submissions.length} submissions (offset ${offset})`);

    if (submissions.length < limit) break;
    offset += limit;
  }

  console.log(`\nTotal new submissions: ${allSubmissions.length}`);

  // Process submissions — handle general subscribers AND per-show follows
  let added = 0;
  let removed = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;
  let subscribersAdded = 0;
  let subscribersRemoved = 0;

  // Load existing subscribers (if any)
  const generalSubscribers = new Set();
  try {
    const existing = JSON.parse(fs.readFileSync(SUBSCRIBERS_PATH, 'utf8'));
    if (existing.subscribers) {
      for (const e of existing.subscribers) generalSubscribers.add(e);
    }
  } catch { /* no existing file — start fresh */ }

  for (const sub of allSubmissions) {
    const email = (sub.email || sub._replyto || '').toLowerCase().trim();
    const showId = sub.showId;
    const action = (sub.action || 'follow').toLowerCase();

    if (!isValidEmail(email)) {
      skippedInvalid++;
      continue;
    }

    // Handle general subscriber actions (no showId needed)
    if (action === 'subscribe') {
      if (!generalSubscribers.has(email)) {
        generalSubscribers.add(email);
        subscribersAdded++;
        console.log(`  + subscriber: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
      }
      continue;
    }

    if (action === 'unsubscribe') {
      if (generalSubscribers.has(email)) {
        generalSubscribers.delete(email);
        subscribersRemoved++;
        console.log(`  - subscriber: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} (unsubscribed)`);
      }
      continue;
    }

    // Per-show actions require showId
    if (!showId) {
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

  console.log(`\nFollow results: ${added} added, ${removed} removed, ${skippedDuplicate} duplicates, ${skippedInvalid} invalid`);
  console.log(`Subscriber results: ${subscribersAdded} subscribed, ${subscribersRemoved} unsubscribed, ${generalSubscribers.size} total`);

  if (!DRY_RUN && (added > 0 || removed > 0)) {
    saveFollowers(data);
  } else if (added === 0 && removed === 0) {
    console.log('No follow changes to save');
  }

  // Write subscribers.json (sorted for stable retry offset)
  if (!DRY_RUN) {
    const subscribersList = Array.from(generalSubscribers).sort();
    const subscribersData = {
      _meta: {
        lastSynced: new Date().toISOString(),
        totalSubscribers: subscribersList.length,
      },
      subscribers: subscribersList,
    };
    fs.writeFileSync(SUBSCRIBERS_PATH, JSON.stringify(subscribersData, null, 2));
    console.log(`Saved ${subscribersList.length} subscribers to ${SUBSCRIBERS_PATH}`);
  } else {
    console.log(`(Dry run — would save ${generalSubscribers.size} subscribers)`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
