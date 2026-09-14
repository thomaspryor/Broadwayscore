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
const {
  redactCurlTrace,
  classifyStallPhase,
  classifyStallService,
  censusTrace,
  extractPhaseTimeline,
  formatTimeline,
} = require('./lib/push-diagnostics.js');

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
} else if (cmd === 'service') {
  // BRO-2839: reported SEPARATELY from classify so the phase string's value
  // space (asserted by push-with-retry.stall-diagnostics.test.sh and
  // documented in push-ledger.js) stays exactly as BRO-3213 defined it.
  process.stdout.write(classifyStallService(readTraceFile(file)));
} else if (cmd === 'census') {
  // BRO-2839: whole-file provenance in one line. classify reads the entire
  // trace but only its last 2000 bytes were ever logged, so a CI failure could
  // only be inspected through a keyhole — two runs showed nothing but
  // upload-pack response headers with no way to tell whether receive-pack
  // traffic existed earlier in the same file.
  const c = censusTrace(readTraceFile(file));
  process.stdout.write(
    `bytes=${c.bytes} records=${c.records} receive-pack=${c.receivePack} ` +
      `upload-pack=${c.uploadPack} span=${c.firstStamp || '-'}..${c.lastStamp || '-'}\n` +
      (c.requests.length
        ? c.requests.map((r) => `  request: ${r}`).join('\n') + '\n'
        : '  request: (none in captured range)\n')
  );
} else if (cmd === 'timeline') {
  // Usage: timeline <trace-file> [killedAt HH:MM:SS.frac]
  // killedAt must be on the SAME wall clock as the trace's own lines.
  const timeline = extractPhaseTimeline({
    traceText: readTraceFile(file),
    killedAt: maxBytesArg,
  });
  process.stdout.write(formatTimeline(timeline));
} else if (cmd === 'redact-tail') {
  const maxBytes = Number(maxBytesArg) || 2000;
  const redacted = redactCurlTrace(readTraceFile(file));
  process.stdout.write(redacted.length > maxBytes ? redacted.slice(-maxBytes) : redacted);
} else {
  console.error(
    'Usage: push-diagnostics-cli.js classify|service|census|timeline|redact-tail <trace-file> [maxBytes|killedAt]'
  );
  process.exit(2);
}
