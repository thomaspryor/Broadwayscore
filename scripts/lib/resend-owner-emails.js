/**
 * resend-owner-emails.js — paginated read of Resend send history (GET /emails),
 * filtered to rows addressed to the owner. Shared by
 * scripts/monitor-scheduled-email-count.js and scripts/check-morning-digest-sent.js
 * so both read the feed the same way (BRO-4373).
 *
 * Needs a full-access RESEND_API_KEY (a send-only key gets HTTP 401 here).
 */
'use strict';

const https = require('https');

// Broadcast sends pad the feed with hundreds of non-owner rows per send at
// limit=100/page — cap pagination so a big broadcast day can't turn this into
// a runaway API loop. 40 pages = 4,000 emails scanned.
const MAX_PAGES = 40;

function getEmailsPage(apiKey, after) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails?limit=100' + (after ? `&after=${encodeURIComponent(after)}` : ''),
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 20000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function getEmailsPageWithRetry(apiKey, after, retries = 2) {
  try {
    return await getEmailsPage(apiKey, after);
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 1000));
    return getEmailsPageWithRetry(apiKey, after, retries - 1);
  }
}

// Newest-first pagination until a page's oldest row is before sinceMs.
// Throws on API failure (callers decide what an outage means).
// strict: throw if history is incomplete (missing `data`, or MAX_PAGES hit before
// reaching sinceMs) so a caller that pages on absence never pages on a truncated feed.
async function fetchOwnerEmailsSince({ apiKey, ownerEmail, sinceMs, strict = false }) {
  const owner = ownerEmail.toLowerCase();
  const rows = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await getEmailsPageWithRetry(apiKey, after);
    if (strict && !Array.isArray(j.data)) throw new Error('Resend response had no data array');
    const data = j.data || [];
    if (data.length === 0) break;
    for (const e of data) {
      const to = Array.isArray(e.to) ? e.to : [e.to];
      if (to.some((t) => String(t || '').toLowerCase() === owner)) rows.push(e);
    }
    const last = data[data.length - 1];
    const lastMs = new Date(String(last.created_at).trim().replace(' ', 'T').replace(/\+00$/, 'Z')).getTime();
    if (lastMs < sinceMs || !j.has_more) break;
    after = last.id;
    if (strict && page === MAX_PAGES - 1) throw new Error(`history incomplete: ${MAX_PAGES} pages fetched without reaching the start of the window`);
  }
  return rows;
}

module.exports = { fetchOwnerEmailsSince, MAX_PAGES };
