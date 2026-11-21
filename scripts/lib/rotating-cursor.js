'use strict';
// BRO-7931 #2: persist-and-rotate cursor so a time-budgeted run over an
// unbounded show list resumes where the last one stopped instead of always
// re-walking the same first ~350 shows (521 of 819 were never reached).
const fs = require('fs');
const path = require('path');

function loadCursor(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveCursor(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
// Rotate `ids` so iteration starts AFTER lastId. Unknown/absent lastId = no rotation.
// `ids` must be in a stable order independent of list membership (callers sort),
// so a cursor whose show later left the list still resumes at the next id.
function rotateAfter(ids, lastId) {
  if (!lastId) return ids.slice();
  const i = ids.findIndex(id => id > lastId);
  if (i < 0) return ids.slice();      // cursor past the end: pass complete, restart
  return ids.slice(i).concat(ids.slice(0, i));
}
module.exports = { loadCursor, saveCursor, rotateAfter };
