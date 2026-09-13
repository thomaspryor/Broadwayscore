#!/usr/bin/env node
'use strict';
/**
 * Thin CLI over scripts/lib/push-diagnostics.js so push-with-retry.sh (bash)
 * can use its redaction/classification without a bash reimplementation.
 * See push-diagnostics.js's header for why this exists (BRO-3213).
 *
 * Usage:
 *   node scripts/push-diagnostics-cli.js classify <trace-file>
 *   node scripts/push-diagnostics-cli.js redact-tail <trace-file> [maxBytes]
 */
const fs = require('fs');
const { redactCurlTrace, classifyStallPhase } = require('./lib/push-diagnostics.js');

const [, , cmd, file, maxBytesArg] = process.argv;

function readTraceFile(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

if (cmd === 'classify') {
  process.stdout.write(classifyStallPhase(readTraceFile(file)));
} else if (cmd === 'redact-tail') {
  const maxBytes = Number(maxBytesArg) || 2000;
  const redacted = redactCurlTrace(readTraceFile(file));
  process.stdout.write(redacted.length > maxBytes ? redacted.slice(-maxBytes) : redacted);
} else {
  console.error('Usage: push-diagnostics-cli.js classify|redact-tail <trace-file> [maxBytes]');
  process.exit(2);
}
