/**
 * Shared types + source adapters for the My Shows import flow (ImportShows.tsx).
 *
 * Each import source is an adapter that turns its raw input (a Mezzanine
 * export file, a Show Score profile URL) into RawImportEntry[]; the modal owns
 * everything downstream — show matching, the preview checklist, and the
 * Supabase inserts. Adding import source #3 = one new adapter here plus an
 * input step in the modal; the pipeline doesn't change.
 */
import { getSupabaseClient } from '@/lib/supabase';
import { sanitizeRating } from '@/lib/rating';
import { isIsoCalendarDate, localToday } from '@/lib/date-utils';

/** One seen-show / want-to-see entry, normalized across sources. */
export interface RawImportEntry {
  title: string;
  venue: string | null;
  /** 0.5–5 half-star; null = source had no usable rating for this entry. */
  rating: number | null;
  /** Original source-scale score for preview display (Show Score 0–100). */
  sourceScore: number | null;
  date: string | null; // YYYY-MM-DD
  reviewText: string | null;
  kind: 'diary' | 'watchlist';
  listName?: string;
  /** True for diary entries rerouted to watchlist (unrated future viewings) —
   *  their auto-select rule differs from list-based watchlist entries. */
  fromDiary?: boolean;
  /** Mezzanine Show class objectId (entry.show.id in the export) — lets the
   *  unmatched-import self-heal loop look this show up directly on Mezzanine
   *  instead of falling back to a fuzzy title search. */
  mezzShowId?: string;
  /** Theatr reaction on a seen show. Rated by the user's own choice in the
   *  preview (reactionRatings), never by the source; a written score wins. */
  reaction?: TheatrReaction;
}

export type TheatrReaction = 'recommend' | 'mixed' | 'dislike';

export interface ImportAcquireResult {
  entries: RawImportEntry[];
  /** Non-fatal caveats to surface in the preview ("12 reviews had no rating"). */
  notices: string[];
}

// ---------------------------------------------------------------------------
// Diary catalog merge (shared by ImportShows matching + the My Shows Add-show
// search dropdown — one merge implementation, two consumers).
// ---------------------------------------------------------------------------

/** Shape of an entry in public/data/diary-search.json (see generate-diary-data.js). */
export interface DiarySearchEntry {
  id: string;
  title: string;
  slug: string;
  status: string;
  dy?: boolean;
  venue?: string;
  city?: string;
  od?: string;
  category?: string;
  /** Multi-production groups (same title, distinct venues) — expanded into
   *  individual entries below rather than kept as one ambiguous row. */
  prods?: { id: string; v?: string; ci?: string; co?: string; cat?: string }[];
}

interface MergeableShow {
  id: string;
  title: string;
  venue?: string;
}

/**
 * Merge the diary-only catalog (regional/international/historical shows,
 * Mezzanine-sourced) into a base scored-shows catalog for search/import
 * matching. Expands multi-production groups into venue-distinct entries and
 * skips diary rows whose title+venue is already covered by the base catalog
 * (never shadow a scored show with an unscored diary duplicate).
 */
export function mergeDiaryShows<T extends MergeableShow>(baseShows: T[], diaryShows: DiarySearchEntry[]): T[] {
  const merged = [...baseShows];
  // Dedup key is frozen from the BASE (scored) catalog only — never shadow a
  // scored show with an unscored diary duplicate. Growing this map as diary
  // rows are accepted made later diary rows collide against EARLIER diary
  // rows instead of the base catalog, silently dropping ~35% of the diary
  // catalog from search (ship-check finding, 2026-07-14). Each diary entry
  // already has a unique Mezzanine id, so diary-vs-diary "duplicates" are
  // left in — collapsing them isn't this function's job.
  const baseVenues = new Map<string, Set<string>>();
  for (const s of baseShows) {
    const key = s.title.toLowerCase();
    if (!baseVenues.has(key)) baseVenues.set(key, new Set());
    if (s.venue) baseVenues.get(key)!.add(s.venue.toLowerCase());
  }
  for (const s of diaryShows) {
    const titleLower = s.title.toLowerCase();
    const baseSet = baseVenues.get(titleLower);
    if (s.prods) {
      for (const p of s.prods) {
        const venue = p.v || '';
        if (venue && !baseSet?.has(venue.toLowerCase())) {
          merged.push({ id: p.id, title: s.title, slug: p.id, status: s.status || 'closed', venue, category: p.cat, city: p.ci, dy: true } as unknown as T);
        }
      }
      continue;
    }
    // Skip if no venue to differentiate, and title already exists in the base catalog
    if (!s.venue && baseSet) continue;
    // Skip if same venue already covered by a scored base-catalog show
    if (s.venue && baseSet?.has(s.venue.toLowerCase())) continue;
    merged.push(s as unknown as T);
  }
  return merged;
}

