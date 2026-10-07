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
  const draftIds = {};
  for (const [key, name] of Object.entries(NAMES)) {
    const matches = all.filter((b) => b && b.name === name);
    if (!matches.length) status[key] = 'missing';
    else {
      const draft = matches.find((b) => b.status === 'draft');
      if (draft) { status[key] = 'draft'; draftIds[key] = draft.id; }
      else status[key] = matches[0].status; // sent/scheduled/etc.
    }
  }

  // Pre-send BANNER detection (2026-08-02). pre-send-check.mjs treats several
  // issues as SOFT and injects a red "PRE-SEND ISSUES — fix before broadcasting
  // to subscribers" block into the draft BODY, then create-broadcast-draft
  // PATCHes that HTML up as-is with no guard. So the warning meant for the
  // owner is sitting inside the subscriber-facing email: hit Send without
  // spotting it and every subscriber sees it. That shipped into the 2026-07-27
  // Broadway draft off a single over-length subject, and it was caught only
  // because a human happened to read the rendered HTML.
  //
  // Twelve distinct softIssues.push() sites can trigger it, so fixing any one
  // of them (as the subject-cap fix did) closes one door of twelve. Detect the
  // banner itself instead — that covers all twelve and any future thirteenth.
  // Read-only: one extra GET per draft, still never touches /send.
  const bannerPresent = {};
  for (const [key, id] of Object.entries(draftIds)) {
    try {
      const r = await fetch(`https://api.resend.com/broadcasts/${id}`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) { bannerPresent[key] = null; continue; } // unknown, don't claim clean
      const b = await r.json();
      bannerPresent[key] = String((b && b.html) || '').includes('PRE-SEND ISSUES');
    } catch {
      bannerPresent[key] = null; // network/timeout — unknown, never a false "clean"
    }
  }

  const flagged = Object.entries(bannerPresent).filter(([, v]) => v === true).map(([k]) => k);
  console.log(JSON.stringify({ weekStart, ...status, bannerPresent }));
  if (flagged.length) {
    // stderr, not stdout: the launcher parses stdout as JSON.
    console.error(
      `\n⚠️  PRE-SEND BANNER IS LIVE IN THE DRAFT BODY: ${flagged.join(', ')}\n` +
      `   Subscribers WILL see a red warning block if this is sent as-is.\n` +
      `   Fix the underlying soft issue, re-run refresh-drafts.sh, and confirm this flag clears.\n`
    );
  }
  // "Nothing to review" means every edition is confirmed SENT — not merely
  // absent of a draft. A 'missing' edition still needs the review session to
  // run refresh-drafts.sh and create it (ship-check finding: the old exit-3
  // condition also fired on 'missing', silently swallowing the case where no
  // draft exists yet at all and suppressing the alert that should catch that).
  const allSent = Object.values(status).every((s) => s === 'sent' || s === 'scheduled');
  process.exit(allSent ? 3 : 0);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
