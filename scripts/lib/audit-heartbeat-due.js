'use strict';
/**
 * BRO-8357: should a rebuild commit an audit report on a run that changed no reviews?
 * A report whose only change is `generatedAt` is a heartbeat: commit it once the committed copy
 * is older than maxAgeHours (the digest warns at 36h), not on every run. Any other change commits.
 */
function heartbeatDue(committedJson, currentJson, now = new Date(), maxAgeHours = 12) {
  let cur;
  try { cur = JSON.parse(currentJson); } catch { return false; }
  let old = null;
  try { old = JSON.parse(committedJson); } catch { return true; }
  const strip = (o) => JSON.stringify({ ...o, generatedAt: null });
  if (strip(old) !== strip(cur)) return true;
  const at = old && old.generatedAt ? new Date(old.generatedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return true;
  return (now - at) / 3600000 > maxAgeHours;
}
module.exports = { heartbeatDue };
if (require.main === module) {
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const file = process.argv[2];
  let committed = '';
  try { committed = execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { /* untracked: due */ }
  process.exit(heartbeatDue(committed, fs.readFileSync(file, 'utf8')) ? 0 : 1);
}