// NYC (off-broadway) and London (west-end) diary shows surface before the
// deep tail (us-regional/uk-regional/international/other) — owner direction
// 2026-07-14: "typing 'Cats' should never bury the Broadway revival under 40
// regional Cats productions."
const NEAR_MARKET_CATEGORIES = new Set(['off-broadway', 'west-end']);

interface RankableDiaryResult {
  dy?: boolean;
  category?: string;
  rc?: number;
  od?: string;
}

/**
 * Re-order Fuse search results for the My Shows Add-show dropdown: scored
 * (non-diary) matches always first, regardless of fuzzy-match score; diary-
 * only matches follow, tie-broken by market (NYC/London first) → popularity
 * (audienceRatingsCount desc) → recency (openingDate desc). Header/site
 * search never calls this — only the diary-merged Add-show index does.
 */
export function tierSearchResults<T>(results: T[], limit: number): T[] {
  const scored: T[] = [];
  const diaryOnly: T[] = [];
  for (const r of results) ((r as RankableDiaryResult).dy ? diaryOnly : scored).push(r);
  diaryOnly.sort((a, b) => {
    const ra = a as RankableDiaryResult;
    const rb = b as RankableDiaryResult;
    const marketDiff = Number(!NEAR_MARKET_CATEGORIES.has(ra.category || '')) - Number(!NEAR_MARKET_CATEGORIES.has(rb.category || ''));
    if (marketDiff !== 0) return marketDiff;
    const popDiff = (rb.rc || 0) - (ra.rc || 0);
    if (popDiff !== 0) return popDiff;
    return (rb.od || '').localeCompare(ra.od || '');
  });
  return [...scored, ...diaryOnly].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Show Score
// ---------------------------------------------------------------------------

/** Mirror of the show-score-proxy edge function's response contract
 *  (supabase/functions/show-score-proxy/index.ts — single-channel: always
 *  HTTP 200 with ok:false for handled failures). */
interface ShowScoreProxyResponse {
  ok: boolean;
  error?: 'invalid_slug' | 'unauthorized' | 'rate_limited' | 'not_found' | 'upstream_blocked' | 'internal';
  displayName?: string | null;
  totalOnProfile?: number | null;
  reviews?: Array<{
    reviewId: string | null;
    title: string;
    venue: string | null;
    rating: number | null;
    sourceScore: number | null;
    reviewText: string | null;
    dateSeen: string | null;
  }>;
  unparsed?: number;
  truncated?: boolean;
  incomplete?: boolean;
}

export const SHOW_SCORE_ERROR_COPY: Record<string, string> = {
  invalid_slug: "That doesn't look like a Show Score profile link. Paste your profile URL, e.g. show-score.com/member/your-name.",
  unauthorized: 'Please sign in again and retry.',
  rate_limited: "You've hit the import limit for now. Try again in an hour.",
  not_found: "We couldn't find that Show Score member. Check the profile link and try again.",
  upstream_blocked: 'Show Score is blocking our importer right now. Try again in a few hours.',
  internal: 'Something went wrong on our side. Try again in a few minutes.',
};

/** Extract a member slug from a pasted profile URL or bare slug. UX-level
 *  parsing only — the edge function independently validates the slug, which
 *  is the actual security boundary. */
export function extractMemberSlug(input: string): string | null {
  const s = String(input || '').trim();
  const fromUrl = s.match(/show-score\.com\/member\/([a-z0-9][a-z0-9-]{0,79})/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,79}$/i.test(s)) return s.toLowerCase();
  return null;
}

/** Fetch + normalize a Show Score profile via the show-score-proxy function.
 *  Throws Error with user-ready copy on any handled failure. */
