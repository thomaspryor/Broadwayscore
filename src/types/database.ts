// Supabase database types — hand-written to match our schema
// (simpler than supabase gen types which needs CLI setup)

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string;
          avatar_url: string | null;
          default_visibility: 'public' | 'private';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name: string;
          avatar_url?: string | null;
          default_visibility?: 'public' | 'private';
        };
        Update: {
          display_name?: string;
          avatar_url?: string | null;
          default_visibility?: 'public' | 'private';
          updated_at?: string;
        };
      };
      reviews: {
        Row: {
          id: string;
          user_id: string;
          show_id: string;
          rating: number;
          review_text: string | null;
          date_seen: string | null;
          visibility: 'public' | 'private';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          show_id: string;
          rating: number;
          review_text?: string | null;
          date_seen?: string | null;
          visibility?: 'public' | 'private';
        };
        Update: {
          rating?: number;
          review_text?: string | null;
          date_seen?: string | null;
          visibility?: 'public' | 'private';
          updated_at?: string;
        };
      };
      watchlist: {
        Row: {
          id: string;
          user_id: string;
          show_id: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          show_id: string;
        };
      };
    };
  };
}
