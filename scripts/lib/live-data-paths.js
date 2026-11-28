'use strict';
// live-data-paths.js (BRO-7101) — pure path rules shared by the runtime tracer
// (live-data-read-hook.mjs / -loader.mjs) and scripts/live-data-lane.js.
const path = require('node:path');

/** `<root>/data/...` absolute path -> 'data/...' (posix), else null. */
function liveDataRelPath(abs, root) {
  const rel = path.relative(path.join(root, 'data'), abs);
  if (rel === '') return 'data';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `data/${rel.split(path.sep).join('/')}`;
}

/**
 * Did this caller file (repo-relative, posix) read on the test's own behalf?
 * The test file itself, a sibling test helper under tests/, or any *.test.* file.
 */
function isTestCaller(callerRel, testRel) {
  if (!callerRel) return false;
  if (callerRel === testRel) return true;
  if (callerRel.startsWith('tests/')) return true;
  return /\.test\.[cm]?[jt]sx?$/.test(callerRel);
}

module.exports = { liveDataRelPath, isTestCaller };

// ---------------------------------------------------------------------------
// Lane declaration (BRO-7101). A test file is in the LIVE-DATA lane, which runs
// in check-corpus-drift.yml and never blocks main, when it carries the marker
// in its first MARKER_SCAN_LINES lines, or its name ends -live-data.test.*
// (the BRO-5729 convention). Everything else the collector finds is BLOCKING.
// The declaration lives in the test file itself, so parallel sessions never
// edit a shared list.
const MARKER = 'LIVE-DATA-LANE:';
const MARKER_SCAN_LINES = 40;
const LIVE_NAME_RE = /-live-data\.test\.[cm]?[jt]sx?$/;

/** PURE. Does this file text carry the LIVE-DATA-LANE marker near the top? */
function hasLaneMarker(text) {
  const head = String(text).split('\n', MARKER_SCAN_LINES);
  return head.some((l) => /^\s*(\/\/|\*|\/\*|#)\s*LIVE-DATA-LANE:/.test(l));
}

/** PURE. Is the file declared live (marker or -live-data name)? */
function isDeclaredLive(rel, text) {
  return LIVE_NAME_RE.test(rel) || hasLaneMarker(text);
}

/** Reads the file under root; a missing/unreadable file is not declared live. */
function isDeclaredLiveFile(rel, root) {
  if (LIVE_NAME_RE.test(rel)) return true;
  try { return hasLaneMarker(require('node:fs').readFileSync(path.join(root, rel), 'utf8')); } catch { return false; }
}

module.exports.MARKER = MARKER;
module.exports.MARKER_SCAN_LINES = MARKER_SCAN_LINES;
module.exports.LIVE_NAME_RE = LIVE_NAME_RE;
module.exports.hasLaneMarker = hasLaneMarker;
module.exports.isDeclaredLive = isDeclaredLive;
module.exports.isDeclaredLiveFile = isDeclaredLiveFile;
