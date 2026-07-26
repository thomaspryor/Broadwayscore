#!/usr/bin/env node
// Cheap pre-check for the Sunday content-review job (#507): is there anything
// left to review, or did the owner (or a prior automated pass) already hit
// Send in the Resend UI? READ-ONLY — GET /broadcasts only, never touches
// /send. Exists so the launcher can skip spinning up an Opus session (real
// $ + wall-clock) when both editions are already sent for the current week.
//
// Usage: node scripts/newsletter/check-drafts-status.mjs [weekStart YYYY-MM-DD]
// Prints JSON: { weekStart, broadway: 'draft'|'sent'|'missing', westEnd: ... }
// Exit 0 if at least one edition has a pending draft to review; exit 3 if
// every edition that exists is already sent (nothing to do); exit 1 on error.

const KEY = process.env.RESEND_API_KEY;
if (!KEY) { console.error('No RESEND_API_KEY'); process.exit(1); }

const weekStart = process.argv[2] || (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();

const NAMES = {
  broadway: `Scorecard Weekly — ${weekStart}`,
  westEnd: `West End Weekly — ${weekStart}`,
};

async function main() {
  const res = await fetch('https://api.resend.com/broadcasts', {
    headers: { Authorization: `Bearer ${KEY}` },
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
  const anyPending = Object.values(status).includes('draft');
  process.exit(anyPending ? 0 : 3);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
