#!/usr/bin/env node
/**
 * Send the owner ONE "it's fixed" draft reply per feedback bug that was closed
 * as completed (BRO-7693). The owner sends it by hand; nothing goes to a reader.
 *
 * Picks GitHub issues labelled bug-diagnosis, closed as completed on or after
 * LAUNCH_CUTOFF by anyone (auto-fix, approved fix, or by hand), without the
 * reply-drafted label. After the draft is emailed the
 * issue gets reply-drafted, which is the only dedupe state (no ledger).
 *
 * Usage: node scripts/draft-fixed-replies.js [--dry-run] [--cutoff=YYYY-MM-DD]
 * Env:   GH_TOKEN, RESEND_API_KEY, OWNER_EMAIL; core data checked out (reader store)
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadIssueDiagnosis } = require('./lib/feedback-submitter-store.js');
const { readerFromDiagnosis } = require('./lib/owner-fix-email.js');
const { maskEmail } = require('./lib/pii-scan.js');
const {
  sendReplyOrDraft, makeResendTransport, markReplyDrafted, DRAFTED_LABEL,
} = require('./lib/feedback-reply-drafts.js');

const REPO = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
const BASE = 'https://broadwayscorecard.com';
const LAUNCH_CUTOFF = '2026-11-17';

function ghGet(apiPath, token) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.github.com${apiPath}`, {
      timeout: 30000,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'broadwayscorecard-reply-drafts', Accept: 'application/vnd.github+json' },
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 200)}`));
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
    }).on('timeout', function onTimeout() { this.destroy(new Error('GitHub request timed out')); }).on('error', reject);
  });
}

/** Issues that still need a draft. Pure, so the test can pin the selection rules. */
const SKIP_LABELS = new Set(['feedback-digest', 'auto-dispatched', 'duplicate', 'wontfix', 'invalid', 'not-a-bug', 'needs-manual-review']);
const GRACE_MIN = 30; // auto-fix emails its own draft right after closing; do not race it

function selectIssuesNeedingDraft(issues, cutoffIso, now = Date.now()) {
  const cutoff = Date.parse(cutoffIso);
  return (issues || []).filter((i) =>
    i && !i.pull_request
    && i.state === 'closed'
    && i.state_reason === 'completed'
    && i.closed_at && Date.parse(i.closed_at) >= cutoff
    && now - Date.parse(i.closed_at) >= GRACE_MIN * 60000
    && (i.labels || []).some((l) => (l.name || l) === 'bug-diagnosis')
    // Whoever closed it (auto-fix, approved fix, or a session by hand), a bug
    // the reader reported and we fixed deserves a draft. Content requests and
    // duplicates are not "pushed a fix" stories: content requests have their
    // own reviews-added draft (verify-feedback-requests-live.js).
    && !(i.labels || []).some((l) => SKIP_LABELS.has(l.name || l))
    && !(i.labels || []).some((l) => (l.name || l) === DRAFTED_LABEL));
}

/** Live page link only when the reader's show matches exactly one catalog entry. */
function showLinkFor(showTitle, shows) {
  if (!showTitle) return null;
  const t = String(showTitle).trim().toLowerCase();
  const hits = (shows || []).filter((s) => s && [s.title, s.id, s.slug].some((v) => v && String(v).toLowerCase() === t));
  return hits.length === 1 ? `${BASE}/show/${hits[0].slug || hits[0].id}` : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cutoffArg = (args.find((a) => a.startsWith('--cutoff=')) || '').slice(9);
  const cutoff = cutoffArg || LAUNCH_CUTOFF;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) { console.log('No GH_TOKEN, nothing to do'); return; }
  const resendKey = process.env.RESEND_API_KEY;
  if (!dryRun && !resendKey) { console.log('No RESEND_API_KEY, nothing to do'); return; }

  let shows = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
    shows = raw.shows || raw;
  } catch { /* no catalog: drafts go without a link */ }

  const issues = await ghGet(`/repos/${REPO}/issues?labels=bug-diagnosis&state=closed&since=${cutoff}T00:00:00Z&per_page=100&sort=updated`, token);
  const todo = selectIssuesNeedingDraft(issues, `${cutoff}T00:00:00Z`);
  console.log(`${todo.length} closed-as-completed bug(s) since ${cutoff} need a draft`);

  const transport = dryRun
    ? async (p) => console.log(`[dry-run] would email ${p.to.map(maskEmail).join(', ')}\nSubject: ${p.subject}`)
    : makeResendTransport(resendKey);

  let drafted = 0;
  for (const issue of todo) {
    const diag = loadIssueDiagnosis(issue.body || '');
    const reader = diag ? readerFromDiagnosis(diag) : null;
    if (!reader || !reader.email) { console.log(`  #${issue.number}: no reader email on file, skipping`); continue; }
    try {
      const res = await sendReplyOrDraft({
        kind: 'bug-fixed',
        type: 'fixed',
        reader,
        originalMessage: reader.message,
        url: showLinkFor(reader.show, shows),
        // Hard rule: this script only ever drafts to the owner, whatever the env says.
        env: { ...process.env, FEEDBACK_AUTO_REPLY_KINDS: '' },
        transport,
      });
      if (!res.sent) { console.log(`  #${issue.number}: no draft (${res.reason})`); continue; }
      drafted++;
      console.log(`  #${issue.number}: draft emailed to owner for ${maskEmail(reader.email)}`);
      if (!dryRun && !(await markReplyDrafted(issue.number, { token, repo: REPO }))) {
        console.log(`  WARN: #${issue.number} could not be labelled ${DRAFTED_LABEL}`);
      }
    } catch (err) {
      console.log(`  #${issue.number}: draft failed (${err.message}); will retry next run`);
    }
  }
  console.log(`Drafted ${drafted} reply(ies)`);
}

module.exports = { GRACE_MIN, SKIP_LABELS, selectIssuesNeedingDraft, showLinkFor, LAUNCH_CUTOFF };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
