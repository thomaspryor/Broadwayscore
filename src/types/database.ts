export interface Profile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
  updated_at: string;
}

export interface Rating {
  id: string;
  user_id: string;
  show_id: string;
  score: number;
  review_text: string | null;
  date_attended: string;
  created_at: string;
  updated_at: string;
}

export interface CommunityScoreRow {
  show_id: string;
  unique_raters: number;
  total_ratings: number;
  avg_score: number;
}
