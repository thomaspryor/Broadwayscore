/**
 * Which video a creator's review of a show is (BRO-6091).
 *
 * Kate Reinking (@theatreislife) told the owner we miss her reviews and pick
 * the wrong one when she posts several videos about a show. The 2026-10-23
 * audit found three causes, all fixed with the rules below:
 *   1. 1,185 transcripts the classifier called reviews had no show id: its
 *      show list stops at shows opened since 2023-06, it missed titles in a
 *      585-name list (Waiting for Godot 2025, Oedipus 2025), and it never
 *      retried once shows.json grew. rematchCandidates() re-matches by title
 *      and run dates against every production, London included (BRO-6095:
 *      two registry creators are London-based and US creators review London trips).
 *   2. select-best-reviews.js took the video closest to opening night, so a
 *      422-word song clip beat Kate's 1,230-word Tammy Faye review.
 *      deterministicPick() is the fallback for the LLM picker.
 *   3. A rejected, wrong-production or paid pick ended the show for that
 *      creator even when other review videos existed (30 groups). isDeadEnd()
 *      marks those so selection moves on to the next video.
 * Pure so tests can require() it (CLAUDE.md §15).
 */

const { normalizeTitle, titleTokens, jaccard } = require('./title-match');
const { productionStartMs, isStaleDateFlag, parseYmd, PREDATE_GRACE_DAYS } = require('./video-production-context');
const { isPaidPromotion } = require('./video-review-guards');

const DAY_MS = 86400000;
const MIN_WORDS = 100;
// Shorter than this is a clip or a quick reaction, not the creator's review.
const SUBSTANTIAL_WORDS = 300;
// Creators post closing-weekend reviews a few days after the show closes.
const CLOSING_GRACE_DAYS = 14;
// No previews date: the old rule assumed previews began 30 days before opening.
const ASSUMED_PREVIEW_DAYS = 30;
/** First day a review of this production can be posted (UTC ms), or null. */
function windowStartMs(show) {
  let start = productionStartMs(show);
  if (start === null) return null;
  if (!show.previewsStartDate && !show.firstRunStart) start -= ASSUMED_PREVIEW_DAYS * DAY_MS;
  return start - PREDATE_GRACE_DAYS * DAY_MS;
}

/**
 * Could a video posted on `date` (YYYYMMDD or YYYY-MM-DD) review this run?
 * Unknown post dates and unknown run dates pass: there is nothing to judge by.
 */
function inProductionWindow(date, show) {
  const posted = parseYmd(date);
  if (posted === null || !show) return true;
  const start = windowStartMs(show);
  if (start !== null && posted < start) return false;
  const closing = parseYmd(show.closingDate);
  if (closing !== null && posted > closing + CLOSING_GRACE_DAYS * DAY_MS) return false;
  return true;
}

/** normalizedTitle -> shows, built once per run. */
function indexShowsByTitle(shows) {
  const byTitle = new Map();
  for (const s of shows) {
    if (!s || !s.id || !s.title) continue;
    const key = normalizeTitle(s.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(s);
  }
  return byTitle;
}

// A near-miss title ("John Proctor as the Villain", "The Wild Party" for
// "Encores! The Wild Party") still needs this share of title words in common.
const FUZZY_TITLE_MIN = 0.6;
const FUZZY_MAX = 3;
const tokenCache = new WeakMap();
function showTokens(s) {
  if (!tokenCache.has(s)) tokenCache.set(s, titleTokens(s.title));
  return tokenCache.get(s);
}

/** Shows whose title is close to the classifier's title, best first (BRO-6172). */
function closeTitleMatches(title, byTitle) {
  const exactKey = normalizeTitle(title || '');
  const words = titleTokens(String(title || '').replace(/\([^)]*\)/g, ' '));
  if (!words.size) return [];
  const out = [];
  for (const [key, shows] of byTitle) {
    if (key === exactKey) continue;
    for (const s of shows) {
      const j = jaccard(words, showTokens(s));
      if (j >= FUZZY_TITLE_MIN) out.push([s, j]);
    }
  }
  // ties by id, so the candidate list (the re-match cache key) is stable
  return out.sort((a, b) => b[1] - a[1] || a[0].id.localeCompare(b[0].id)).map(([s]) => s);
}

