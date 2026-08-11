// User data types for ratings, reviews, watchlist, and profiles
// Used by UI components in Sprint 1 (no Supabase dependency)

export interface UserProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  default_visibility: 'public' | 'private';
  created_at: string;
  updated_at: string;
}

export interface UserReview {
  id: string;
  user_id: string;
  show_id: string;
  rating: number; // 0.5 to 5.0, half-star precision
  review_text: string | null;
  date_seen: string | null; // ISO date string (YYYY-MM-DD)
  visibility: 'public' | 'private';
  created_at: string;
  updated_at: string;
}

export interface WatchlistEntry {
  id: string;
  user_id: string;
  show_id: string;
  planned_date: string | null; // ISO date string (YYYY-MM-DD)
  /** How the curtain time was chosen. null = no time set (all-day entry). */
  time_slot: 'matinee' | 'evening' | 'custom' | null;
  /**
   * Local wall-clock curtain time (HH:MM:SS as PostgREST returns a TIME column)
   * in the SHOW's market timezone, not the viewer's. Null is legitimate even
   * with a time_slot set — a matinee/evening slot can be known for a date
   * without an exact clock time.
   */
  curtain_time: string | null;
  created_at: string;
}

export interface ShowLookup {
  id: string;
  title: string;
  slug: string;
  venue: string;
  type: 'musical' | 'play';
  status: string;
  category: string;
  previewDate: string | null;
  openingDate: string | null;
  closingDate: string | null;
  compositeScore: number | null;
  posterUrl: string | null;
  diaryOnly?: boolean;
  /** Tickets on sale for a not-yet-open show (watchlist bookability label). */
  ticketsOnSale?: boolean;
  /** Street address for calendar LOCATION and the Get-directions link (~741 shows). */
  theaterAddress?: string;
  /**
   * Parsed runtime in minutes (~631 shows). Absent for most entries, so the
   * calendar path falls back to a generic default — see
   * src/lib/calendar/duration.ts.
   */
  runtimeMin?: number;
}

export interface UserList {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  is_ranked: boolean;
  is_public: boolean;
  share_slug: string | null;
  created_at: string;
  updated_at: string;
  item_count?: number;
  preview_show_ids?: string[];
  all_show_ids?: string[];
}

export interface ListItem {
  id: string;
  list_id: string;
  show_id: string;
  position: number;
  note: string | null;
  created_at: string;
}

// Pending action for deferred auth flow
export interface PendingAction {
  type: 'rating' | 'watchlist' | 'add-to-list' | 'create-list-and-add';
  showId: string;
  rating?: number;
  reviewText?: string;
  dateSeen?: string;
  /** When set, the resumed rating edits/replaces this review; when absent, it appends a new viewing. */
  reviewId?: string;
  listId?: string;
  listName?: string;
  returnUrl: string;
  timestamp: number;
}
