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
  summarizeTrace2Children,
  extractTrace2Timeline,
  formatTrace2Timeline,
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
  // Format-agnostic (pure text redact+truncate), so this same command also
  // serves GIT_TRACE2_PERF captures (BRO-3358) — no trace2-specific variant
  // needed.
  const maxBytes = Number(maxBytesArg) || 2000;
  const redacted = redactCurlTrace(readTraceFile(file));
  process.stdout.write(redacted.length > maxBytes ? redacted.slice(-maxBytes) : redacted);
} else if (cmd === 'trace2-summary') {
  // BRO-3358. Usage: trace2-summary <trace2-file> [killedAt HH:MM:SS.frac]
  // One shellout covering both halves of the answer: which child process (if
  // any) was still running when the kill hit, and where the terminal silence
  // falls relative to the last logged trace2 line.
  //
  // redactCurlTrace runs on the RAW text BEFORE parsing, not just on the
  // separate redact-tail dump below — every downstream field (child argv,
  // event data) is derived from this same string, so redacting once here is
  // what actually makes the "route everything through the redactor as
  // defense-in-depth" comment on push-diagnostics.js's redactTrace2 export
  // true, rather than just documented intent. Adversarial review (Codex,
  // BRO-3358 ship-check) caught an earlier draft that redacted the tail dump
  // but printed unredacted argv here — git's own native URL-userinfo
  // redaction is real but only covers ONE credential shape.
  const traceText = redactCurlTrace(readTraceFile(file));
  const children = summarizeTrace2Children(traceText);
  const timeline = extractTrace2Timeline({ traceText, killedAt: maxBytesArg });
  const lines = [formatTrace2Timeline(timeline, children)];
  for (const c of children) {
    lines.push(
      `  child [${c.id}] depth=${c.depth}: ${c.argv}` +
        (c.inFlightAtEnd
          ? ' — NO child_exit OBSERVED (still running, or its exit landed past a truncated capture)'
          : ` (${(c.durationMs / 1000).toFixed(3)}s)`)
    );
  }
  process.stdout.write(lines.join('\n'));
} else {
  console.error(
    'Usage: push-diagnostics-cli.js classify|service|census|timeline|redact-tail|trace2-summary <trace-file> [maxBytes|killedAt]'
  );
  process.exit(2);
}
