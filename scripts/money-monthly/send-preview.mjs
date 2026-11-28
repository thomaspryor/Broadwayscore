// BRO-6773: send the money-monthly [DRAFT] preview to the OWNER ONLY, as a
// transactional email (never a broadcast, CLAUDE.md §17). Same guard as
// scripts/newsletter/send-test.mjs: CI=true, MONEY_SEND=1 or --force to send.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildUnsubscribeUrl, buildFromAddress, buildReplyToAddress } = require('../lib/email-templates');
const { hasHelpFlag } = require('../lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/money-monthly/send-preview.mjs --file=<html> [--force]\nOwner-only transactional preview. Dry run unless CI=true, MONEY_SEND=1 or --force.');
  process.exit(0);
}
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || undefined;
const file = arg('file');
if (!file) { console.error('--file=<html> required'); process.exit(1); }
const owner = process.env.MONEY_PREVIEW_RECIPIENT || process.env.OWNER_EMAIL || 'thomas.pryor@gmail.com';
const meta = JSON.parse(fs.readFileSync(file.replace(/\.html$/, '.meta.json'), 'utf8'));
const prefix = process.env.MONEY_SUBJECT_PREFIX || '[DRAFT]';
const subject = `${prefix} ${meta.subject}`;
const html = fs.readFileSync(file, 'utf8').replace(/\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/g, buildUnsubscribeUrl(owner, 'broadway'));
const allow = process.env.CI === 'true' || process.env.MONEY_SEND === '1' || process.argv.includes('--force');
if (!allow) { console.log('[DRY RUN] would send to owner only:', subject); process.exit(0); }
const KEY = process.env.RESEND_API_KEY;
if (!KEY) { console.error('No RESEND_API_KEY'); process.exit(1); }
const res = await fetch('https://api.resend.com/emails', {
  method: 'POST', signal: AbortSignal.timeout(60000),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ from: buildFromAddress('broadway'), reply_to: buildReplyToAddress(), to: [owner], subject, html }),
});
const json = await res.json();
if (!res.ok) { console.error('Send failed:', json); process.exit(1); }
console.log('Sent:', json.id, '|', subject);
