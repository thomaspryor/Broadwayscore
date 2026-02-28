#!/usr/bin/env node
/**
 * sync-followers.js
 *
 * Fetches Formspree submissions from two separate forms:
 *   1. Follow form (FORMSPREE_FOLLOW_FORM_ID) — per-show follow/unfollow
 *   2. Subscriber form (FORMSPREE_SUBSCRIBER_FORM_ID) — general subscribe/unsubscribe
 *
 * Builds/updates data/followers.json and data/subscribers.json.
 *
 * Usage: node scripts/sync-followers.js [--dry-run]
 *
 * Env: FORMSPREE_TOKEN, FORMSPREE_FOLLOW_FORM_ID, FORMSPREE_SUBSCRIBER_FORM_ID
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const FOLLOWERS_PATH = path.join(__dirname, '..', 'data', 'followers.json');
const SUBSCRIBERS_PATH = path.join(__dirname, '..', 'data', 'subscribers.json');
const SUBSCRIBERS_WESTEND_PATH = path.join(__dirname, '..', 'data', 'subscribers-westend.json');
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

async function fetchAllSubmissions(formId, token, sinceDate) {
  const submissions = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    let url = `https://formspree.io/api/0/forms/${formId}/submissions?limit=${limit}&offset=${offset}`;
    if (sinceDate) {
      url += `&since=${encodeURIComponent(sinceDate)}`;
    }

    let result;
    try {
      result = await fetchJSON(url, { 'Authorization': `Bearer ${token}` });
    } catch (err) {
      console.error(`  Error fetching from ${formId}: ${err.message}`);
      if (offset === 0) return null; // Total failure
      console.error('  Aborting pagination — retaining partial results');
      break;
    }

    const items = result.submissions || result;
    if (!Array.isArray(items) || items.length === 0) break;

    submissions.push(...items);
    console.log(`  Fetched ${items.length} submissions (offset ${offset})`);

    if (items.length < limit) break;
    offset += limit;
  }

  return submissions;
}

async function main() {
  const followFormId = process.env.FORMSPREE_FOLLOW_FORM_ID;
  const subscriberFormId = process.env.FORMSPREE_SUBSCRIBER_FORM_ID;
  const followToken = process.env.FORMSPREE_FOLLOW_API_KEY || process.env.FORMSPREE_TOKEN;
  const subscriberToken = process.env.FORMSPREE_SUBSCRIBER_API_KEY || process.env.FORMSPREE_TOKEN;

  if (!followFormId && !subscriberFormId) {
    console.log('Missing both FORMSPREE_FOLLOW_FORM_ID and FORMSPREE_SUBSCRIBER_FORM_ID — skipping sync');
    process.exit(0);
  }

  if (DRY_RUN) console.log('(DRY RUN — no files will be written)\n');

  const data = loadFollowers();
  const existingCount = Object.values(data.followers).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Existing: ${existingCount} follow entries across ${Object.keys(data.followers).length} shows`);

  // --- 1. Fetch per-show follows from Follow form ---
  let added = 0;
  let removed = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  if (followFormId && followToken) {
    console.log(`\nSyncing follows from form ${followFormId}...`);
    const followSubs = await fetchAllSubmissions(followFormId, followToken, data._meta.lastSynced);

    if (followSubs === null) {
      console.log('Could not fetch follow form. If this is the first run, this is normal.');
    } else {
      // Formspree returns newest-first — reverse to process chronologically
      followSubs.reverse();
      console.log(`Follow submissions: ${followSubs.length}`);

      for (const sub of followSubs) {
        const email = (sub.email || sub._replyto || '').toLowerCase().trim();
        const showId = sub.showId;
        const action = (sub.action || 'follow').toLowerCase();

        if (!isValidEmail(email) || !showId) {
          skippedInvalid++;
          continue;
        }

        if (action === 'unfollow') {
          if (data.followers[showId]) {
            const idx = data.followers[showId].indexOf(email);
            if (idx !== -1) {
              data.followers[showId].splice(idx, 1);
              removed++;
              console.log(`  - ${showId}: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} (unfollowed)`);
              if (data.followers[showId].length === 0) delete data.followers[showId];
            }
          }
          continue;
        }

        if (!data.followers[showId]) data.followers[showId] = [];
        if (data.followers[showId].includes(email)) {
          skippedDuplicate++;
          continue;
        }
        data.followers[showId].push(email);
        added++;
        console.log(`  + ${showId}: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
      }
    }
  }

  console.log(`\nFollow results: ${added} added, ${removed} removed, ${skippedDuplicate} duplicates, ${skippedInvalid} invalid`);

  if (!DRY_RUN && (added > 0 || removed > 0)) {
    saveFollowers(data);
  } else if (added === 0 && removed === 0) {
    console.log('No follow changes to save');
  }

  // --- 2. Fetch general subscribers from Subscriber form ---
  const generalSubscribers = new Set();
  try {
    const existing = JSON.parse(fs.readFileSync(SUBSCRIBERS_PATH, 'utf8'));
    if (existing.subscribers) {
      for (const e of existing.subscribers) generalSubscribers.add(e);
    }
  } catch { /* no existing file — start fresh */ }

  let subscribersAdded = 0;
  let subscribersRemoved = 0;

  if (subscriberFormId && subscriberToken) {
    console.log(`\nSyncing subscribers from form ${subscriberFormId}...`);

    // Load subscriber-specific lastSynced (separate from follower sync)
    let subscriberLastSynced = null;
    try {
      const existing = JSON.parse(fs.readFileSync(SUBSCRIBERS_PATH, 'utf8'));
      subscriberLastSynced = existing._meta?.lastSynced || null;
    } catch { /* first run */ }

    const subSubs = await fetchAllSubmissions(subscriberFormId, subscriberToken, subscriberLastSynced);

    if (subSubs === null) {
      console.log('Could not fetch subscriber form. If this is the first run, this is normal.');
    } else {
      // Formspree returns newest-first — reverse to process chronologically
      subSubs.reverse();
      console.log(`Subscriber submissions: ${subSubs.length}`);

      for (const sub of subSubs) {
        const email = (sub.email || sub._replyto || '').toLowerCase().trim();
        const action = (sub.action || 'subscribe').toLowerCase();

        if (!isValidEmail(email)) continue;

        if (action === 'unsubscribe') {
          if (generalSubscribers.has(email)) {
            generalSubscribers.delete(email);
            subscribersRemoved++;
            console.log(`  - subscriber: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} (unsubscribed)`);
          }
        } else {
          if (!generalSubscribers.has(email)) {
            generalSubscribers.add(email);
            subscribersAdded++;
            console.log(`  + subscriber: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
          }
        }
      }
    }
  }

  console.log(`\nSubscriber results: ${subscribersAdded} subscribed, ${subscribersRemoved} unsubscribed, ${generalSubscribers.size} total`);

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

  // --- 3. Fetch West End subscribers from WE Subscriber form ---
  const weFormId = process.env.FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID;
  const weToken = process.env.FORMSPREE_WESTEND_SUBSCRIBER_API_KEY || process.env.FORMSPREE_TOKEN;

  if (weFormId && weToken) {
    const weSubscribers = new Set();
    try {
      const existing = JSON.parse(fs.readFileSync(SUBSCRIBERS_WESTEND_PATH, 'utf8'));
      if (existing.subscribers) {
        for (const e of existing.subscribers) weSubscribers.add(e);
      }
    } catch { /* no existing file — start fresh */ }

    let weAdded = 0;
    let weRemoved = 0;

    console.log(`\nSyncing West End subscribers from form ${weFormId}...`);

    let weLastSynced = null;
    try {
      const existing = JSON.parse(fs.readFileSync(SUBSCRIBERS_WESTEND_PATH, 'utf8'));
      weLastSynced = existing._meta?.lastSynced || null;
    } catch { /* first run */ }

    const weSubs = await fetchAllSubmissions(weFormId, weToken, weLastSynced);

    if (weSubs === null) {
      console.log('Could not fetch WE subscriber form. If this is the first run, this is normal.');
    } else {
      weSubs.reverse();
      console.log(`WE subscriber submissions: ${weSubs.length}`);

      for (const sub of weSubs) {
        const email = (sub.email || sub._replyto || '').toLowerCase().trim();
        const action = (sub.action || 'subscribe').toLowerCase();

        if (!isValidEmail(email)) continue;

        if (action === 'unsubscribe') {
          if (weSubscribers.has(email)) {
            weSubscribers.delete(email);
            weRemoved++;
            console.log(`  - WE subscriber: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')} (unsubscribed)`);
          }
        } else {
          if (!weSubscribers.has(email)) {
            weSubscribers.add(email);
            weAdded++;
            console.log(`  + WE subscriber: ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
          }
        }
      }
    }

    console.log(`\nWE subscriber results: ${weAdded} subscribed, ${weRemoved} unsubscribed, ${weSubscribers.size} total`);

    if (!DRY_RUN) {
      const weList = Array.from(weSubscribers).sort();
      const weData = {
        _meta: {
          lastSynced: new Date().toISOString(),
          totalSubscribers: weList.length,
        },
        subscribers: weList,
      };
      fs.writeFileSync(SUBSCRIBERS_WESTEND_PATH, JSON.stringify(weData, null, 2));
      console.log(`Saved ${weList.length} WE subscribers to ${SUBSCRIBERS_WESTEND_PATH}`);
    } else {
      console.log(`(Dry run — would save ${weSubscribers.size} WE subscribers)`);
    }
  } else {
    console.log('\nSkipping West End subscriber sync (env vars not configured)');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
