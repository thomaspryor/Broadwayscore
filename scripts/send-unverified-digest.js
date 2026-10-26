#!/usr/bin/env node
/**
 * BRO-6336: email the owner the commercial items the automatic check could not verify (once each).
 * Transactional, to OWNER_EMAIL only, through the owner-only email path (discord-notify sendEmailAlert).
 *   node scripts/send-unverified-digest.js [--dry-run]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { collectUnsent, buildDigest, markSent } = require('./lib/unverified-digest');

const args = process.argv.slice(2);
if (hasHelpFlag(args)) { console.log('send-unverified-digest.js [--dry-run]\nEmails the owner commercial items the automatic source check could not confirm, once each.'); process.exit(0); }
const dryRun = args.includes('--dry-run');
const DATA = path.join(__dirname, '..', 'data');
const PENDING = path.join(DATA, 'commercial-pending-review.json');
const ARCHIVE = path.join(DATA, 'commercial-pending-archive.json');
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const write = (p, o) => { fs.writeFileSync(`${p}.tmp`, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(`${p}.tmp`, p); };

(async () => {
  const pending = read(PENDING, { shows: {} });
  const archive = read(ARCHIVE, { shows: {} });
  const items = collectUnsent({ pending, archive });
  const digest = buildDigest(items);
  if (!digest) { console.log('Owner digest: nothing new to report.'); return; }
  console.log(`Owner digest: ${items.length} new item(s).`);
  if (dryRun) { console.log(`${digest.title}\n${digest.description}`); return; }
  const { sendEmailAlert } = require('./lib/discord-notify');
  const key = `commercial-unverified:${crypto.createHash('sha1').update(items.map((i) => i.id).sort().join('|')).digest('hex').slice(0, 20)}`;
  const delivered = await sendEmailAlert({ title: digest.title, description: digest.description, severity: 'error', idempotencyKey: key, subjectLabel: 'Profitability Scorecard' });
  if (!delivered) { console.log('Owner digest: email not delivered; items stay unsent and retry next run.'); process.exitCode = 1; return; }
  markSent({ pending, archive }, items);
  const now = new Date().toISOString();
  archive.lastUpdated = now;
  write(ARCHIVE, archive);
  if (items.some((i) => i.id.startsWith('pending:'))) { pending.lastUpdated = now; write(PENDING, pending); }
  console.log(`Owner digest: sent and marked ${items.length} item(s).`);
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
