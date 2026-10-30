'use strict';
/**
 * Records the aggregator and index pages a lane pass reads, so a real night can be replayed with its real timing
 * (BRO-6651, plan v2 Step 8; loader: lane-recorded-nights/recording-night.js).
 *
 * Wraps the lane's DISCOVERY fetchText only. Review articles fetched for scoring never pass through here.
 *
 * The repo is public, so a workflow artifact is not private and the pages are copyrighted: every page body is
 * AES-256-GCM encrypted before it touches disk, and with no key the recorder is off (fail closed, never plaintext).
 * The manifest carries only urls, hashes, sizes and timings. A date-check fetch (an outlet article read for its
 * publish date) keeps the date, not the page.
 *
 * Layout under `dir`:  fetches.jsonl (one line per fetch)  and  pages/<sha256 of body>.enc (written once per body,
 * so a page unchanged between passes costs one manifest line). Caps: maxPageBytes per body, maxRunBytes per run; past
 * either the manifest still records the fetch ('oversize' / 'capped'), only the body is dropped.
 *
 * Never throws into the lane: every fs error is counted in stats().errors. Sync fs throughout, because adapters fetch
 * in parallel and the byte cap and dedupe set must not race. A leaf: requires nothing from the lane.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_RUN_BYTES = 40 * 1024 * 1024;

/** 32-byte key from LANE_RECORDING_KEY, else derived from REVIEW_TEXTS_TOKEN (a secret this repo's workflows already hold). */
function keyFromEnv(env = process.env) {
  const secret = env.LANE_RECORDING_KEY ? `key:${env.LANE_RECORDING_KEY}` : env.REVIEW_TEXTS_TOKEN ? `token:${env.REVIEW_TEXTS_TOKEN}` : null;
  return secret ? crypto.createHash('sha256').update(`lane-recording:${secret}`).digest() : null;
}

function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function decrypt(key, buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
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
  const stats = { fetches: 0, bodies: 0, deduped: 0, bytes: 0, oversize: 0, errors: 0, capped: false };
  const written = new Set();
  let t0 = null;
  let ready = false;

  const append = (line) => {
    try {
      if (!ready) { fs.mkdirSync(path.join(dir, 'pages'), { recursive: true }); ready = true; }
      fs.appendFileSync(path.join(dir, 'fetches.jsonl'), `${JSON.stringify(line)}\n`);
    } catch { stats.errors++; }
  };

  function store(content) {
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    const bytes = Buffer.byteLength(content);
    if (written.has(sha)) { stats.deduped++; return { sha, bytes }; }
    if (bytes > maxPageBytes) { stats.oversize++; return { sha, bytes, note: 'oversize' }; }
    if (stats.bytes + bytes > maxRunBytes) {
      if (!stats.capped) { stats.capped = true; append({ capped: true, atBytes: stats.bytes }); }
      return { sha, bytes, note: 'capped' };
    }
    try {
      const file = path.join(dir, 'pages', `${sha}.enc`);
      if (!ready) { fs.mkdirSync(path.join(dir, 'pages'), { recursive: true }); ready = true; }
      if (!fs.existsSync(file)) fs.writeFileSync(file, encrypt(key, content));
      written.add(sha); stats.bodies++; stats.bytes += bytes;
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
      const line = { t: start - t0, at: new Date(start).toISOString(), url, ...(dateCheck ? { kind: 'date-check' } : {}) };
      stats.fetches++;
      try {
        const res = await fetchText(url, opts);
        const content = res && typeof res === 'object' ? res.content : res;
        const finalUrl = res && typeof res === 'object' ? res.finalUrl || null : null;
        try {
          if (dateCheck) append({ ...line, status: 'ok', publishDate: dateOf(content) || null, settledMs: now() - start });
          else append({ ...line, status: 'ok', ...(finalUrl ? { finalUrl } : {}), ...store(String(content)), settledMs: now() - start });
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

module.exports = { createFetchRecorder, keyFromEnv, decrypt, MAX_PAGE_BYTES, MAX_RUN_BYTES };