export async function acquireFromShowScore(profileInput: string): Promise<ImportAcquireResult> {
  const slug = extractMemberSlug(profileInput);
  if (!slug) throw new Error(SHOW_SCORE_ERROR_COPY.invalid_slug);

  const supabase = await getSupabaseClient();
  if (!supabase) throw new Error(SHOW_SCORE_ERROR_COPY.unauthorized);

  const { data, error } = await supabase.functions.invoke<ShowScoreProxyResponse>('show-score-proxy', {
    body: { slug },
  });
  if (error || !data) throw new Error(SHOW_SCORE_ERROR_COPY.internal);
  if (!data.ok) throw new Error(SHOW_SCORE_ERROR_COPY[data.error || 'internal'] || SHOW_SCORE_ERROR_COPY.internal);

  // Rows with an unreadable score are excluded here — the `unparsed` notice
  // tells the user how many were skipped (never silently guess a rating).
  const entries: RawImportEntry[] = (data.reviews || [])
    .filter((r) => r.rating !== null)
    .map((r) => ({
      title: r.title,
      venue: r.venue,
      // The function already returns half-star ratings; sanitize anyway so a
      // proxy regression can never write an off-scale value.
      rating: sanitizeRating(r.rating as number) || null,
      sourceScore: r.sourceScore,
      date: r.dateSeen,
      reviewText: r.reviewText,
      kind: 'diary',
    }));

  const notices: string[] = [];
  if (data.unparsed) notices.push(`${data.unparsed} review(s) had no readable rating and were skipped.`);
  if (data.truncated) notices.push('This profile has more than 1,000 reviews, so only the most recent 1,000 were fetched.');
  if (data.incomplete) notices.push(`Show Score stopped responding partway, so only ${entries.length} review(s) were fetched. You can re-run the import later to pick up the rest.`);
  return { entries, notices };
}

// ---------------------------------------------------------------------------
// Mezzanine
// ---------------------------------------------------------------------------

// Typed as what a file can actually hold, not what a clean export holds: the
// guards below narrow from these, so a hand-edited value can't slip past them.
interface MezzEntry {
  show: { name: string; id?: string | number };
  rating: number | string | null;
  date: string | null;
  review: string | null;
  production?: { theater?: { name: string; location?: string } };
}

interface MezzExport {
  appVersion?: string;
  data: {
    diaryEntries: MezzEntry[];
    // `id` is optional here defensively — list-derived shows are the same
    // underlying Mezzanine Show objects as diaryEntries' `show.id`, but
    // unconfirmed against a real list export, so this must degrade to the
    // pre-existing title-only behavior (undefined) rather than assume shape.
    lists: { name: string; shows: { name: string; id?: string | number }[] }[];
  };
}

/** Mezzanine show ids may be strings or numbers; anything else is ignored. */
function mezzShowIdOf(id: unknown): { mezzShowId?: string } {
  if (typeof id === 'string' && id) return { mezzShowId: id };
  if (typeof id === 'number' && Number.isFinite(id)) return { mezzShowId: String(id) };
  return {};
}

/**
 * Shown for any file that isn't a readable Mezzanine export. One fixed string
 * on purpose: JSON.parse's own message quotes a slice of the file, and the
 * thrown message is both shown on screen and sent as import_failed's
 * error_message, so it must never carry the user's file content.
 */
export const MEZZANINE_FILE_ERROR =
  'That file doesn\u2019t look like a Mezzanine export. In Mezzanine, go to Settings, then Export Data, choose JSON, and pick that file here.';

