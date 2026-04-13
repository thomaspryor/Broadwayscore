import videoReviewsData from '@/../data/video-reviews.json';

export interface VideoReview {
  creatorName: string;
  handle: string;
  platform: 'tiktok' | 'youtube' | 'instagram';
  videoUrl: string;
  score: number;
  views: string | null;
  bucket?: string;
  confidence?: string;
  reasoning?: string;
  keyQuote?: string;
  thumbnail?: string;
}

const { _meta, ...showReviews } = videoReviewsData;
const reviews = showReviews as unknown as Record<string, VideoReview[]>;

export function getVideoReviews(showId: string): VideoReview[] {
  return reviews[showId] || [];
}
