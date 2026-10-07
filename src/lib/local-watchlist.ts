/**
 * Signed-out watchlist ("save first, ask later", BRO-4616).
 *
 * A signed-out tap on a bookmark / Want to See used to open the sign-in modal
 * before anything was saved; on phones every one of those prompts was closed
 * within ~1 s (PostHog, accounts launch day 2026-10-04). Now the show is saved
 * on this device right away, and sign-in is offered as the way to keep it.
 * useWatchlist moves these into the account on the next sign-in.
 *
 * Pure decision helpers are exported for tests (CLAUDE.md §15); the storage
 * wrappers swallow storage errors (private mode, blocked site data) so a
 * failed read just means "nothing saved locally".
 */

export const LIST_KEY = 'bsc_local_watchlist';
const PROMPTED_KEY = 'bsc_local_watchlist_prompted_at';
export const LOCAL_WATCHLIST_SYNC = 'local-watchlist-sync';

/** The sign-in sheet appears right after this many local saves (the save happens first)… */
export const PROMPT_AT_COUNT = 1;
/** …and not again for this long after it was shown. */
export const PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
/** Bound the list so a runaway loop can't fill storage. */
export const MAX_LOCAL_SHOWS = 200;

export interface LocalWatchlistEntry {
  showId: string;
  savedAt: number;
}

/** Parse whatever is in storage; anything malformed counts as empty. */
export function parseLocalWatchlist(raw: string | null): LocalWatchlistEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: LocalWatchlistEntry[] = [];
    for (const e of parsed) {
      if (!e || typeof e !== 'object') continue;
      const { showId, savedAt } = e as Record<string, unknown>;
      if (typeof showId !== 'string' || !showId || seen.has(showId)) continue;
      seen.add(showId);
      out.push({ showId, savedAt: typeof savedAt === 'number' ? savedAt : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

/** Newest first; re-adding an existing show is a no-op. */
export function addEntry(list: LocalWatchlistEntry[], showId: string, now: number): LocalWatchlistEntry[] {
  if (list.some(e => e.showId === showId)) return list;
  return [{ showId, savedAt: now }, ...list].slice(0, MAX_LOCAL_SHOWS);
}

export function removeEntry(list: LocalWatchlistEntry[], showId: string): LocalWatchlistEntry[] {
  return list.filter(e => e.showId !== showId);
}

/**
 * Should this local save open the sign-in sheet (instead of only a toast)?
 * Yes on reaching PROMPT_AT_COUNT saved shows, unless the sheet was shown
 * within the cooldown. The save always happens first; the sheet follows it.
 */
export function shouldPromptAfterSave(count: number, lastPromptedAt: number | null, now: number): boolean {
  if (count < PROMPT_AT_COUNT) return false;
  if (lastPromptedAt !== null && now - lastPromptedAt < PROMPT_COOLDOWN_MS) return false;
  return true;
}

/** Shows to copy into the account: local ones the account doesn't have yet, oldest first. */
export function showsToMigrate(local: LocalWatchlistEntry[], accountShowIds: Iterable<string>): string[] {
  const have = new Set(accountShowIds);
  return [...local].reverse().map(e => e.showId).filter(id => !have.has(id));
}

// ─── storage wrappers ────────────────────────────────────────────────────

// Used only when localStorage throws (blocked storage): keeps saves and the
// prompt cooldown alive for the life of the page, so a second tap removes
// the show instead of re-adding it and re-opening the sign-in sheet.
let memoryList: LocalWatchlistEntry[] | null = null;
let memoryPromptedAt: number | null = null;

export function getLocalWatchlist(): LocalWatchlistEntry[] {
  try {
    return parseLocalWatchlist(localStorage.getItem(LIST_KEY));
  } catch {
    return memoryList ?? [];
  }
}

function writeLocalWatchlist(list: LocalWatchlistEntry[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(LIST_KEY);
    else localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the save lives only as long as this page
    memoryList = list;
  }
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(LOCAL_WATCHLIST_SYNC, { detail: list }));
  }
}

export function addLocalShow(showId: string): LocalWatchlistEntry[] {
  const next = addEntry(getLocalWatchlist(), showId, Date.now());
  writeLocalWatchlist(next);
  return next;
}

export function removeLocalShow(showId: string): LocalWatchlistEntry[] {
  const next = removeEntry(getLocalWatchlist(), showId);
  writeLocalWatchlist(next);
  return next;
}

export function clearLocalWatchlist(): void {
  writeLocalWatchlist([]);
}

export function getLastPromptedAt(): number | null {
  try {
    const v = Number(localStorage.getItem(PROMPTED_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return memoryPromptedAt;
  }
}

export function markPrompted(now: number = Date.now()): void {
  try {
    localStorage.setItem(PROMPTED_KEY, String(now));
  } catch {
    memoryPromptedAt = now;
  }
}