/** Parse a Mezzanine JSON export (Settings → Export Data → JSON). */
export async function acquireFromMezzanine(file: File): Promise<ImportAcquireResult> {
  let parsed: MezzExport;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error(MEZZANINE_FILE_ERROR);
  }
  if (!Array.isArray(parsed?.data?.diaryEntries)) {
    throw new Error(MEZZANINE_FILE_ERROR);
  }

  const entries: RawImportEntry[] = [];
  // The user's own date, not UTC: from ~8pm ET a show planned for tomorrow
  // would otherwise compare equal to "today" and import as already seen.
  const today = localToday();
  // Same contract as the Show Score path: a skipped row is counted and told
  // to the user, never dropped silently.
  let skipped = 0;

  for (const entry of parsed.data.diaryEntries) {
    // A hand-edited or partial export can carry entries without a show;
    // skip them instead of failing the whole import on a TypeError.
    // Check types too: a non-string title would crash title matching later.
    if (typeof entry?.show?.name !== 'string' || !entry.show.name) { skipped++; continue; }
    // An unreadable date is dropped, never stored or compared: 'garbage' sorts
    // after any real date, so it would file the row as a future plan.
    const day = typeof entry.date === 'string' ? entry.date.split('T')[0] : '';
    const date = isIsoCalendarDate(day) ? day : null;
    // Real exports carry numbers; a numeric string ("4.5") from a hand-edited
    // file was accepted before the type guards and still is.
    const ratingValue = typeof entry.rating === 'string' && entry.rating.trim() ? Number(entry.rating) : entry.rating;
    // Mezzanine ratings are already 1–5 half-star; sanitize defensively.
    const rating = typeof ratingValue === 'number' && Number.isFinite(ratingValue) && ratingValue > 0
      ? sanitizeRating(ratingValue) || null
      : null;
    const hasRating = rating !== null;
    const venue = entry.production?.theater?.name;
    // Unrated future entries are plans, not viewings → watchlist.
    const isFuture = date !== null && date > today;
    entries.push({
      title: entry.show.name,
      venue: typeof venue === 'string' && venue ? venue : null,
      rating,
      sourceScore: null,
      date,
      reviewText: typeof entry.review === 'string' && entry.review ? entry.review : null,
      kind: !hasRating && isFuture ? 'watchlist' : 'diary',
      ...(!hasRating && isFuture ? { listName: 'Upcoming', fromDiary: true } : {}),
      ...mezzShowIdOf(entry.show.id),
    });
  }

  for (const list of Array.isArray(parsed.data.lists) ? parsed.data.lists : []) {
    const listName = typeof list?.name === 'string' ? list.name : undefined;
    for (const show of Array.isArray(list?.shows) ? list.shows : []) {
      if (typeof show?.name !== 'string' || !show.name) { skipped++; continue; }
      entries.push({
        title: show.name,
        venue: null,
        rating: null,
        sourceScore: null,
        date: null,
        reviewText: null,
        kind: 'watchlist',
        listName,
        ...mezzShowIdOf(show.id),
      });
    }
  }

  const notices = skipped
    ? [`${skipped} ${skipped === 1 ? 'entry' : 'entries'} in the file had no readable show name and ${skipped === 1 ? 'was' : 'were'} skipped.`]
    : [];
  return { entries, notices };
}

// ---------------------------------------------------------------------------
// Theatr (screenshots)
// ---------------------------------------------------------------------------
// Theatr has no data export, and its profile pages and API need a Theatr
// login, so the user uploads screenshots of Profile → Activity (or Collection
// → Attended / Interested) and the theatr-screenshot-import edge function
// reads them. iOS twin: BroadwayScorecard-app lib/theatr-import.ts.

/** Mirror of the theatr-screenshot-import edge function's response contract
 *  (supabase/functions/theatr-screenshot-import/index.ts — single-channel:
 *  always HTTP 200 with ok:false for handled failures). */
interface TheatrScreenshotResponse {
  ok: boolean;
  error?: 'invalid_images' | 'too_many_images' | 'unauthorized' | 'rate_limited' | 'busy' | 'not_configured' | 'internal';
  entries?: TheatrRow[];
  unreadableImages?: number;
  dropped?: number;
}

export const THEATR_ERROR_COPY: Record<string, string> = {
  invalid_images: 'One of those files couldn’t be read as a screenshot. Pick PNG or JPEG screenshots and try again.',
  too_many_images: 'Too many screenshots in one go. Try again with fewer.',
  unauthorized: 'Please sign in again and retry.',
  rate_limited: "You've hit the import limit for now. Try again in an hour.",
  busy: 'Theatr import is very busy today. Try again tomorrow.',
  not_configured: 'Theatr import isn’t available right now. Try again later.',
  internal: 'Something went wrong reading your screenshots. Try again in a few minutes.',
  no_shows: 'We couldn’t find any shows in those screenshots. In Theatr, open Profile, then Activity, and screenshot the feed from the top as you scroll down.',
};

/** Most screenshots per import; sent to the edge function in batches. */
export const THEATR_MAX_SCREENSHOTS = 30;
/** Must not exceed MAX_IMAGES_PER_CALL in the edge function's normalize.mjs. */
const THEATR_BATCH_SIZE = 6;
const THEATR_CONCURRENCY = 2;
/** Claude reads images at up to ~1568px on the long edge; anything larger is
 *  wasted upload. */
