#!/usr/bin/env node
'use strict';
/**
 * Morning-after import of opening-night lane recordings into the private repo (BRO-6663).
 *
 *   node scripts/lane-recording-import.js --archive DIR --discover [--lookback-days=30]
 *   node scripts/lane-recording-import.js --archive DIR --from=EXTRACTED_DIR --show=ID --night=YYYY-MM-DD --kind=recording|shadow
 *   node scripts/lane-recording-import.js --archive DIR --verify
 *
 * --archive is the private clone's lane-recordings directory (or data/lane-recordings, which is git-ignored here).
 * Keys: LANE_RECORDING_KEY, REVIEW_TEXTS_TOKEN, LANE_RECORDING_OLD_KEYS (see lane-recording-import.js in lib).
 * Exit 0 ok, 1 an import failed (undecryptable for the first time, over budget, integrity), 78 no keys so nothing
 * could be read: a loud skip, never a pass. Output names shows, nights, counts and urls only, never page text.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const imp = require('./lib/lane-recorded-nights/recording-import');

/** Accepts both `--name=value` and `--name value`. */
const arg = (n, d = null) => {
  const i = process.argv.findIndex((x) => x === `--${n}` || x.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = process.argv[i];
  if (a.includes('=')) return a.slice(n.length + 3);
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const gh = (apiPath, binary = false) => execFileSync('gh', ['api', apiPath], { maxBuffer: 256 * 1024 * 1024, ...(binary ? {} : { encoding: 'utf8' }) });

/** Newest non-expired lane artifact per name from main runs inside the lookback, paging newest first. */
function discoverArtifacts({ repo, lookbackDays, ghApi = gh, now = Date.now }) {
  const cutoff = now() - lookbackDays * 86400000;
  const best = new Map();
  for (let page = 1; page <= 30; page++) {
    const rows = JSON.parse(ghApi(`repos/${repo}/actions/artifacts?per_page=100&page=${page}`)).artifacts || [];
    if (!rows.length) break;
    for (const a of rows) {
      if (a.expired || !imp.parseArtifactName(a.name)) continue;
      if (!a.workflow_run || a.workflow_run.head_branch !== 'main') continue;
      if (new Date(a.created_at).getTime() < cutoff) continue;
      const prev = best.get(a.name);
      if (!prev || a.created_at > prev.created_at) best.set(a.name, a);
    }
    if (new Date(rows[rows.length - 1].created_at).getTime() < cutoff) break;
  }
  return [...best.values()];
}

const markerFile = (root, a) => path.join(root, '_undecryptable', `${a.name}.json`);

function main() {
  const archive = arg('archive');
  if (!archive) { console.error('--archive is required'); return 1; }
  const root = imp.assertPrivateDest(archive);

  if (flag('verify')) {
    return imp.verifyArchive(root).then((v) => {
      for (const n of v.nights) console.log(`verify ${n.night}: ${n.replayed}/${n.fetches - n.noBody} bodies replayed, ${n.noBody} without a stored body`);
      for (const f of v.failures) console.log(`::warning::verify ${f.night}: ${f.detail}`);
      console.log(`verify: ${v.nights.length} nights, ${v.failures.length} failures`);
      return v.failures.length ? 1 : 0;
    });
  }

  const candidates = imp.candidateKeys();
  const candidateSet = imp.candidateSetId(candidates);
  const work = [];
  let red = 0;
  let skippedSame = 0;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-import-'));
  try {
    if (flag('discover')) {
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) { console.error('GITHUB_REPOSITORY is required for --discover'); return 1; }
      for (const a of discoverArtifacts({ repo, lookbackDays: Number(arg('lookback-days', 30)) })) {
        const dir = path.join(tmpRoot, String(a.id));
        const pn = imp.parseArtifactName(a.name);
        let archived = null;
        try { archived = JSON.parse(fs.readFileSync(path.join(root, pn.show, pn.night, pn.kind, 'meta.json'), 'utf8')); } catch { /* not archived yet */ }
        let marked = null;
        try { marked = JSON.parse(fs.readFileSync(markerFile(root, a), 'utf8')); } catch { /* none */ }
        if (archived && String(archived.artifactId) === String(a.id)) { skippedSame++; continue; } // already imported, no download
        if (marked && marked.candidateSet === candidateSet && String(marked.artifactId) === String(a.id)) { // still undecryptable: stay red, no download
          console.log(`::error::${pn.show} ${pn.night} ${pn.kind}: still undecryptable with the current keys; the artifact expires and the night is lost unless an old key is added to LANE_RECORDING_OLD_KEYS.`);
          red++;
          continue;
        }
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(`${dir}.zip`, gh(`repos/${repo}/actions/artifacts/${a.id}/zip`, true));
          execFileSync('unzip', ['-q', '-o', `${dir}.zip`, '-d', dir]);
        } catch (e) {
          console.log(`::error::${pn.show} ${pn.night} ${pn.kind}: artifact ${a.id} could not be downloaded or unzipped`);
          red++;
          continue;
        }
        work.push({ a, dir, p: imp.parseArtifactName(a.name), meta: { artifactId: a.id, artifactName: a.name, runId: a.workflow_run.id, headBranch: a.workflow_run.head_branch } });
      }
    } else if (arg('from')) {
      const p = { show: arg('show'), night: arg('night'), kind: arg('kind') };
      work.push({ a: { name: `${p.kind}-${p.show}-${p.night}` }, dir: arg('from'), p, meta: { artifactId: arg('artifact-id'), runId: arg('run-id') } });
    } else { console.error('one of --discover, --from or --verify is required'); return 1; }

    const counts = skippedSame ? { 'skipped-same': skippedSame } : {};
    let unread = 0;
    const pre = imp.applyRetention(root);
    if (pre.length) console.log(`retention removed ${pre.length} older nights before importing: ${pre.join(', ')}`);
    for (const w of work) {
      const marker = markerFile(root, w.a);
      let known = null;
      try { known = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* none */ }
      if (known && known.candidateSet === candidateSet && String(known.artifactId) === String(w.meta.artifactId)) { counts['known-undecryptable'] = (counts['known-undecryptable'] || 0) + 1; red++; continue; }
      const r = imp.importRecording({ srcDir: w.dir, root, ...w.p, candidates, meta: w.meta });
      counts[r.status] = (counts[r.status] || 0) + 1;
      const tag = `${w.p.show} ${w.p.night} ${w.p.kind}`;
      if (r.status === 'imported') {
        console.log(`imported ${tag}: ${r.pages} pages, ${r.storedBytes} bytes, key ${r.keyId}${r.replaced ? ', replaced an earlier import' : ''}`);
        fs.rmSync(marker, { force: true });
      } else if (r.status === 'undecryptable') {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, `${JSON.stringify({ artifactId: w.meta.artifactId, candidateSet: r.candidateSet, tried: r.tried, at: new Date().toISOString() })}\n`);
        console.log(`::error::${tag}: no available key decrypts this recording (tried ${r.tried.join(', ')}). Add the old key to LANE_RECORDING_OLD_KEYS; it is retried when the key set changes.`);
        red++;
      } else if (r.status === 'no-keys') {
        unread++;
      } else if (r.status === 'error' || r.status === 'over-budget') {
        console.log(`::error::${tag}: ${r.status}: ${r.detail}`);
        red++;
      } else if (r.status === 'skipped-smaller') console.log(`::warning::${tag}: kept the earlier import (${r.detail})`);
      else console.log(`${tag}: ${r.status}`);
    }
    const removed = imp.applyRetention(root);
    if (removed.length) console.log(`retention removed ${removed.length} older nights: ${removed.join(', ')}`);
    console.log(`import: ${work.length} artifacts, ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to do'}, archive ${imp.dirBytes(root)} bytes`);
    if (unread) {
      console.log(`::error::SKIPPED: ${unread} recording(s) found but no key is available (set LANE_RECORDING_KEY or REVIEW_TEXTS_TOKEN). Nothing was read; this is not a pass.`);
      return 78;
    }
    return red ? 1 : 0;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

module.exports = { discoverArtifacts };

if (require.main === module) {
  Promise.resolve().then(main).then((code) => { process.exitCode = code; }, (e) => { console.error(`::error::${String((e && e.message) || e).slice(0, 200)}`); process.exitCode = 1; });
}
