/**
 * YouTube captions without yt-dlp (BRO-4343).
 *
 * Since 2026-08 YouTube answers every yt-dlp request from GitHub runner IPs
 * with "Sign in to confirm you're not a bot", so the YouTube-primary video
 * critics (Mickey-Jo, Matthew Hardy, Paul Seven) got no new transcripts.
 * Captions only need two GETs, which fetchPage()'s provider chain (Bright
 * Data residential IPs first) can make: the watch page, whose player
 * response lists caption tracks, and the chosen track as json3.
 *
 * BRO-4665: that route died too (Bright Data's unlocker answers youtube.com
 * with HTTP 200 and an empty body; Scrapingdog's /scrape page has no player
 * response). Scrapingdog's dedicated /youtube/transcripts API (1 credit) is
 * now tried first, with /youtube/video (5 credits) only when the caller needs
 * the upload date. The watch-page route stays as the fallback.
 *
 * The parsing is pure (unit tested in tests/unit/youtube-captions.test.mjs).
 * fetchYouTubeTranscript calls scraper.js directly (so the scraper-spend
 * ledger guard in scripts/lib/ledger-coverage-check.js can see the fetchPage
 * call and require callers' workflows to commit the ledger); tests inject
 * fakes through the optional second argument.
 */

const scraper = require('./scraper');