/** Shows whose title is the classifier's title, else close to it. */
function titleMatches(title, byTitle) {
  const exact = byTitle.get(normalizeTitle(title || '')) || [];
  return exact.length ? exact : closeTitleMatches(title, byTitle);
}

/**
 * Productions an unmatched review could be about: the classifier's title
 * matches and the video was posted during the run. When no exact-title run
 * fits the date ("The Wild Party" matched only the 2000 Broadway run, not
 * Encores! The Wild Party 2026), close titles are tried (BRO-6172). Needs a
 * known post date and a known run start, otherwise every revival of the
 * title would qualify. Close-title candidates are only ever confirmed by the
 * model in classify-reviews.js, never taken as matched.
 * @param {{showTitle?: string, date?: string}} c a classified transcript
 * @param {Map<string, object[]>} byTitle from indexShowsByTitle()
 */
function rematchCandidates(c, byTitle) {
  if (!c || parseYmd(c.date) === null || !normalizeTitle(c.showTitle || '')) return [];
  const fits = s => windowStartMs(s) !== null && inProductionWindow(c.date, s);
  const exact = (byTitle.get(normalizeTitle(c.showTitle)) || []).filter(fits);
  if (exact.length) return exact;
  return closeTitleMatches(c.showTitle, byTitle).filter(fits).slice(0, FUZZY_MAX);
}

/**
 * The selected video can never be published, so selection should try the
 * creator's next video: scoring rejected it, verify-productions flagged it as
 * another production (unless the date rule behind the flag no longer holds,
 * so verify-productions.js re-checks it), or it is a paid promotion.
 */
function isDeadEnd(t, show) {
  if (!t) return false;
  if (t.scoreable === false) return true;
  if (t.wrongProduction === true && !(show && isStaleDateFlag(t, show))) return true;
  return isPaidPromotion(t);
}

/** Review videos selection may pick for one creator and one show (never a paid promotion). */
function selectionCandidates(classified, show, excludedIds = new Set()) {
  return classified.filter(c =>
    c.reviewType === 'review'
    && Number(c.wordCount) >= MIN_WORDS
    && !excludedIds.has(c.videoId)
    && !isPaidPromotion(c)
    && inProductionWindow(c.date, show));
}

/** Changes whenever a video is added to or leaves the candidate set. */
function candidateSetKey(candidates) {
  return candidates.map(c => c.videoId).sort().join(',');
}

/**
 * Without the LLM picker: the creator's first full-length review (most post
 * their review soon after seeing a show, then revisits, replies and clips),
 * else the longest video.
 */
function deterministicPick(candidates) {
  if (!candidates.length) return null;
  const byDate = [...candidates].sort((a, b) =>
    (parseYmd(a.date) ?? Infinity) - (parseYmd(b.date) ?? Infinity) || Number(b.wordCount) - Number(a.wordCount));
  return byDate.find(c => Number(c.wordCount) >= SUBSTANTIAL_WORDS)
    || [...candidates].sort((a, b) => Number(b.wordCount) - Number(a.wordCount))[0];
}

// A pick made by fallback (no API key, API error, unparseable reply) is
// re-asked on the next run; only these are cached against the candidate set.
const SETTLED_METHODS = new Set(['llm', 'single']);

/**
 * What selection does for one creator and show.
 *  none      no candidate left (a dead-end file stays as the record of why)
 *  unchanged settled pick, same candidate set: nothing to do
 *  pick      exactly one candidate
 *  ask       several candidates: ask the picker, else fallbackPick()
 */
function planSelection(existing, candidates, show) {
  if (!candidates.length) return { action: 'none' };
  const candidateKey = candidateSetKey(candidates);
  const existingValid = !!existing && !isDeadEnd(existing, show) && candidates.some(c => c.videoId === existing.videoId);
  if (existingValid && SETTLED_METHODS.has(existing.selection?.method) && existing.selection.candidateKey === candidateKey) {
    return { action: 'unchanged', candidateKey };
  }
  if (candidates.length === 1) return { action: 'pick', candidateKey, pick: candidates[0], method: 'single' };
  return { action: 'ask', candidateKey, existingValid };
}

/** Picker unavailable: keep a still-valid current pick, else the first full review. */
function fallbackPick(existing, candidates, existingValid) {
  if (existingValid) return { pick: candidates.find(c => c.videoId === existing.videoId), method: 'kept' };
  return { pick: deterministicPick(candidates), method: 'first-full-review' };
}

