#!/usr/bin/env node
'use strict';
// scripts/digest-sent-precheck.js — cheap "is today's owner digest already out?" check for the
// morning-digest Action's catch-up trigger (BRO-6764 handoff day). GitHub dropped every scheduled
// run on 2026-11-02, so the Action also wakes on each finished Test Suite run on main (events are
// delivered reliably, ~100 a day). Most of those wakes must cost one Resend read, not a full digest
// build, so this runs first: go=true only when Resend positively shows no digest to the owner yet today.
// Fail closed: 'cannot-tell' (Resend down, key missing) skips the catch-up wake; the scheduled lines,
// the dispatch path and the 12:30 ET pager (check-morning-digest-sent.yml) are unaffected.
// Read-only: it sends nothing and writes only $GITHUB_OUTPUT.

function goFromVerdict(verdict) { return verdict === 'send'; }

async function precheck({ apiKey = process.env.RESEND_API_KEY, recipient = process.env.OWNER_EMAIL, now = new Date(), fetchEmails = null } = {}) {
  const { resendSentToday } = require('./send-morning-digest.js');
  const r = await resendSentToday({ apiKey, recipient, now, fetchEmails });
  return { go: goFromVerdict(r.verdict), verdict: r.verdict, reason: r.reason };
}

if (require.main === module) {
  precheck().then((r) => {
    console.log(`[digest-precheck] ${r.go ? 'GO' : 'SKIP'}: ${r.verdict} (${String(r.reason).replace(/\S+@\S+/g, '<address>')})`);
    if (process.env.GITHUB_OUTPUT) require('fs').appendFileSync(process.env.GITHUB_OUTPUT, `go=${r.go}\n`);
  }).catch((err) => {
    console.log(`[digest-precheck] SKIP: ${String(err.message).slice(0, 120)}`);
    if (process.env.GITHUB_OUTPUT) require('fs').appendFileSync(process.env.GITHUB_OUTPUT, 'go=false\n');
  });
}

module.exports = { precheck, goFromVerdict };