/** Balanced-brace JSON object starting at text[start] === '{'. Returns the substring or null. */
function sliceJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Extract ytInitialPlayerResponse from a watch-page HTML string, or null. */
function parsePlayerResponse(html) {
  const marker = /ytInitialPlayerResponse\s*=\s*\{/.exec(String(html || ''));
  if (!marker) return null;
  const json = sliceJsonObject(html, marker.index + marker[0].length - 1);
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/** Prefer human English captions, then English auto-captions, then any track. */
function pickCaptionTrack(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const en = t => /^en\b/i.test(t.languageCode || '');
  return list.find(t => en(t) && t.kind !== 'asr')
    || list.find(t => en(t))
    || list[0]
    || null;
}

/** json3 caption payload -> plain text. */
function json3ToText(payload) {
  const events = payload && Array.isArray(payload.events) ? payload.events : [];
  const parts = [];
  for (const e of events) {
    if (!Array.isArray(e.segs)) continue;
    const line = e.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (line) parts.push(line);
  }
  return parts.filter((l, i) => i === 0 || l !== parts[i - 1]).join(' ').trim();
}

/** "2026-09-10T07:00:00-07:00" or "2026-09-10" -> "20260910", else null. */
function toYmd(publishDate) {
  const m = String(publishDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const AGO_MS = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 };

/**
 * Scrapingdog published_time ("May 20, 2026", "Streamed live on May 20, 2026",
 * "Premiered 3 Sept 2026", or YouTube's relative "3 days ago" for fresh
 * uploads) -> "20260520", else null. Relative text resolves against `now`;
 * months/years ago are too coarse to date a review, so they stay null.
 */
function publishedTimeToYmd(text, now = new Date()) {
  const t = String(text || '');
  const iso = toYmd(t.trim());
  if (iso) return iso;
  const pad = n => String(n).padStart(2, '0');
  const ago = t.match(/\b(\d+|an?) (second|minute|hour|day|week)s? ago\b/i);
  if (ago) {
    const n = /^\d/.test(ago[1]) ? Number(ago[1]) : 1;
    const d = new Date(now.getTime() - n * AGO_MS[ago[2].toLowerCase()]);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  }
  let m = t.match(/\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}${pad(m[2])}`;
  m = t.match(/\b(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})\b/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}${pad(m[1])}`;
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Scrapingdog /youtube/transcripts payload -> plain text, or null when the shape is unrecognised. */
function sdTranscriptToText(payload) {
  const segs = payload && (Array.isArray(payload.transcripts) ? payload.transcripts
    : Array.isArray(payload.transcript) ? payload.transcript : null);
  if (!segs) return null;
  const parts = segs
    .map(seg => decodeEntities(typeof seg === 'string' ? seg : (seg && seg.text) || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return parts.filter((l, i) => i === 0 || l !== parts[i - 1]).join(' ').trim();
}

/**
 * Scrapingdog's YouTube APIs. Returns {transcript, publishedAt, source} or
 * null (unavailable, failed, or unrecognised payload) so the caller falls
 * back to the watch-page route.
 */
// /youtube/video nests metadata under `video` ({video:{published_time:"Streamed
// live on May 20, 2026"}, channel:{...}}, per Scrapingdog's docs). BRO-4760:
// reading data.published_time at the top level missed it for all 66 videos
// of the first run.
function sdVideoPublishedText(data) {
  if (!data || typeof data !== 'object') return null;
  const v = data.video || {};
  return v.published_time || v.publish_date || v.upload_date
    || data.published_time || data.publish_date || data.upload_date || null;
}

async function viaScrapingdog(videoId, sdYouTube, { needDate }) {
  const t = await sdYouTube('transcripts', videoId, { language: 'en' });
  if (!t) return null;
  if (t.error) {
    console.log(`  ⚠️  Scrapingdog transcripts failed for ${videoId}: ${String(t.error).slice(0, 120)}`);
    return null;
  }
  const transcript = sdTranscriptToText(t.data);
  if (transcript === null) {
    console.log(`  ⚠️  Scrapingdog transcripts payload unrecognised for ${videoId}: ${JSON.stringify(t.data).slice(0, 160)}`);
    return null;
  }
  const publishedAt = (needDate && transcript && await fetchYouTubePublishedAt(videoId, sdYouTube)) || null;
  return { transcript, publishedAt, source: 'scrapingdog-youtube' };
}

/**
 * Upload date via Scrapingdog /youtube/video (5 credits) -> "YYYYMMDD", null
 * when the lookup ran and found no date, or undefined when no call was made
 * (no key, quota or credit budget exhausted: sdYouTube returned null).
 */
async function fetchYouTubePublishedAt(videoId, sdYouTube = scraper.fetchScrapingdogYouTube) {
  const v = await sdYouTube('video', videoId, {});
  if (v === null || v === undefined) return undefined;
  const publishedAt = v && v.data ? publishedTimeToYmd(sdVideoPublishedText(v.data)) : null;
  if (!publishedAt) console.log(`  ⚠️  No upload date for ${videoId} from Scrapingdog /youtube/video (${v ? (v.error || `keys=${Object.keys(v.data || {}).join(',')} video=${JSON.stringify(v.data && v.data.video && v.data.video.published_time)}`) : 'unavailable'})`.slice(0, 220));
  return publishedAt;
}

const isDateless = d => !d || d === 'NA';

/**
 * BRO-4760: published YouTube reviews collected while the date lookup was
 * broken carry publishedAt "NA", and collect-transcripts skips cached videos,
 * so nothing would ever re-date them. For up to `max` dateless per-show
 * YouTube files (not already wrongProduction) it fetches the date, writes
 * publishedAt, mirrors it into raw/ and classified/ (select-best-reviews reads
 * classified/ and would otherwise write "NA" back), and drops productionCheck
 * so verify-productions re-runs its date rule. A failed lookup is stamped
 * dateLookupFailedAt and not retried for RETRY_DAYS. A bad file is skipped.
 * @returns {Promise<{candidates: number, attempted: number, dated: number}>}
 */
const RETRY_DAYS = 30;
async function backfillPublishedDates({ transcriptsDir, creatorFilter = null, max = 250, fetchDate = fetchYouTubePublishedAt, now = new Date(), fs = require('fs'), path = require('path') }) {
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
  const todo = [];
  for (const showId of fs.readdirSync(transcriptsDir)) {
    if (showId === 'raw' || showId === 'classified' || showId.startsWith('.')) continue;
    const dir = path.join(transcriptsDir, showId);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const file = path.join(dir, f);
      const t = readJson(file);
      if (!t || t.platform !== 'youtube' || !t.videoId || !isDateless(t.publishedAt) || t.wrongProduction === true) continue;
      if (creatorFilter && String(t.creatorId).toLowerCase() !== creatorFilter.toLowerCase()) continue;
      if (t.dateLookupFailedAt && now - new Date(t.dateLookupFailedAt) < RETRY_DAYS * 864e5) continue;
      todo.push({ file, t });
    }
  }
  let attempted = 0, dated = 0;
  for (const { file, t } of todo.slice(0, max)) {
    attempted++;
    const ymd = await fetchDate(t.videoId);
    // Out of credits: stop without stamping, so the next run retries these.
    if (ymd === undefined) { attempted--; break; }
    if (!ymd) { t.dateLookupFailedAt = now.toISOString(); writeJson(file, t); continue; }
    t.publishedAt = ymd;
    delete t.dateLookupFailedAt;
    delete t.productionCheck;
    writeJson(file, t);
    for (const sub of ['raw', 'classified']) {
      const f = path.join(transcriptsDir, sub, `${t.videoId}.json`);
      const o = fs.existsSync(f) ? readJson(f) : null;
      if (o && isDateless(o.date)) { o.date = ymd; writeJson(f, o); }
    }
    dated++;
  }
  return { candidates: todo.length, attempted, dated };
}

/**
 * @param {string} videoId
 * @param {{fetchPage?: Function, fetchJSON?: Function, sdYouTube?: Function}} [fetchers] test overrides; defaults to scraper.js
 * @param {{needDate?: boolean}} [opts] needDate=false skips the 5-credit /youtube/video call
 * @returns {Promise<{transcript: string, publishedAt: string|null, source: string}>}
 * @throws Error whose message starts "ERROR:" (collect-transcripts.js counts it as a yt error)
 */
async function fetchYouTubeTranscript(videoId, fetchers = {}, opts = {}) {
  // Tests that inject only fetchPage/fetchJSON exercise the watch-page route.
  const sdYouTube = fetchers.sdYouTube !== undefined ? fetchers.sdYouTube
    : (fetchers.fetchPage ? null : scraper.fetchScrapingdogYouTube);
  if (sdYouTube) {
    const sd = await viaScrapingdog(videoId, sdYouTube, { needDate: opts.needDate !== false });
    if (sd) return sd;
  }
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const page = fetchers.fetchPage
    ? await fetchers.fetchPage(watchUrl, { skipVerify: true })
    : await scraper.fetchPage(watchUrl, { skipVerify: true });
  const player = parsePlayerResponse(page && page.content);
  if (!player) throw new Error(`ERROR: [youtube-fetchpage] ${videoId}: no player response in watch page (${page?.source || 'no source'})`);
  const status = player.playabilityStatus?.status;
  if (status && status !== 'OK') {
    throw new Error(`ERROR: [youtube-fetchpage] ${videoId}: ${status}: ${player.playabilityStatus?.reason || ''}`.trim());
  }
  const publishedAt = toYmd(player.microformat?.playerMicroformatRenderer?.publishDate || player.microformat?.playerMicroformatRenderer?.uploadDate);
  const track = pickCaptionTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks);
  if (!track || !track.baseUrl) return { transcript: '', publishedAt, source: page.source };
  const url = track.baseUrl.startsWith('http') ? track.baseUrl : `https://www.youtube.com${track.baseUrl}`;
  const trackUrl = `${url}${url.includes('?') ? '&' : '?'}fmt=json3`;
  const payload = fetchers.fetchJSON ? await fetchers.fetchJSON(trackUrl) : await scraper.fetchJSON(trackUrl);
  // A track that answers without an events array is a blocked/empty response
  // (e.g. a PO-token requirement), not a video with no captions: report it so
  // the outage check can see it.
  if (!payload || !Array.isArray(payload.events)) {
    throw new Error(`ERROR: [youtube-fetchpage] ${videoId}: caption track returned no events (${page.source})`);
  }
  return { transcript: json3ToText(payload), publishedAt, source: page.source };
}

module.exports = { parsePlayerResponse, pickCaptionTrack, json3ToText, toYmd, publishedTimeToYmd, sdTranscriptToText, sdVideoPublishedText, fetchYouTubePublishedAt, backfillPublishedDates, fetchYouTubeTranscript, sliceJsonObject };
