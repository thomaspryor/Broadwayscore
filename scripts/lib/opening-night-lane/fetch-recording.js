'use strict';
/**
 * Records the aggregator and index pages a lane pass reads, so a real night can be replayed with its real timing
 * (BRO-6651, plan v2 Step 8; loader: lane-recorded-nights/recording-night.js).
 *
 * Wraps the lane's DISCOVERY fetchText only. Inline review fetches for scoring never pass through here, but a discovery step that
 * opens an article itself (the Google News unwrap) does, and that body is recorded (encrypted) like any other page.
 *
 * The repo is public, so a workflow artifact is not private and the pages are copyrighted: every page body is
 * AES-256-GCM encrypted before it touches disk, and with no key the recorder is off (fail closed, never plaintext).
 * The manifest carries only urls, hashes, sizes and timings. A date-check fetch (an outlet article read for its
 * publish date) keeps the date, not the page.
 *
 * Layout under `dir`:  fetches.jsonl (one line per fetch)  and  pages/<sha256 of body>.enc (written once per body,
 * so a page unchanged between passes costs one manifest line). Caps: maxPageBytes per body, maxRunBytes per run; past
 * either the manifest still records the fetch ('oversize' / 'capped'), only the body is dropped. maxRunBytes counts stored (gzipped,
 * encrypted) bytes; a changed body of a URL stored recently is 'throttled' (see THROTTLE_TIERS).
 *
 * Never throws into the lane: every fs error is counted in stats().errors. Sync fs throughout, because adapters fetch
 * in parallel and the byte cap and dedupe set must not race. A leaf: requires nothing from the lane.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const MAX_PAGE_BYTES = 2 * 1024 * 1024; // raw (uncompressed) bytes per body
// BRO-7247: the run cap counts STORED bytes (gzip, then AES), not raw. The 40 MiB raw cap was spent at 02:49Z on Blueberries night,
// 11 min before the 03:00Z embargo (3690 of 6065 fetches had no body); the whole night is 537 MiB raw, ~90 MiB gzipped. 24 MiB stored
// is the hard ceiling and matches the import budget (recording-import.js MAX_NIGHT_BYTES): a night over it is refused whole at import.
const MAX_RUN_BYTES = 24 * 1024 * 1024;
const MAX_GUNZIP_BYTES = 4 * MAX_PAGE_BYTES;
// Per-URL spacing between stored versions, by how much of the run cap is used. A fresh budget keeps every changed body (the minutes
// around the embargo); as it drains, a URL's changed body is stored less often, so the cap lasts the night instead of ending at a cliff.
// A throttled fetch stays in the manifest pointing at that URL's last stored body (note 'throttled'), so replay serves a slightly
// stale page rather than failing.
const THROTTLE_TIERS = [{ upTo: 0.4, gapMs: 0 }, { upTo: 0.6, gapMs: 5 * 60000 }, { upTo: 0.8, gapMs: 10 * 60000 }, { upTo: Infinity, gapMs: 20 * 60000 }];
function gapMsFor(usedFraction) {
  return THROTTLE_TIERS.find((t) => usedFraction < t.upTo).gapMs;
}

const KEY_VERSION = 1;
const KEY_SALT = `broadwayscore/lane-recording/v${KEY_VERSION}`;

/**
 * 32-byte key via HKDF-SHA256 with a fixed, versioned salt (bump KEY_VERSION to change derivation; the manifest header
 * records it). Source: LANE_RECORDING_KEY, else REVIEW_TEXTS_TOKEN (a different `info` label, so the two never collide).
 */
function keyFromEnv(env = process.env) {
  const [secret, info] = env.LANE_RECORDING_KEY ? [env.LANE_RECORDING_KEY, 'key'] : env.REVIEW_TEXTS_TOKEN ? [env.REVIEW_TEXTS_TOKEN, 'token'] : [null, null];
  return secret ? Buffer.from(crypto.hkdfSync('sha256', secret, KEY_SALT, `lane-recording:${info}`, 32)) : null;
}

function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/** Page text -> bytes to encrypt: gzip (BRO-7247). decrypt() tells gzip from legacy raw text by the 1f 8b magic, which UTF-8 text never starts with (0x8b cannot follow 0x1f as a lead byte). */
const pack = (text) => zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 });

function decrypt(key, buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  const plain = Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  if (plain.length > 1 && plain[0] === 0x1f && plain[1] === 0x8b) return zlib.gunzipSync(plain, { maxOutputLength: MAX_GUNZIP_BYTES }).toString('utf8');
  return plain.toString('utf8');
}

/**
 * @param {object} p
 * @param {string} p.dir - recording directory (created on first write)
 * @param {Buffer|null} p.key - 32 bytes, from keyFromEnv; null turns recording off
 * @param {() => number} [p.now] - the lane's clock (virtual in a replay): `t` is ms since the first fetch
 * @param {(html: string) => string|null} [p.dateOf] - publish date of an article page, for date-check fetches
 */
