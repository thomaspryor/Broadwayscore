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

// Resend segment IDs — mirror subscribers into Resend for Broadcasts API
const RESEND_SEGMENT_BROADWAY = '472ec5ef-d7cc-4c48-8007-c0a6a302e7a4';
const RESEND_SEGMENT_WESTEND = '0b17260b-6a72-4a5a-a700-7b7526f18d87';

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

function httpJSON(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };

    const req = https.request(options, (res) => {
      let respBody = '';
      res.on('data', (chunk) => respBody += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(respBody)); } catch { resolve(respBody); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${respBody.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postJSON(url, body, headers) { return httpJSON('POST', url, body, headers); }
function patchJSON(url, body, headers) { return httpJSON('PATCH', url, body, headers); }

/**
 * Sync a subscriber list into a Resend segment.
 * Upserts all active subscribers and marks removed ones as unsubscribed.
 */
async function syncResendContacts(subscribers, segmentId, segmentName, resendApiKey) {
  if (!resendApiKey) {
    console.log(`  Skipping Resend sync for ${segmentName} (no RESEND_API_KEY)`);
    return;
  }

  console.log(`\n  Syncing ${subscribers.length} subscribers to Resend segment "${segmentName}"...`);

  // Fetch existing contacts in this segment
  const existingContacts = new Map(); // email → { id, unsubscribed }
  let hasMore = true;
  let after = null;

  while (hasMore) {
    let url = `https://api.resend.com/segments/${segmentId}/contacts?limit=100`;
    if (after) url += `&after=${after}`;

    try {
      const result = await fetchJSON(url, { 'Authorization': `Bearer ${resendApiKey}` });
      const contacts = result.data || [];
      for (const c of contacts) {
        existingContacts.set(c.email, { id: c.id, unsubscribed: c.unsubscribed });
      }
      hasMore = result.has_more && contacts.length > 0;
      if (hasMore) after = contacts[contacts.length - 1].id;
    } catch (err) {
      console.error(`  Error fetching Resend contacts: ${err.message}`);
      return;
    }
  }

  console.log(`  Found ${existingContacts.size} existing contacts in Resend`);

  const subscriberSet = new Set(subscribers);
  let created = 0, resubscribed = 0, unsubscribed = 0, errors = 0;

  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // Upsert active subscribers (rate limit: 2 req/sec → 600ms between calls)
  for (const email of subscribers) {
    const existing = existingContacts.get(email);
    if (existing && !existing.unsubscribed) continue; // Already active

    try {
      await postJSON('https://api.resend.com/contacts', {
        email,
        unsubscribed: false,
        segments: [{ id: segmentId }],
      }, { 'Authorization': `Bearer ${resendApiKey}` });

      if (existing) { resubscribed++; } else { created++; }
    } catch (err) {
      // 409 = already exists, that's fine
      if (!err.message.includes('409')) {
        errors++;
        if (errors <= 3) console.error(`  Error upserting ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}: ${err.message}`);
      }
    }
    await delay(1000);
  }

  // Mark removed subscribers as unsubscribed in Resend
  for (const [email, contact] of existingContacts) {
    if (!subscriberSet.has(email) && !contact.unsubscribed) {
      try {
        await patchJSON(`https://api.resend.com/contacts/${contact.id}`, {
          unsubscribed: true,
        }, { 'Authorization': `Bearer ${resendApiKey}` });
        unsubscribed++;
      } catch (err) {
        errors++;
        if (errors <= 3) console.error(`  Error unsubscribing ${email.replace(/(.{2}).*(@.*)/, '$1***$2')}: ${err.message}`);
      }
      await delay(1000);
    }
  }

  console.log(`  Resend sync: ${created} created, ${resubscribed} resubscribed, ${unsubscribed} unsubscribed${errors > 0 ? `, ${errors} errors` : ''}`);
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

    // Mirror to Resend segment for Broadcasts API
    await syncResendContacts(subscribersList, RESEND_SEGMENT_BROADWAY, 'Broadway', process.env.RESEND_API_KEY);
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

      // Mirror to Resend segment for Broadcasts API
      await syncResendContacts(weList, RESEND_SEGMENT_WESTEND, 'West End', process.env.RESEND_API_KEY);
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
