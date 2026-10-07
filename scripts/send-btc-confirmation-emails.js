#!/usr/bin/env node
/**
 * Beat the Critics — retroactive confirmation email sender (BRO-1325)
 *
 * Before 2026-06-07, a Resend fetch() bug in send-picks/route.ts could fail
 * silently: the pick submission was stored, but the confirmation email
 * never sent. This script re-sends a confirmation to every unique entrant
 * in data/beat-the-critics-submissions.jsonl.
 *
 * Idempotent: successful sends are checkpointed to a sent-log JSON file
 * (next to the submissions file) after every send, so a re-run only emails
 * addresses not already in the log.
 *
 * NOTE (2026-09-15): the 2026 ceremony has already happened and results
 * were already emailed to entrants on 2026-06-12 (verified against the
 * owner's own inbox). The confirmation copy has been corrected to say so —
 * see scripts/lib/btc-confirmation.js — instead of the original pre-ceremony
 * "we'll email you after the ceremony" wording, which would now be false.
 * Whether this retroactive send is still worth making, given results
 * already went out, is an open owner call — see the BRO-1325 report.
 *
 * Usage: node scripts/send-btc-confirmation-emails.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { applyUtm } = require('./lib/email-utm');
const { markTestSend } = require('./lib/test-send-marker');
const {
  parseSubmissionsJsonl,
  dedupeLatestByEmail,
  filterUnsent,
  buildConfirmationEmail,
} = require('./lib/btc-confirmation');

const USAGE = `send-btc-confirmation-emails.js — retroactive BTC confirmation resend (BRO-1325)

Usage:
  node scripts/send-btc-confirmation-emails.js --dry-run
  node scripts/send-btc-confirmation-emails.js --send-to=me@email.com
  node scripts/send-btc-confirmation-emails.js                # sends to all unsent entrants

Flags:
  --dry-run           Preview recipients + subjects, sends nothing
  --send-to=<email>   Send (or resend) to one address only, bypassing the sent-log
  --data-dir=<path>   Directory containing beat-the-critics-submissions.jsonl
                      (default: this repo's data/, falling back to ~/broadway-scorecard-data/data)
`;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Broadway Scorecard <noreply@broadwayscorecard.com>';
const SEND_INTERVAL_MS = 500; // ~2/sec

const args = process.argv.slice(2);
if (hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }

const KNOWN_FLAG_PREFIXES = ['--dry-run', '--send-to=', '--data-dir='];

const unknownArg = args.find(a => !KNOWN_FLAG_PREFIXES.some(p => a === p || a.startsWith(p)));
if (unknownArg) {
  console.error(`Unrecognized argument: ${unknownArg}`);
  console.error('Known flags: --dry-run, --send-to=<email>, --data-dir=<path>');
  process.exit(1);
}

const DRY_RUN = args.includes('--dry-run');
const sendToRaw = args.find(a => a.startsWith('--send-to='))?.split('=')[1] ?? null;
if (sendToRaw !== null && sendToRaw.trim() === '') {
  console.error('--send-to= requires a non-empty email address (got an empty value, which would otherwise fall through to sending everyone).');
  process.exit(1);
}
const SEND_TO = sendToRaw;
const dataDirArg = args.find(a => a.startsWith('--data-dir='))?.split('=')[1] ?? null;

// Falls back to the private core-data clone (~/broadway-scorecard-data) if
// this repo checkout doesn't have the (gitignored) submissions file locally
// — mirrors how scripts/send-btc-results.js is meant to be run.
function resolveDataDir() {
  if (dataDirArg) return dataDirArg;
  const local = path.join(__dirname, '../data');
  if (fs.existsSync(path.join(local, 'beat-the-critics-submissions.jsonl'))) return local;
  const home = process.env.HOME || '';
  const cloneDir = path.join(home, 'broadway-scorecard-data/data');
  if (fs.existsSync(path.join(cloneDir, 'beat-the-critics-submissions.jsonl'))) return cloneDir;
  return local;
}

function loadSentLog(sentLogPath) {
  if (!fs.existsSync(sentLogPath)) return new Set();
  const raw = JSON.parse(fs.readFileSync(sentLogPath, 'utf8'));
  return new Set((raw.sent || []).map(e => e.toLowerCase()));
}

// Re-reads the log from disk and merges before writing, so a concurrent
// second run (or a stale in-memory sentSet) can't clobber entries the other
// process already checkpointed — last-writer-wins per email, union overall.
function saveSentLog(sentLogPath, sentSet) {
  const onDisk = loadSentLog(sentLogPath);
  const merged = new Set([...onDisk, ...sentSet]);
  const sorted = Array.from(merged).sort();
  fs.writeFileSync(sentLogPath, JSON.stringify({ sent: sorted, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  for (const email of onDisk) sentSet.add(email); // keep caller's in-memory set in sync
}

// Best-effort: commit + push the sent-log if the resolved data dir is its
// own git repo (the private core-data clone). Never throws — the in-memory
// sent set already protects this run; durability across runs is a bonus.
function commitSentLog(dataDir, sentLogPath) {
  try {
    execFileSync('git', ['-C', dataDir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    return; // not a git repo (e.g. the app repo's own data/) — nothing to commit
  }
  try {
    const logFile = path.basename(sentLogPath);
    execFileSync('git', ['-C', dataDir, 'add', logFile]);
    // Pathspec-scoped so this only ever commits the sent-log, never whatever
    // else happens to be staged in that clone at the time.
    execFileSync('git', ['-C', dataDir, 'commit', '-m', 'chore: BTC confirmation sent-log update [skip ci]', '--', logFile], { stdio: 'ignore' });
    execFileSync('git', ['-C', dataDir, 'push']);
  } catch (err) {
    console.error(`(sent-log commit/push skipped: ${err.message.split('\n')[0]})`);
  }
}

async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  if (!RESEND_API_KEY && !DRY_RUN) {
    console.error('RESEND_API_KEY not set. Use --dry-run to preview without sending.');
    process.exit(1);
  }

  const dataDir = resolveDataDir();
  const submissionsPath = path.join(dataDir, 'beat-the-critics-submissions.jsonl');
  const sentLogPath = path.join(dataDir, 'beat-the-critics-confirmation-sent.json');

  if (!fs.existsSync(submissionsPath)) {
    console.error(`No submissions file found at ${submissionsPath}`);
    process.exit(1);
  }

  const { records, skippedNoEmail } = parseSubmissionsJsonl(fs.readFileSync(submissionsPath, 'utf8'));
  if (skippedNoEmail) console.log(`(skipped ${skippedNoEmail} row(s) with no email — market-data rows, not entrants)`);

  const byEmail = dedupeLatestByEmail(records);
  const allRecipients = Array.from(byEmail.values());
  console.log(`${allRecipients.length} unique entrant(s) in ${submissionsPath}`);

  const sentSet = loadSentLog(sentLogPath);
  console.log(`${sentSet.size} already confirmed in ${sentLogPath}`);

  let toSend = SEND_TO
    ? allRecipients.filter(r => r.email.trim().toLowerCase() === SEND_TO.toLowerCase())
    : filterUnsent(allRecipients, sentSet);

  if (SEND_TO && toSend.length === 0) {
    console.log(`No submission found for ${SEND_TO} — sending sample confirmation`);
    toSend = [{ email: SEND_TO, picks: { 'Best Musical': 'Test Pick' }, ceremonyYear: 2026 }];
  }

  console.log(`Sending to ${toSend.length} recipient(s)${DRY_RUN ? ' (DRY RUN — no emails sent)' : ''}...\n`);

  let sent = 0, failed = 0;
  for (const record of toSend) {
    let { subject, html } = buildConfirmationEmail(record);
    html = applyUtm(html, { source: 'beat-the-critics', campaign: 'btc-confirmation-retroactive' });
    // SEND_TO is a manual-verification send, not a real confirmation to a real
    // entrant — mark it so it can never read as one in the recipient's inbox
    // (BRO-3577: an unmarked test send of this exact template previously
    // landed in the owner's own inbox and was mistaken for a real broadcast).
    if (SEND_TO) ({ subject, html } = markTestSend({ subject, html }));

    if (DRY_RUN) {
      console.log(`[DRY RUN] ${record.email} — "${subject}"`);
      sent++;
      continue;
    }

    try {
      await sendEmail({ to: record.email, subject, html });
      console.log(`✓ ${record.email}`);
      sent++;
      if (!SEND_TO) {
        sentSet.add(record.email.trim().toLowerCase());
        try {
          saveSentLog(sentLogPath, sentSet); // checkpoint after every send
        } catch (logErr) {
          // The email already went out and can't be un-sent, but continuing
          // to send without a durable checkpoint risks duplicate sends on
          // the next run — stop here rather than compounding the problem.
          console.error(`\nFATAL: sent to ${record.email} but failed to write sent-log: ${logErr.message}`);
          console.error(`Fix the sent-log path (${sentLogPath}) before re-running.`);
          process.exit(1);
        }
      }
      await new Promise(r => setTimeout(r, SEND_INTERVAL_MS));
    } catch (err) {
      console.error(`✗ ${record.email}: ${err.message}`);
      failed++;
    }
  }

  if (!DRY_RUN && !SEND_TO && sent > 0) commitSentLog(dataDir, sentLogPath);

  console.log(`\nDone. ${sent} sent, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
