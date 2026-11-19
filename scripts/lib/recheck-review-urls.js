'use strict';
/**
 * recheck-review-urls.js core (BRO-7841): re-test the urls of recently published reviews and withhold
 * the link of any an outlet has pulled (404/410 on two probes). Pure orchestration with an injected probe,
 * so the test replays real decisions without the network.
 */
const fs = require('fs');
const path = require('path');
const { decideRecheck, applyDecision, withinRecheckWindow, urlDeadActive } = require('./review-url-dead');

function listCandidates(reviewTextsDir, { now, hours, onlyShow } = {}) {
  const out = [];
  const { listShowDirs } = require('./list-show-dirs');
  for (const show of listShowDirs(reviewTextsDir, { silent: true, skipHolding: true })) {
    if (onlyShow && show !== onlyShow) continue;
    const dir = path.join(reviewTextsDir, show);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      const file = path.join(dir, f);
      let rec;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!rec || !rec.url || !/^https?:\/\//i.test(rec.url)) continue;
      if (!withinRecheckWindow(rec.publishDate, now, hours) && !urlDeadActive(rec)) continue;
      out.push({ show, f, file, rec });
    }
  }
  return out;
}

/** probe(url) -> HTTP status number, or null when the request failed or was blocked. */
async function recheck({ reviewTextsDir, probe, apply = false, now = Date.now(), hours, onlyShow, budgetMs = 240000, log = () => {} }) {
  const started = Date.now();
  const cands = listCandidates(reviewTextsDir, { now, hours, onlyShow });
  const marked = []; const restored = []; let checked = 0;
  for (const c of cands) {
    if (Date.now() - started > budgetMs) { log(`budget reached after ${checked}/${cands.length}`); break; }
    const first = await probe(c.rec.url);
    let statuses = [first];
    // A second probe only when the first looks dead or the record is already withheld: one 404 is never enough.
    if (first === 404 || first === 410 || urlDeadActive(c.rec)) statuses.push(await probe(c.rec.url));
    checked++;
    const decision = decideRecheck(c.rec, statuses);
    if (decision.action === 'mark' || decision.action === 'restore') {
      const entry = { show: c.show, file: c.f, url: c.rec.url, outlet: c.rec.outletId, status: statuses.join(',') };
      (decision.action === 'mark' ? marked : restored).push(entry);
      if (apply) {
        applyDecision(c.rec, decision, new Date(now).toISOString());
        fs.writeFileSync(c.file, JSON.stringify(c.rec, null, 2) + '\n');
      }
    }
  }
  return { checked, candidates: cands.length, marked, restored };
}

module.exports = { recheck, listCandidates };
