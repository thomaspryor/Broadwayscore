#!/usr/bin/env node
// Cheap pre-check for the Sunday content-review job (#507): is there anything
// left to review, or did the owner (or a prior automated pass) already hit
// Send in the Resend UI? READ-ONLY — GET /broadcasts only, never touches
// /send. Exists so the launcher can skip spinning up an Opus session (real
// $ + wall-clock) when both editions are already sent for the current week.
//
// Usage: node scripts/newsletter/check-drafts-status.mjs [weekStart YYYY-MM-DD]
// Prints JSON: { weekStart, broadway: 'draft'|'sent'|'missing'|..., westEnd: ... }
// Exit 0 if there's anything to review (a pending draft, OR an edition that
// hasn't been drafted at all yet — refresh-drafts.sh can still create it);
// exit 3 ONLY when every edition that exists is already sent/scheduled (the
// true "nothing to do" case); exit 1 on error.
//
// weekStart defaults to "last Monday in America/New_York" — the SAME
// timezone-explicit formula refresh-drafts.sh and generate.mjs use (ship-check
// finding: an earlier version used host-local getDay() + UTC toISOString(),
// which could pick the wrong week on a non-ET host clock or near midnight).

const KEY = process.env.RESEND_API_KEY;
if (!KEY) { console.error('No RESEND_API_KEY'); process.exit(1); }

function lastMondayET(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
  const etMidnightUTC = new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`); // noon UTC avoids any DST-edge date-rollback
  etMidnightUTC.setUTCDate(etMidnightUTC.getUTCDate() - ((dow + 6) % 7));
  return etMidnightUTC.toISOString().slice(0, 10);
}

const weekStart = process.argv[2] || lastMondayET();

const NAMES = {
  broadway: `Scorecard Weekly — ${weekStart}`,
  westEnd: `West End Weekly — ${weekStart}`,
};

async function main() {
  const res = await fetch('https://api.resend.com/broadcasts', {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`Resend GET /broadcasts failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  const all = (body && body.data) || [];

  const status = {};
  for (const [key, name] of Object.entries(NAMES)) {
    const matches = all.filter((b) => b && b.name === name);
    if (!matches.length) status[key] = 'missing';
    else if (matches.some((b) => b.status === 'draft')) status[key] = 'draft';
    else status[key] = matches[0].status; // sent/scheduled/etc.
  }

  console.log(JSON.stringify({ weekStart, ...status }));
  // "Nothing to review" means every edition is confirmed SENT — not merely
  // absent of a draft. A 'missing' edition still needs the review session to
  // run refresh-drafts.sh and create it (ship-check finding: the old exit-3
  // condition also fired on 'missing', silently swallowing the case where no
  // draft exists yet at all and suppressing the alert that should catch that).
  const allSent = Object.values(status).every((s) => s === 'sent' || s === 'scheduled');
  process.exit(allSent ? 3 : 0);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