const THEATR_MAX_EDGE = 1568;

/** Downscale a screenshot to a JPEG the edge function accepts. */
async function screenshotToJpegBase64(file: File): Promise<{ mediaType: string; data: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, THEATR_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(THEATR_ERROR_COPY.invalid_images);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  } finally {
    bitmap.close();
  }
}

export interface TheatrRow {
  title: string;
  venue: string | null;
  list: 'attended' | 'interested';
  /** Which Theatr screen the row was read from. */
  screen: 'activity' | 'collection' | 'other';
  /** Full date printed for the item (a "Date attended"), or after
   *  resolveFeedDates, the Activity feed date the item was logged under. */
  date: string | null;
  /** Activity feed date header (MM-DD); the feed omits the year. */
  monthDay: string | null;
  /** Year from a year divider above the item, when one was visible. */
  yearHint: number | null;
  /** The user's own written score as 0-100, and its half-star rating. */
  score: number | null;
  rating: number | null;
  review: string | null;
  reaction: 'recommend' | 'mixed' | 'dislike' | null;
  /** Set by resolveFeedDates when `date` came from the feed header. */
  dateFromFeed?: boolean;
  /** Set by dropBackfillDates: a real viewing whose logged date was dropped,
   *  not a copy with its date cropped off, so it never folds into another. */
  dateDropped?: boolean;
  /** The model saw a review here but not all of it, so `review` is null. */
  reviewCutOff?: boolean;
}

/**
 * Batches of at most `size` screenshots where each batch after the first
 * starts with the previous batch's last screenshot as context, so the model
 * sees the date header or year divider that scrolled off above. Rows read
 * from that context screenshot repeat the previous batch's tail and are
 * removed again by stitchBatchRows.
 */
export function overlapBatches<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [items.slice(0, size)];
  let next = out[0].length;
  while (next < items.length) {
    const start = next - 1;
    const batch = items.slice(start, start + size);
    out.push(batch);
    next = start + batch.length;
  }
  return out;
}

/**
 * Join per-batch rows into one feed-ordered list, dropping the rows each
 * batch repeats from its context screenshot: the longest run at the start of
 * a batch that matches the end of what came before (same list and title).
 */
export function stitchBatchRows(batches: TheatrRow[][]): TheatrRow[] {
  const same = (a: TheatrRow, b: TheatrRow) => a.list === b.list && a.title.toLowerCase() === b.title.toLowerCase();
  const out: TheatrRow[] = [];
  for (const rows of batches) {
    let overlap = 0;
    for (let k = Math.min(rows.length, out.length); k > 0; k--) {
      const tail = out.slice(out.length - k);
      if (tail.every((r, i) => same(r, rows[i]))) { overlap = k; break; }
    }
    // The context copy may show what the first copy lacked (a header that
    // was cropped there, a review that ran onto the next screenshot).
    for (let i = 0; i < overlap; i++) {
      const kept = out[out.length - overlap + i];
      const again = rows[i];
      if (!kept.monthDay && again.monthDay) kept.monthDay = again.monthDay;
      if (!kept.yearHint && again.yearHint) kept.yearHint = again.yearHint;
      if (!kept.review && again.review) kept.review = again.review;
      if (again.reviewCutOff) kept.reviewCutOff = true;
      if (kept.score === null && again.score !== null) { kept.score = again.score; kept.rating = again.rating; }
    }
    out.push(...rows.slice(overlap).map((r) => ({ ...r })));
  }
  return out;
}

/**
 * Give Activity feed rows a full date. The feed is newest first and prints
 * "Oct 12" with no year; a bare year line ("2025") appears only where an
 * older year begins. Walking rows in screenshot order: a row with no header
 * of its own sits under the last header seen (its header scrolled off into
 * the previous screenshot); a year divider sets the year; otherwise the year
 * starts at today's (last year's when the date is still ahead of today) and
 * drops by one whenever the month/day goes UP, which in a newest-first feed
 * means the walk crossed into the previous year.
 */
