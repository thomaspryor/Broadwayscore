#!/usr/bin/env node
/**
 * autonomous-deadman.js — S2-T7. Alerts the owner if the autonomous loop's
 * ledger has gone silent >24h while the loop is armed.
 *
 * Runs on the Mac Studio via its own launchd job (a few hours after the
 * nightly slot) because the ledger is a local gitignored file — CI's
 * health-check can't see it. "Armed" = the nightly launchd plist is
 * installed; before install (or after a kill-switch unload) this is silent.
 *
 *   node scripts/autonomous-deadman.js                 check, alert if dead
 *   node scripts/autonomous-deadman.js --dry-run       check, print only
 *   node scripts/autonomous-deadman.js --ledger p --armed   (tests)
 *
 * Alert path: one transactional Resend email to the config ownerEmail —
 * same style as health-check's critical alerts, never a broadcast (rule 17).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const { readEntries, deadmanStatus, appendEntry } = require('./lib/autonomous-ledger.js');

const REPO = path.join(__dirname, '..');
const CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.broadwayscore.autonomous-nightly.plist');

for (const envPath of [path.join(REPO, '.env'), '/Users/tompryor/Broadwayscore/.env']) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  break;
}

function sendAlert(to, message) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error('[deadman] RESEND_API_KEY not set — cannot alert'); process.exit(1); }
  const data = JSON.stringify({
    from: 'Broadway Scorecard <alerts@broadwayscorecard.com>',
    to: [to],
    subject: '🚨 Autonomous loop dead-man alert',
    html: `<p><b>${message}</b></p><p>Check the Mac Studio: <code>launchctl list | grep broadwayscorecard</code>, logs in ~/Library/Logs/broadwayscorecard/, ledger at data/audit/autonomous-ledger.jsonl.</p>`,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Resend ${res.statusCode}: ${body.slice(0, 150)}`)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Resend timeout')); });
    req.write(data);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ledgerFlag = args.indexOf('--ledger');
  const ledgerPath = ledgerFlag !== -1 ? path.resolve(args[ledgerFlag + 1]) : undefined;
  const armed = args.includes('--armed') || fs.existsSync(PLIST_PATH);

  const { entries } = readEntries(ledgerPath);
  const status = deadmanStatus(entries, new Date(), { armed });
  console.log(`[deadman] ${status.ok ? 'OK' : 'ALERT'} — ${status.message}`);
  if (status.ok) return;

  if (dryRun) { console.log('[deadman] (dry-run: alert suppressed)'); process.exitCode = 1; return; }
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
  const to = cfg.ownerEmail;
  if (!to) { console.error('[deadman] no ownerEmail in .claude/autonomous-config.json'); process.exit(1); }
  await sendAlert(to, status.message);
  // The alert itself is ledger activity — it also stops the alert re-firing
  // every run until the loop is actually fixed or another 24h passes.
  try { appendEntry({ event: 'deadman-alert', note: status.message }, ledgerPath); } catch { /* alert already sent */ }
  console.log(`[deadman] alert sent to ${to}`);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => { console.error(`[deadman] fatal: ${err.message}`); process.exit(1); });
}
