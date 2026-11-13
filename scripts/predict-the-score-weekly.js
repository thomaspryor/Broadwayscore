#!/usr/bin/env node
/**
 * predict-the-score-weekly.js (BRO-7463) — Friday email to the owner with how many
 * people have used Predict the Score. Runs in GitHub Actions (account-metrics.yml,
 * job predict-weekly); no chat session, no connector.
 *
 * Reads public.score_calls with the service role and counts. Only counts and
 * averages are logged or sent. The owner's own account is left out of the counts
 * (found by matching OWNER_EMAIL and the private owner-emails list against the auth
 * users) and the email says so. Transactional send to OWNER_EMAIL only, never a broadcast.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, OWNER_EMAIL
 * Flags: --dry-run (print the email, send nothing)
 *        --friday-after-et-hour=12 (exit quietly unless it is Friday in New York at 12:00 or
 *        later. The workflow has two crons (EST and EDT) and GitHub often starts crons late, so
 *        the gate is "Friday from noon on", not one exact hour. The Idempotency-Key is per
 *        owner and ET day with no content hash, so a second run the same day cannot send again.)
 */
const fs = require('fs');
const path = require('path');
const { inboxKey } = require('./lib/account-metrics');
const { buildReport, renderEmail, easternHour, easternWeekday } = require('./lib/predict-the-score-weekly');
const { sendWithRetry, buildIdempotencyKey } = require('./lib/resend-send-retry');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));

async function supabaseGet(urlPath, { range } = {}) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  if (range) headers.Range = range;
  const res = await fetch(`${base}${urlPath}`, { headers, signal: AbortSignal.timeout(60000) });
  // Never echo the body: it can carry request details.
  if (!res.ok) throw new Error(`Supabase ${urlPath.split('?')[0]}: HTTP ${res.status}`);
  return res.json();
}

async function fetchCalls() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; from < 1_000_000; from += PAGE) {
    // user_id,show_id is the primary key: a unique order keeps range pages stable.
    const batch = await supabaseGet('/rest/v1/score_calls?select=user_id,show_id,called_score,locked_at&order=user_id,show_id',
      { range: `${from}-${from + PAGE - 1}` });
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  throw new Error('score_calls: too many rows');
}

function loadOwnerEmails() {
  const candidates = [process.env.OWNER_EMAILS_FILE, '/tmp/core-data-checkout/analytics/owner-emails.json'].filter(Boolean);
  for (const p of candidates) {
    try {
      const list = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(list)) return list.filter((x) => typeof x === 'string');
    } catch { /* missing or not JSON: try the next */ }
  }
  return [];
}

/** User ids (kept in memory only) of the owner's own accounts. */
async function findOwnerUserIds(ownerAddresses) {
  const wanted = new Set(ownerAddresses.filter(Boolean).map(inboxKey));
  const ids = new Set();
  for (let page = 1; page <= 1000; page++) {
    const r = await supabaseGet(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = Array.isArray(r) ? r : (r.users || []);
    if (users.length === 0) return ids;
    for (const u of users) if (u && wanted.has(inboxKey(u.email))) ids.add(u.id);
  }
  throw new Error('more than 200k users: raise the page cap');
}

function loadTitles() {
  try {
    const f = path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json');
    const shows = JSON.parse(fs.readFileSync(f, 'utf8')).shows || [];
    return Object.fromEntries(shows.filter((s) => s && s.id && s.t).map((s) => [s.id, s.t]));
  } catch { return {}; }
}

async function main() {
  if (args['friday-after-et-hour'] && !(easternWeekday() === 'Fri' && easternHour() >= Number(args['friday-after-et-hour']))) {
    console.log('Not Friday after noon in New York; the other cron or a later run sends it. Nothing to do.');
    return;
  }
  const owner = process.env.OWNER_EMAIL;
  if (!owner) throw new Error('OWNER_EMAIL not set');

  const calls = await fetchCalls();
  const ownerIds = calls.length ? await findOwnerUserIds([owner, ...loadOwnerEmails()]) : new Set();
  const report = buildReport(calls, { ownerUserIds: ownerIds, titles: loadTitles() });
  if (calls.length) report.ownerFound = ownerIds.size > 0;
  const { subject, text } = renderEmail(report);
  // Counts only in the log.
  console.log(`people=${report.people} predictions=${report.predictions} newPeople=${report.newPeople} newPredictions=${report.newPredictions} owner=${report.ownerPredictions} shows=${report.perShow.length}`);

  if (args['dry-run']) { console.log(`--- DRY RUN (nothing sent) ---\n${subject}\n\n${text}`); return; }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');

  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // No content hash: one email per owner per ET day, even if a second cron or a late run sees new counts.
  const key = buildIdempotencyKey('predict-the-score-weekly', day, owner);
  let res;
  try {
  res = await sendWithRetry(async () => {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from: 'Broadway Scorecard <notifications@broadwayscorecard.com>', to: [owner], subject, text }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await r.text();
    if (!r.ok) {
      // Status and Resend's error name only: a body can echo the recipient into the public log.
      let name = ''; try { name = JSON.parse(body).name || ''; } catch { /* not JSON */ }
      throw new Error(`HTTP ${r.status} ${name}`.trim());
    }
    return JSON.parse(body);
  });
  } catch (e) {
    if (/HTTP 409 invalid_idempotent_request/.test(e.message)) {
      console.log('Already sent today (Resend idempotency key matched with different content). Nothing more to send.');
      return;
    }
    throw e;
  }
  if (!res || !res.id) throw new Error('Resend returned no email id: the email was NOT delivered');
  console.log(`Sent: "${subject}" (resend id ${res.id})`);
}

main().catch((e) => { console.error(`[predict-the-score-weekly] ${e.message}`); process.exit(1); });