export function resolveFeedDates(rows: TheatrRow[], today: string): TheatrRow[] {
  const todayYear = Number(today.slice(0, 4));
  // Two days of slack: a user ahead of the device's clock (or of UTC) can
  // log "Oct 12" while "today" still reads Oct 11.
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  let year: number | null = null;
  let lastMd: string | null = null;
  return rows.map((r) => {
    if (r.screen !== 'activity' || r.date) return { ...r };
    const md = r.monthDay || lastMd;
    if (!md) return { ...r };
    if (r.yearHint) year = r.yearHint;
    else if (year === null) year = `${todayYear}-${md}` > limit ? todayYear - 1 : todayYear;
    else if (lastMd && md > lastMd) year -= 1;
    lastMd = md;
    const date = `${year}-${md}`;
    // 02-29 in a non-leap year: the walk guessed the year wrong, so no date.
    const valid = !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).getUTCDate() === Number(md.slice(3));
    return { ...r, date: valid && r.list === 'attended' ? date : null, dateFromFeed: valid && r.list === 'attended' };
  });
}

/** A day with this many Attended entries is a backfill session (the user
 *  logging old shows), not a day of theatre, so its feed date is dropped. */
export const THEATR_BACKFILL_MIN = 3;

/** Drop feed dates on backfill days; returns how many were dropped. */
export function dropBackfillDates(rows: TheatrRow[]): { rows: TheatrRow[]; dropped: number } {
  // Distinct shows per day: a repeat of one row must not make a real
  // two-show day look like a backfill.
  const perDay = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.dateFromFeed || !r.date) continue;
    if (!perDay.has(r.date)) perDay.set(r.date, new Set());
    perDay.get(r.date)!.add(r.title.toLowerCase());
  }
  const backfillDays = new Set(Array.from(perDay).filter(([, titles]) => titles.size >= THEATR_BACKFILL_MIN).map(([day]) => day));
  const droppedTitles = new Set<string>();
  const out = rows.map((r) => {
    if (r.dateFromFeed && r.date && backfillDays.has(r.date)) {
      droppedTitles.add(`${r.date}|${r.title.toLowerCase()}`);
      return { ...r, date: null, dateFromFeed: false, dateDropped: true };
    }
    return r;
  });
  return { rows: out, dropped: droppedTitles.size };
}

/**
 * Collapse rows repeated across overlapping screenshots, keeping screenshot
 * order: one row per list + title + date, and an undated Attended row folds
 * into a dated row for the same title (its date was just cropped off). A
 * repeat fills in whatever the kept copy lacked (venue, score, review).
 */
export function mergeTheatrRows(rows: TheatrRow[]): TheatrRow[] {
  const out: TheatrRow[] = [];
  const byKey = new Map<string, TheatrRow>();
  const titleKey = (r: TheatrRow) => `${r.list}|${r.title.toLowerCase()}`;
  const datedTitles = new Set(rows.filter((r) => r.list === 'attended' && r.date).map(titleKey));
  const fill = (into: TheatrRow, from: TheatrRow) => {
    if (!into.venue && from.venue) into.venue = from.venue;
    if (into.score === null && from.score !== null) { into.score = from.score; into.rating = from.rating; }
    if (!into.review && from.review) into.review = from.review;
    if (from.reviewCutOff) into.reviewCutOff = true;
    if (!into.reaction && from.reaction) into.reaction = from.reaction;
  };
  const pending: TheatrRow[] = [];
  for (const r of rows) {
    const undatedDup = r.list === 'attended' && !r.date && !r.dateDropped && datedTitles.has(titleKey(r));
    if (undatedDup) {
      const prev = out.find((o) => titleKey(o) === titleKey(r) && o.date);
      if (prev) fill(prev, r);
      else pending.push(r); // its dated copy comes later
      continue;
    }
    const key = `${titleKey(r)}|${r.date || (r.dateDropped ? 'dropped' : '')}`;
    const prev = byKey.get(key);
    if (prev) { fill(prev, r); continue; }
    const copy = { ...r };
    byKey.set(key, copy);
    out.push(copy);
  }
  for (const r of pending) {
    const dated = out.find((o) => titleKey(o) === titleKey(r) && o.date);
    if (dated) fill(dated, r);
  }
  return out;
}

/** Split a list into consecutive batches of `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A 0.5-5 half-star rating, or null: the edge function's output is checked
 *  again here so a contract drift can never write an off-scale rating. */
function halfStar(v: number | null): number | null {
  return typeof v === 'number' && v >= 0.5 && v <= 5 && Number.isInteger(v * 2) ? v : null;
}

