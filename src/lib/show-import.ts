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
}

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

  const supabase = getSupabaseClient();
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
// login, so the user uploads screenshots of Profile → Collection → Attended /
// Interested and the theatr-screenshot-import edge function reads them.

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
  no_shows: 'We couldn’t find any shows in those screenshots. In Theatr, open Profile, then Collection, then Attended (or Interested), and screenshot the list.',
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
  date: string | null;
  list: 'attended' | 'interested';
}

/**
 * Collapse rows repeated across overlapping screenshots, keeping screenshot
 * order. Same rule as the edge function's per-batch pass (normalize.mjs) and
 * the iOS app's lib/theatr-import.ts: one row per list + title + date, and an
 * undated Attended row folds into a dated row for the same title (its date
 * was just cropped off), so it can't race the dated copy into the watchlist.
 */
export function mergeTheatrRows(rows: TheatrRow[]): TheatrRow[] {
  const out: TheatrRow[] = [];
  const byKey = new Map<string, TheatrRow>();
  const titleKey = (r: TheatrRow) => `${r.list}|${r.title.toLowerCase()}`;
  const datedTitles = new Set(rows.filter((r) => r.list === 'attended' && r.date).map(titleKey));
  for (const r of rows) {
    const undatedDup = r.list === 'attended' && !r.date && datedTitles.has(titleKey(r));
    const key = undatedDup ? null : `${titleKey(r)}|${r.date || ''}`;
    const prev = key ? byKey.get(key) : out.find((o) => titleKey(o) === titleKey(r) && o.date);
    if (prev) {
      if (!prev.venue && r.venue) prev.venue = r.venue;
      continue;
    }
    if (!key) continue; // dated copy not reached yet: it will carry the row
    const copy = { ...r };
    byKey.set(key, copy);
    out.push(copy);
  }
  return out;
}

/** Split a list into consecutive batches of `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Map Theatr rows onto the shared import contract. Theatr reactions are
 * like / mixed / dislike, not star ratings, so attended shows carry no rating
 * and land in To Be Rated (the importer files unrated diary rows as dated
 * watchlist rows) rather than getting a guessed score.
 */
export function theatrRowsToEntries(rows: TheatrRow[]): RawImportEntry[] {
  return rows.map((r) => r.list === 'attended'
    ? { title: r.title, venue: r.venue, rating: null, sourceScore: null, date: r.date, reviewText: null, kind: 'diary' as const }
    : { title: r.title, venue: r.venue, rating: null, sourceScore: null, date: null, reviewText: null, kind: 'watchlist' as const, listName: 'Interested' });
}

/** Preview notices for a finished Theatr read. */
export function theatrNotices(
  entries: RawImportEntry[],
  counts: { picked: number; failedScreenshots: number; unreadable: number },
): string[] {
  const notices: string[] = [];
  if (counts.picked > THEATR_MAX_SCREENSHOTS) {
    notices.push(`Only the first ${THEATR_MAX_SCREENSHOTS} screenshots were read. Run the import again for the rest.`);
  }
  if (counts.failedScreenshots > 0) {
    notices.push(`${counts.failedScreenshots} screenshot(s) couldn\u2019t be read this time, so some shows may be missing. You can import them again later.`);
  }
  if (counts.unreadable > 0) {
    notices.push(`${counts.unreadable} image(s) didn\u2019t look like a Theatr collection and were skipped.`);
  }
  const attended = entries.filter((e) => e.kind === 'diary');
  if (attended.length > 0) {
    notices.push('Theatr reactions aren\u2019t star ratings, so seen shows import to To Be Rated, where you can rate them.');
  }
  const undated = attended.filter((e) => !e.date).length;
  if (undated > 0) {
    notices.push(`${undated} seen show(s) had no readable date and will land on your watchlist instead. You can rate them from there.`);
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
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error(THEATR_ERROR_COPY.unauthorized);

  const picked = files.slice(0, THEATR_MAX_SCREENSHOTS);
  const batches = chunk(picked, THEATR_BATCH_SIZE);
  // Indexed by batch so the merge sees rows in screenshot order, whichever
  // batch finishes first.
  const rowsByBatch: TheatrRow[][] = batches.map(() => []);
  let unreadable = 0;
  let failedScreenshots = 0;
  let firstError: string | null = null;
  let done = 0;
  onProgress?.(0, picked.length);

  const runBatch = async (batchIndex: number) => {
    const batch = batches[batchIndex];
    // One unreadable file must not sink the other screenshots in its batch.
    const encoded = await Promise.allSettled(batch.map(screenshotToJpegBase64));
    const images = encoded.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    failedScreenshots += batch.length - images.length;
    if (images.length < batch.length && !firstError) firstError = 'invalid_images';
    try {
      if (images.length === 0) return;
      const { data, error } = await supabase.functions.invoke<TheatrScreenshotResponse>('theatr-screenshot-import', {
        body: { images },
      });
      if (error || !data) throw new Error(invokeErrorCode(error));
      if (!data.ok) throw new Error(data.error || 'internal');
      rowsByBatch[batchIndex] = data.entries || [];
      unreadable += data.unreadableImages || 0;
    } catch (err) {
      failedScreenshots += images.length;
      const code = err instanceof Error ? err.message : 'internal';
      if (!firstError || firstError === 'invalid_images') firstError = code;
    } finally {
      done += batch.length;
      onProgress?.(done, picked.length);
    }
  };

  // Small worker pool: each batch is one model call (~10-30s), so running two
  // at once halves the wait without tripping the per-hour call cap.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(THEATR_CONCURRENCY, batches.length) }, async () => {
    while (next < batches.length) await runBatch(next++);
  }));

  const merged = mergeTheatrRows(rowsByBatch.flat());
  if (merged.length === 0) {
    const code = firstError || 'no_shows';
    throw new Error(THEATR_ERROR_COPY[code] || THEATR_ERROR_COPY.internal);
  }
  const entries = theatrRowsToEntries(merged);
  return { entries, notices: theatrNotices(entries, { picked: files.length, failedScreenshots, unreadable }) };
}