/** Scored, kept by scoring, not another production, not an advert: on the site. */
function isPublishable(t) {
  return !!t && t.score !== undefined && t.scoreable !== false && t.wrongProduction !== true && !isPaidPromotion(t);
}

const SNAPSHOT_FIELDS = ['creatorId', 'platform', 'videoId', 'videoUrl', 'title', 'publishedAt', 'views', 'score', 'bucket', 'confidence', 'reasoning', 'keyQuote', 'thumbnail'];

/**
 * The per-show file for a new pick. When the current file is on the site, it
 * rides along as previousPick, so build-video-reviews.js keeps publishing it
 * until the new pick has scored and passed verify-productions.js (scoring can
 * fail, reject it, or verification can flag it; each would hide the creator's
 * review for a week). deleteThumbnail: nothing published stays on this
 * creator+show path, so its image is stale.
 */
function nextSelectedRecord(existing, pick, { excludedVideoIds, selection }) {
  // Carry what is on the site now: the existing pick if build publishes it,
  // else the pick it was itself waiting to replace (never an unverified one).
  const live = existing ? publishedRecord(existing).record : null;
  const previousPick = live && live === existing
    ? Object.fromEntries(SNAPSHOT_FIELDS.filter(k => existing[k] !== undefined).map(k => [k, existing[k]]))
    : live;
  const record = {
    creatorId: pick.creatorId,
    platform: pick.platform,
    videoId: pick.videoId,
    videoUrl: pick.platform === 'youtube'
      ? `https://www.youtube.com/watch?v=${pick.videoId}`
      : `https://www.tiktok.com/@${pick.creatorId}/video/${pick.videoId}`,
    title: pick.title,
    publishedAt: pick.date || null,
    views: pick.views || null,
    duration: pick.duration || null,
    transcript: pick.transcript,
    wordCount: pick.wordCount,
    transcriptSource: pick.platform === 'youtube' ? 'youtube-auto-captions' : 'tiktok-subs',
    extractedAt: pick.collectedAt,
    excludedVideoIds,
    selection,
  };
  if (previousPick) record.previousPick = previousPick;
  return { record, deleteThumbnail: !!existing && !previousPick };
}

/**
 * What build-video-reviews.js publishes for a per-show file: the current pick
 * when it is publishable (retire: previousPick and its thumbnail are now
 * stale), else the previous pick still waiting to be replaced, else nothing.
 * A new pick only replaces a published one after verify-productions.js has
 * checked it (productionCheck); until then the previous pick stays up.
 */
function publishedRecord(t) {
  if (isPublishable(t) && (!t.previousPick || t.productionCheck)) return { record: t, retirePrevious: !!t.previousPick };
  if (t && t.previousPick) return { record: t.previousPick, retirePrevious: false };
  return { record: null, retirePrevious: false };
}

/** Opening and closing of a transcript: the verdict is usually at the end. */
function transcriptExcerpt(text, head = 500, tail = 300) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= head + tail + 20 ? t : `${t.slice(0, head)} [...] ${t.slice(-tail)}`;
}

/**
 * Model reply -> chosen candidate. Accepts {"pick": N} with N 1-based; any
 * other reply (or an out-of-range N) is null so the caller falls back.
 */
function parsePickerReply(text, candidates) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const n = Number(obj && obj.pick);
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) return null;
  return { pick: candidates[n - 1], reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : '' };
}

/**
 * Model reply -> confirmed production. Accepts {"match": N} with N 1-based,
 * or 0 / null for none of them.
 */
function parseRematchReply(text, shows) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { ok: false };
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return { ok: false }; }
  if (!obj || !('match' in obj)) return { ok: false };
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : '';
  if (obj.match === 0 || obj.match === null) return { ok: true, show: null, reason };
  const n = Number(obj.match);
  if (!Number.isInteger(n) || n < 1 || n > shows.length) return { ok: false };
  return { ok: true, show: shows[n - 1], reason };
}

module.exports = {
  MIN_WORDS,
  SUBSTANTIAL_WORDS,
  inProductionWindow,
  indexShowsByTitle,
  titleMatches,
  rematchCandidates,
  isDeadEnd,
  selectionCandidates,
  candidateSetKey,
  deterministicPick,
  planSelection,
  fallbackPick,
  isPublishable,
  nextSelectedRecord,
  publishedRecord,
  transcriptExcerpt,
  parsePickerReply,
  parseRematchReply,
};