/**
 * What each Theatr reaction rates as when the user doesn't change it in the
 * preview. Theatr has three reactions and no stars; these sit in the middle
 * of each band and are only defaults: the preview shows one control per
 * reaction, and "Don't rate" (null) keeps those shows unrated.
 */
export const DEFAULT_REACTION_RATINGS: Record<TheatrReaction, number | null> = {
  recommend: 4,
  mixed: 3,
  dislike: 2,
};

export const REACTION_LABELS: Record<TheatrReaction, string> = {
  recommend: 'Recommend it',
  mixed: 'Mixed',
  dislike: 'Didn\u2019t like it',
};

/** How many seen shows carry each reaction and no written score: the ones a
 *  reaction setting would rate. Only reactions present are returned. */
export function reactionCounts(entries: { reaction?: TheatrReaction; scoreRating: number | null }[]): Partial<Record<TheatrReaction, number>> {
  const out: Partial<Record<TheatrReaction, number>> = {};
  for (const e of entries) if (e.reaction && e.scoreRating == null) out[e.reaction] = (out[e.reaction] || 0) + 1;
  return out;
}

/**
 * The rating a row imports with: the score the user wrote, else what their
 * reaction is set to in the preview, else none.
 */
export function effectiveRating(scoreRating: number | null, reaction: TheatrReaction | undefined, ratings: Record<TheatrReaction, number | null>): number | null {
  if (scoreRating != null) return scoreRating;
  return reaction ? ratings[reaction] ?? null : null;
}

/**
 * Map Theatr rows onto the shared import contract. A score the user wrote in
 * their review ("84/100") becomes the rating, with the review as review text.
 * A bare reaction rides along as `reaction`: the preview turns it into stars
 * with the user's own reaction settings (effectiveRating).
 */
export function theatrRowsToEntries(rows: TheatrRow[]): RawImportEntry[] {
  return rows.map((r) => r.list === 'attended'
    ? { title: r.title, venue: r.venue, rating: halfStar(r.rating), sourceScore: r.score, date: r.date, reviewText: r.review, kind: 'diary' as const, ...(r.reaction ? { reaction: r.reaction } : {}) }
    : { title: r.title, venue: r.venue, rating: null, sourceScore: null, date: null, reviewText: null, kind: 'watchlist' as const, listName: 'Interested' });
}

/** The whole client-side pipeline after the edge function, given each
 *  batch's rows in screenshot order: stitch batches, feed dates, backfill
 *  days, repeats, then import entries. */
export function theatrRowsPipeline(batches: TheatrRow[][], today: string): { entries: RawImportEntry[]; feedDates: number; backfillDropped: number; reviewsCutOff: number } {
  const dated = resolveFeedDates(stitchBatchRows(batches), today);
  const { rows: cleaned, dropped } = dropBackfillDates(dated);
  const merged = mergeTheatrRows(cleaned);
  return {
    entries: theatrRowsToEntries(merged),
    feedDates: merged.filter((r) => r.dateFromFeed && r.date).length,
    backfillDropped: dropped,
    // A copy that showed the whole review already filled it in above.
    reviewsCutOff: merged.filter((r) => r.list === 'attended' && r.reviewCutOff && !r.review).length,
  };
}

/** Preview notices for a finished Theatr read. */
export function theatrNotices(
  entries: RawImportEntry[],
  counts: { picked: number; failedScreenshots: number; unreadable: number; feedDates?: number; backfillDropped?: number; reviewsCutOff?: number },
): string[] {
  const notices: string[] = [];
  if (counts.picked > THEATR_MAX_SCREENSHOTS) {
    notices.push(`Only the first ${THEATR_MAX_SCREENSHOTS} screenshots were read. Run the import again for the rest.`);
  }
  if (counts.failedScreenshots > 0) {
    notices.push(`${counts.failedScreenshots} screenshot(s) couldn’t be read this time, so some shows may be missing. You can import them again later.`);
  }
  if (counts.unreadable > 0) {
    notices.push(`${counts.unreadable} image(s) didn’t look like a Theatr profile and were skipped.`);
  }
  const attended = entries.filter((e) => e.kind === 'diary');
  const scored = attended.filter((e) => e.rating !== null).length;
  if (scored > 0) {
    notices.push(`${scored} show(s) have a score you wrote in your review, so that is used as the rating.`);
  }
  if (counts.feedDates || counts.backfillDropped) {
    notices.push(`Dates are when you logged each show in Theatr, so check them.${counts.backfillDropped ? ' A day you logged several shows at once isn’t used.' : ''}`);
  }
  if (counts.reviewsCutOff) {
    notices.push(`${counts.reviewsCutOff} review(s) were cut off between screenshots, so their text wasn’t imported. Take screenshots that overlap a little to bring it in.`);
  }
  // Reaction rows are rated by the preview's reaction settings, so only rows
  // with neither a score nor a reaction are certain to stay unrated.
  const undatedUnrated = attended.filter((e) => !e.date && e.rating === null && !e.reaction).length;
  if (undatedUnrated > 0) {
    notices.push(`${undatedUnrated} seen show(s) have no date, reaction or score, so they go to your watchlist. You can rate them from there.`);
  }
  return notices;
}

