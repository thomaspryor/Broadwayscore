#!/usr/bin/env node

/**
 * Recovery Marker — Set/clear/check a hold marker that gates broadcast workflows
 *
 * During bulk data operations (Sprint 2 score backfills, large rebuilds, etc.)
 * the opening-night-broadcast workflow can fire mid-mutation and email ~1,400
 * subscribers with intermediate / corrupted scores. This marker file gives
 * backfill scripts a safe way to pause broadcasts without touching workflow code.
 *
 * Marker file: data/audit/recovery-active.marker
 * Schema: { activeUntil: ISO-string, reason: string, setAt: ISO-string, setBy: string }
 *
 * Usage:
 *   node scripts/recovery-marker.js set --hours=4 --reason="Sprint 2 score backfill"
 *   node scripts/recovery-marker.js check          # exit 1 if hold active, exit 0 if clear
 *   node scripts/recovery-marker.js clear          # remove marker (idempotent)
 *
 * Workflow integration:
 *   The opening-night-broadcast.yml reads this file at job start and sets
 *   BROADCAST_HOLD_ACTIVE=true in GITHUB_ENV, which gates the send step.
 */

const fs = require('fs');
const path = require('path');

const MARKER_PATH = path.resolve(__dirname, '..', 'data', 'audit', 'recovery-active.marker');

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flags = {};
  for (const arg of args.slice(1)) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : true;
  }
  return { cmd, flags };
}

function cmdSet(flags) {
  const hours = parseFloat(flags.hours);
  if (!hours || isNaN(hours) || hours <= 0) {
    console.error('Error: --hours=<N> required (positive number)');
    process.exit(1);
  }
  const reason = flags.reason;
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    console.error('Error: --reason=<string> required');
    process.exit(1);
  }

  const now = new Date();
  const activeUntil = new Date(now.getTime() + hours * 3600 * 1000);

  const marker = {
    activeUntil: activeUntil.toISOString(),
    reason: reason.trim(),
    setAt: now.toISOString(),
    setBy: 'recovery-marker.js',
  };

  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2) + '\n');
  console.log(`Recovery hold set: active until ${activeUntil.toISOString()} (${hours}h)`);
  console.log(`Reason: ${reason}`);
  console.log(`Marker: ${MARKER_PATH}`);
}

function cmdClear() {
  if (fs.existsSync(MARKER_PATH)) {
    fs.unlinkSync(MARKER_PATH);
    console.log('Recovery hold cleared.');
  } else {
    console.log('No recovery hold marker present (already clear).');
  }
}

function cmdCheck() {
  if (!fs.existsSync(MARKER_PATH)) {
    console.log('BROADCAST_HOLD: inactive (no marker file)');
    process.exit(0);
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
  } catch (e) {
    console.log('BROADCAST_HOLD: inactive (marker file unreadable — treating as absent)');
    process.exit(0);
  }

  const now = new Date();
  const activeUntil = new Date(marker.activeUntil);

  if (activeUntil <= now) {
    console.log(`BROADCAST_HOLD: expired (was active until ${marker.activeUntil}, reason: ${marker.reason})`);
    process.exit(0);
  }

  const remainingMs = activeUntil - now;
  const remainingMin = Math.ceil(remainingMs / 60000);
  console.log(`BROADCAST_HOLD: ACTIVE — expires in ${remainingMin} min (${marker.activeUntil})`);
  console.log(`Reason: ${marker.reason}`);
  console.log(`Set at: ${marker.setAt} by ${marker.setBy}`);
  process.exit(1);
}

const { cmd, flags } = parseArgs();

switch (cmd) {
  case 'set':
    cmdSet(flags);
    break;
  case 'clear':
    cmdClear();
    break;
  case 'check':
    cmdCheck();
    break;
  default:
    console.error('Usage: recovery-marker.js <set|clear|check> [--hours=N] [--reason=string]');
    process.exit(1);
}
