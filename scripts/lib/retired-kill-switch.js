'use strict';
// A kill-switch file whose content starts with "RETIRED:" marks a job that was
// switched off on purpose for good (BRO-4638: the Mac opening-night monitor,
// replaced by the cloud opening-night Routines). The launcher exits quietly on
// it and skips the stale-kill-switch pager, which exists to catch a switch
// left on BY ACCIDENT. Any other content (or an empty file) is an ordinary
// temporary disable and still pages after 24h. Deleting the file un-retires.

const fs = require('fs');

const RETIRED_PREFIX = 'RETIRED:';

function isRetiredMarker(text) {
  return typeof text === 'string' && text.trimStart().startsWith(RETIRED_PREFIX);
}

// Returns the marker's first line, or null. A missing or unreadable file is
// null, so a read error falls back to the ordinary kill-switch path (and its
// pager) instead of going silent.
function readRetiredMarker(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8').slice(0, 512); } catch { return null; }
  return isRetiredMarker(text) ? text.trim().split('\n')[0] : null;
}

module.exports = { RETIRED_PREFIX, isRetiredMarker, readRetiredMarker };