/** Error code for a failed functions.invoke: the gateway's own 401 (expired
 *  session, verify_jwt) must read as "sign in again", not "try later". */
function invokeErrorCode(error: unknown): string {
  const status = (error as { context?: { status?: number } } | null)?.context?.status;
  return status === 401 ? 'unauthorized' : 'internal';
}

/** Read Theatr screenshots via the theatr-screenshot-import function.
 *  Throws Error with user-ready copy when nothing usable came back. */
export async function acquireFromTheatrScreenshots(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportAcquireResult> {
  if (files.length === 0) throw new Error(THEATR_ERROR_COPY.no_shows);
  const supabase = await getSupabaseClient();
  if (!supabase) throw new Error(THEATR_ERROR_COPY.unauthorized);

  // Picker order: the feed walk needs screenshots top to bottom, which is the
  // order users pick them in (and IMG_ name order). File dates are not used:
  // phone pickers stamp them at export time, not capture time.
  const picked = files.slice(0, THEATR_MAX_SCREENSHOTS);
  const batches = overlapBatches(picked.map((_, i) => i), THEATR_BATCH_SIZE);
  // Indexed by batch so the stitch sees rows in screenshot order, whichever
  // batch finishes first.
  const rowsByBatch: TheatrRow[][] = batches.map(() => []);
  const read = new Set<number>(); // screenshots a successful call covered
  const seen = new Set<number>(); // for progress: each screenshot once
  let unreadable = 0;
  let firstError: string | null = null;
  onProgress?.(0, picked.length);

  const runBatch = async (batchIndex: number) => {
    const batch = batches[batchIndex];
    // One unreadable file must not sink the other screenshots in its batch.
    const encoded = await Promise.allSettled(batch.map((i) => screenshotToJpegBase64(picked[i])));
    const ok = batch.filter((_, j) => encoded[j].status === 'fulfilled');
    const images = encoded.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (images.length < batch.length && !firstError) firstError = 'invalid_images';
    try {
      if (images.length === 0) return;
      const { data, error } = await supabase.functions.invoke<TheatrScreenshotResponse>('theatr-screenshot-import', {
        body: { images },
      });
      if (error || !data) throw new Error(invokeErrorCode(error));
      if (!data.ok) throw new Error(data.error || 'internal');
      rowsByBatch[batchIndex] = data.entries || [];
      ok.forEach((i) => read.add(i));
      unreadable += data.unreadableImages || 0;
    } catch (err) {
      const code = err instanceof Error ? err.message : 'internal';
      if (!firstError || firstError === 'invalid_images') firstError = code;
    } finally {
      batch.forEach((i) => seen.add(i));
      onProgress?.(seen.size, picked.length);
    }
  };

  // Small worker pool: each batch is one model call (~10-30s), so running two
  // at once halves the wait without tripping the per-hour call cap.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(THEATR_CONCURRENCY, batches.length) }, async () => {
    while (next < batches.length) await runBatch(next++);
  }));

  const { entries, feedDates, backfillDropped, reviewsCutOff } = theatrRowsPipeline(rowsByBatch, localToday());
  if (entries.length === 0) {
    const code = firstError || 'no_shows';
    throw new Error(THEATR_ERROR_COPY[code] || THEATR_ERROR_COPY.internal);
  }
  return {
    entries,
    notices: theatrNotices(entries, {
      picked: files.length,
      failedScreenshots: picked.length - read.size,
      unreadable,
      feedDates,
      backfillDropped,
      reviewsCutOff,
    }),
  };
}
