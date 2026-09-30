'use strict';
// Keyed-union merge for data/retired-show-ids.json and data/deleted-shows.json
// (BRO-4398). Both are append-only arrays of records keyed by show `id`,
// written by retireId() in scripts/lib/retired-show-ids.js. Until BRO-4398
// only human sessions wrote them; execute-approved-fix.yml's retire-show
// action is the first CI writer, so a push race with a local retirement
// must not fall to `-X ours` and drop the other side's entry (a dropped
// registry entry lets a retired id come back).
//
// Merge rule: union by id, `ours` wins on a both-present id (retireId
// refuses to retire an id twice, so a both-present id is the same record),
// order = ours, then remote-only entries in remote order.

function mergeRetiredRecords(ours, remote) {
  const o = Array.isArray(ours) ? ours : [];
  const r = Array.isArray(remote) ? remote : [];
  const seen = new Set(o.map(e => e && e.id).filter(Boolean));
  const merged = [...o];
  let added = 0;
  for (const e of r) {
    const id = e && e.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(e);
    added++;
  }
  return { merged, stats: { added, kept: o.length, total: merged.length } };
}

module.exports = { mergeRetiredRecords };
