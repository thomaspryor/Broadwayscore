'use strict';
/**
 * Morning-after import of an opening-night lane recording into the private repo (BRO-6663).
 *
 * The lane encrypts the pages it reads (opening-night-lane/fetch-recording.js) into a workflow artifact that expires in 30 to 90 days, with a
 * key that may be derived from a rotating token. This turns one recording into a durable plaintext copy for the private
 * repo, which the recorded-night loader (recording-night.js) replays with no key:
 *
 *   <root>/<show>/<night>/<kind>/{fetches.jsonl, pages/<sha>.html.gz, meta.json}     kind: recording | shadow
 *
 * The pages are copyrighted and the Broadwayscore repo is public. Nothing here prints a page, and the CLI only writes
 * to a directory outside the public worktree or a git-ignored one (assertPrivateDest). Errors name a url and a hash,
 * never page text.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { decrypt, keyFromEnv, KEY_VERSION } = require('../opening-night-lane/fetch-recording');
const { loadRecording, replayFetchFrom } = require('./recording-night');

const MAX_NIGHT_BYTES = 10 * 1024 * 1024; // stored (gzipped) bytes per show/night/kind
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // stored bytes under the whole root
const KEEP_NIGHTS = 8; // newest nights kept per show
const KINDS = ['recording', 'shadow'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** `key:<v>` / `token:<v>` -> the key the lane derives for that secret (fetch-recording.keyFromEnv, HKDF, versioned). */
const keyFor = (entry) => {
  const i = entry.indexOf(':');
  return keyFromEnv(entry.slice(0, i) === 'key' ? { LANE_RECORDING_KEY: entry.slice(i + 1) } : { REVIEW_TEXTS_TOKEN: entry.slice(i + 1) });
};

/**
 * Every key a recording may have been written with. LANE_RECORDING_KEY / REVIEW_TEXTS_TOKEN are the two the lane reads;
 * LANE_RECORDING_OLD_KEYS is a comma list of `key:<v>` or `token:<v>` entries for secrets since rotated.
 * @returns {{id: string, key: Buffer}[]}
 */
function candidateKeys(env = process.env) {
  const out = [];
  if (env.LANE_RECORDING_KEY) out.push({ id: 'key', key: keyFor(`key:${env.LANE_RECORDING_KEY}`) });
  if (env.REVIEW_TEXTS_TOKEN) out.push({ id: 'token', key: keyFor(`token:${env.REVIEW_TEXTS_TOKEN}`) });
  String(env.LANE_RECORDING_OLD_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((e, i) => {
    if (/^(key|token):./.test(e)) out.push({ id: `old-${i + 1}`, key: keyFor(e) });
  });
  return out;
}

/** Hash of the candidate set, so an undecryptable marker is retried only when the set of keys changes. */
const candidateSetId = (cands) => sha256(cands.map((c) => c.key.toString('hex')).sort().join(',')).slice(0, 16);

/** `lane-recording-<show>-<night>` / `lane-shadow-<show>-<night>` -> {kind, show, night}, else null. */
function parseArtifactName(name) {
  const m = /^lane-(recording|shadow)-([a-z0-9][a-z0-9-]*)-(\d{4}-\d{2}-\d{2})$/.exec(String(name || ''));
  return m ? { kind: m[1], show: m[2], night: m[3] } : null;
}

/** Directories under root holding a fetches.jsonl (an artifact zip nests them differently per upload layout). */
function findRecordingDirs(root) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name === 'fetches.jsonl') found.push(d);
      else if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'pages') walk(path.join(d, e.name));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

function dirBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}

