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
}

// Pending action for deferred auth flow
export interface PendingAction {
  type: 'rating' | 'watchlist';
  showId: string;
  rating?: number;
  reviewText?: string;
  dateSeen?: string;
  returnUrl: string;
  timestamp: number;
}
