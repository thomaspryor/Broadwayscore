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
function rotateAfter(ids, lastId) {
  const i = lastId ? ids.indexOf(lastId) : -1;
  if (i < 0) return ids.slice();
  return ids.slice(i + 1).concat(ids.slice(0, i + 1));
}
module.exports = { loadCursor, saveCursor, rotateAfter };