const readMeta = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; } };
const manifest = (dir) => fs.readFileSync(path.join(dir, 'fetches.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * Import one recording. Returns {status, ...}; statuses: imported, skipped-same, skipped-smaller, no-recording,
 * no-keys, undecryptable, over-budget, error. Only `imported` writes. `error`, `undecryptable` and `over-budget` should
 * turn the workflow red; the others are expected on a normal day.
 * @param {{srcDir: string, root: string, show: string, night: string, kind: string, candidates: {id:string,key:Buffer}[], meta?: object, maxNightBytes?: number, maxTotalBytes?: number, now?: () => Date}} o
 */
function importRecording({ srcDir, root, show, night, kind, candidates, meta = {}, maxNightBytes = MAX_NIGHT_BYTES, maxTotalBytes = MAX_TOTAL_BYTES, now = () => new Date() }) {
  if (!KINDS.includes(kind)) return { status: 'error', detail: `unknown kind ${kind}` };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(show)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(night))) return { status: 'error', detail: 'show or night is not a plain id' };
  const dirs = findRecordingDirs(srcDir);
  if (!dirs.length) return { status: 'no-recording' };
  if (dirs.length > 1) return { status: 'error', detail: `${dirs.length} recordings in one artifact, expected 1` };
  const src = dirs[0];
  let entries;
  try { entries = manifest(src); } catch { return { status: 'error', detail: 'fetches.jsonl is not valid JSON lines' }; }

  // the manifest comes from an artifact: a sha is a path component, so only 64 hex chars count, and a symlinked page is never followed
  const head = entries.find((e) => e.header);
  if (head && head.keyVersion !== KEY_VERSION) return { status: 'error', detail: `recording was written with key version ${head.keyVersion}, this importer derives version ${KEY_VERSION}` };
  if (entries.some((e) => e.sha && !/^[0-9a-f]{64}$/.test(String(e.sha)))) return { status: 'error', detail: 'fetches.jsonl has a malformed sha' };
  const shas = [...new Set(entries.filter((e) => e.sha).map((e) => e.sha))];
  const isPlainFile = (f) => { try { return fs.lstatSync(f).isFile(); } catch { return false; } };
  const stored = shas.filter((s) => isPlainFile(path.join(src, 'pages', `${s}.enc`)));
  const droppedBodies = shas.length - stored.length;

  let chosen = null;
  if (!stored.length) chosen = { id: 'none', key: null };
  else {
    if (!candidates.length) return { status: 'no-keys' };
    const blobs = stored.map((s) => [s, fs.readFileSync(path.join(src, 'pages', `${s}.enc`))]);
    chosen = candidates.find((c) => { try { blobs.forEach(([, b]) => decrypt(c.key, b)); return true; } catch { return false; } }) || null;
    if (!chosen) return { status: 'undecryptable', tried: candidates.map((c) => c.id), candidateSet: candidateSetId(candidates) };
  }

  const dest = path.join(root, show, night, kind);
  const prior = readMeta(dest);
  if (prior && meta.artifactId != null && String(prior.artifactId) === String(meta.artifactId)) return { status: 'skipped-same' };
  if (prior && prior.pages > stored.length) return { status: 'skipped-smaller', detail: `archived ${prior.pages} pages, artifact has ${stored.length}` };

  const tmp = `${dest}.importing`;
  const abort = (result) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    // drop the empty show/night dirs the staging dir created, so a refused import leaves nothing behind
    for (let d = path.dirname(tmp); d.startsWith(root) && d !== root; d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
    return result;
  };
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'pages'), { recursive: true });
  let storedBytes = 0;
  for (const sha of stored) {
    let body;
    try { body = decrypt(chosen.key, fs.readFileSync(path.join(src, 'pages', `${sha}.enc`))); } catch { return abort({ status: 'error', detail: `page ${sha} failed to decrypt` }); }
    if (sha256(body) !== sha) return abort({ status: 'error', detail: `page ${sha} does not match its hash` });
    const gz = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
    storedBytes += gz.length;
    fs.writeFileSync(path.join(tmp, 'pages', `${sha}.html.gz`), gz);
  }
  if (storedBytes > maxNightBytes) return abort({ status: 'over-budget', detail: `${storedBytes} bytes > ${maxNightBytes} per night`, storedBytes });
  const others = dirBytes(root) - dirBytes(dest) - dirBytes(tmp); // the staged pages are already inside root
  if (others + storedBytes > maxTotalBytes) return abort({ status: 'over-budget', detail: `${others + storedBytes} bytes > ${maxTotalBytes} total`, storedBytes });

  fs.copyFileSync(path.join(src, 'fetches.jsonl'), path.join(tmp, 'fetches.jsonl'));
  const withNote = entries.filter((e) => e.sha && e.note).length;
  fs.writeFileSync(path.join(tmp, 'meta.json'), `${JSON.stringify({
    format: 1, show, night, kind, ...meta, keyId: chosen.id, pages: stored.length, droppedBodies, entries: entries.length,
    entriesWithoutBody: withNote, storedBytes, importedAt: now().toISOString(),
  }, null, 2)}\n`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(tmp, dest);
  return { status: 'imported', pages: stored.length, storedBytes, keyId: chosen.id, replaced: !!prior };
}