function createFetchRecorder({ dir, key, now = Date.now, dateOf = () => null, maxPageBytes = MAX_PAGE_BYTES, maxRunBytes = MAX_RUN_BYTES } = {}) {
  const enabled = !!(dir && key && key.length === 32);
  const stats = { fetches: 0, bodies: 0, deduped: 0, bytes: 0, rawBytes: 0, oversize: 0, throttled: 0, errors: 0, capped: false };
  const lastStored = new Map(); // url -> { at, sha, bytes } of its newest stored body
  const written = new Set();
  let t0 = null;
  let ready = false;
  let headed = false;

  const append = (line) => {
    try {
      if (!ready) { fs.mkdirSync(path.join(dir, 'pages'), { recursive: true }); ready = true; }
      if (!headed) { fs.appendFileSync(path.join(dir, 'fetches.jsonl'), `${JSON.stringify({ header: true, keyVersion: KEY_VERSION })}\n`); headed = true; }
      fs.appendFileSync(path.join(dir, 'fetches.jsonl'), `${JSON.stringify(line)}\n`);
    } catch { stats.errors++; }
  };

  function store(content, url, at) {
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    const bytes = Buffer.byteLength(content);
    if (written.has(sha)) { stats.deduped++; return { sha, bytes }; }
    if (bytes > maxPageBytes) { stats.oversize++; return { sha, bytes, note: 'oversize' }; }
    const last = lastStored.get(url);
    if (last && Number.isFinite(at) && at >= last.at && at - last.at < gapMsFor(stats.bytes / maxRunBytes)) {
      stats.throttled++;
      return { sha: last.sha, bytes: last.bytes, note: 'throttled', actualSha: sha, actualBytes: bytes };
    }
    if (stats.bytes >= maxRunBytes) { stats.capped = true; return { sha, bytes, note: 'capped' }; } // no compression CPU once full
    let blob;
    try { blob = encrypt(key, pack(content)); } catch { stats.errors++; return { sha, bytes, note: 'write-failed' }; }
    if (stats.bytes + blob.length > maxRunBytes) {
      if (!stats.capped) { stats.capped = true; append({ capped: true, atBytes: stats.bytes }); }
      return { sha, bytes, note: 'capped' };
    }
    try {
      const file = path.join(dir, 'pages', `${sha}.enc`);
      if (!ready) { fs.mkdirSync(path.join(dir, 'pages'), { recursive: true }); ready = true; }
      if (!fs.existsSync(file)) fs.writeFileSync(file, blob);
      written.add(sha); stats.bodies++; stats.bytes += blob.length; stats.rawBytes += bytes;
      lastStored.set(url, { at, sha, bytes });
    } catch { stats.errors++; return { sha, bytes, note: 'write-failed' }; }
    return { sha, bytes };
  }

  /** Wrap a fetchText(url, opts). opts.recordAs === 'date-check' marks an article read for its publish date only. */
  function wrapFetchText(fetchText) {
    if (!enabled) return fetchText;
    return async (url, opts) => {
      const start = now();
      if (t0 === null) t0 = start;
      const dateCheck = !!opts && opts.recordAs === 'date-check';
      const line = { t: start - t0, at: Number.isFinite(start) ? new Date(start).toISOString() : null, url, ...(dateCheck ? { kind: 'date-check' } : {}) };
      stats.fetches++;
      try {
        const res = await fetchText(url, opts);
        const content = res && typeof res === 'object' ? res.content : res;
        const finalUrl = res && typeof res === 'object' ? res.finalUrl || null : null;
        // How the page was fetched (fetchPage's source, or the Browserbase route's via): replay needs it so the lane's
        // paywall rule, which applies only to scraped copies, judges a replayed page as it judged the live one (BRO-6872).
        const source = res && typeof res === 'object' ? res.source || res.via || null : null;
        try {
          if (dateCheck) append({ ...line, status: 'ok', publishDate: dateOf(content) || null, settledMs: now() - start });
          else append({ ...line, status: 'ok', ...(finalUrl ? { finalUrl } : {}), ...(source ? { source: String(source) } : {}), ...store(String(content), url, start), settledMs: now() - start });
        } catch { stats.errors++; }
        return res;
      } catch (e) {
        append({ ...line, status: 'error', error: String((e && e.message) || e).slice(0, 200), ...(e && e.status ? { httpStatus: e.status } : {}), settledMs: now() - start });
        throw e;
      }
    };
  }

  return { enabled, wrapFetchText, stats: () => ({ ...stats }) };
}

module.exports = { createFetchRecorder, keyFromEnv, decrypt, gapMsFor, KEY_VERSION, MAX_PAGE_BYTES, MAX_RUN_BYTES };