/**
 * Keep the newest `keep` nights per show, then drop the oldest nights across all shows until the archive fits
 * `maxTotalBytes`, so the total budget cannot go permanently red as shows pile up. Returns the removed `show/night` names.
 */
function applyRetention(root, keep = KEEP_NIGHTS, maxTotalBytes = MAX_TOTAL_BYTES) {
  const removed = [];
  if (!fs.existsSync(root)) return removed;
  const all = [];
  for (const show of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_'))) {
    const nights = fs.readdirSync(path.join(root, show.name), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.endsWith('.importing')).map((e) => e.name).sort();
    for (const n of nights.slice(0, Math.max(0, nights.length - keep))) {
      fs.rmSync(path.join(root, show.name, n), { recursive: true, force: true });
      removed.push(`${show.name}/${n}`);
    }
    for (const n of nights.slice(Math.max(0, nights.length - keep))) all.push({ show: show.name, night: n });
  }
  all.sort((a, b) => a.night.localeCompare(b.night) || a.show.localeCompare(b.show));
  while (all.length > 1 && dirBytes(root) > maxTotalBytes) {
    const o = all.shift();
    fs.rmSync(path.join(root, o.show, o.night), { recursive: true, force: true });
    removed.push(`${o.show}/${o.night}`);
  }
  return removed;
}

/**
 * Replay check for every archived night: the loader serves each recorded fetch, at its recorded offset, the body that
 * was recorded. Advisory (does not arm the lane). Failure details are urls and counts only.
 * @returns {{nights: object[], failures: {night: string, detail: string}[]}}
 */
async function verifyArchive(root) {
  const nights = [];
  const failures = [];
  if (!fs.existsSync(root)) return { nights, failures };
  for (const show of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const n of fs.readdirSync(path.join(root, show.name), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.endsWith('.importing'))) {
      for (const kind of KINDS) {
        const dir = path.join(root, show.name, n.name, kind);
        if (!fs.existsSync(path.join(dir, 'fetches.jsonl'))) continue;
        const label = `${show.name}/${n.name}/${kind}`;
        const row = { night: label, fetches: 0, replayed: 0, noBody: 0 };
        try {
          const rec = loadRecording(dir);
          let clock = 0;
          const replay = replayFetchFrom(rec, { now: () => clock, startMs: 0 });
          for (const e of rec.entries) {
            if (e.status !== 'ok' || e.kind === 'date-check' || !e.url) continue;
            row.fetches++;
            if (e.note) { row.noBody++; continue; }
            clock = e.t;
            const r = await replay(e.url);
            if (r && r.content !== undefined && sha256(String(r.content)) === e.sha) row.replayed++;
            else failures.push({ night: label, detail: `replay of ${e.url} did not return the recorded body` });
          }
        } catch (err) {
          failures.push({ night: label, detail: `loader failed: ${String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 120)}` });
        }
        nights.push(row);
      }
    }
  }
  return { nights, failures };
}

/**
 * Plaintext pages may only land outside the public worktree, or in a git-ignored path inside it.
 * @throws if dest is inside a git worktree and not ignored
 */
function assertPrivateDest(dest, cwd = process.cwd()) {
  const abs = path.resolve(dest);
  fs.mkdirSync(abs, { recursive: true });
  let top = null;
  try { top = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not in a repo */ }
  if (!top) return abs;
  let repoTop = null;
  try { repoTop = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* cwd outside a repo */ }
  if (!repoTop || fs.realpathSync(top) !== fs.realpathSync(repoTop)) return abs; // a different repo: the private clone
  try { execFileSync('git', ['-C', abs, 'check-ignore', '-q', abs], { stdio: 'ignore' }); } catch {
    throw new Error(`refusing to write plaintext pages to ${abs}: inside the public worktree and not git-ignored`);
  }
  return abs;
}

module.exports = {
  MAX_NIGHT_BYTES, MAX_TOTAL_BYTES, KEEP_NIGHTS, candidateKeys, candidateSetId, parseArtifactName, findRecordingDirs,
  importRecording, applyRetention, verifyArchive, assertPrivateDest, dirBytes,
};
