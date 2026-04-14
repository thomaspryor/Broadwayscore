import videoCreatorsData from '@/../data/video-creators.json';
import videoReviewsData from '@/../data/video-reviews.json';
import showsData from '@/../data/shows.json';

export interface VideoCreatorProfile {
  id: string;
  name: string;
  slug: string;
  platform: string;
  subscribers: string | null;
  reviewCount: number;
  avgScore: number;
  reviews: VideoCreatorReview[];
}

export interface VideoCreatorReview {
  showId: string;
  showTitle: string;
  showSlug: string;
  showThumbnail: string | null;
  showOpeningDate: string | null;
  score: number;
  bucket: string | null;
  publishedAt: string | null;
  videoUrl: string;
  platform: string;
  keyQuote: string | null;
}

const { _meta, ...showReviews } = videoReviewsData as Record<string, any>;
const creators = videoCreatorsData.creators;
const showsList = (showsData as any).shows as any[];

// Build show lookup
const showMap = new Map<string, any>();
for (const s of showsList) {
  if (s?.id) showMap.set(s.id, s);
}

function buildCreatorProfile(creator: typeof creators[0]): VideoCreatorProfile | null {
  const reviews: VideoCreatorReview[] = [];

  for (const [showId, showRevs] of Object.entries(showReviews)) {
    if (!Array.isArray(showRevs)) continue;
    for (const r of showRevs as any[]) {
      if (r.handle === creator.id) {
        const show = showMap.get(showId);
        reviews.push({
          showId,
          showTitle: show?.title || showId.replace(/-\d{4}$/, '').replace(/-/g, ' '),
          showSlug: show?.slug || showId.replace(/-\d{4}$/, ''),
          showThumbnail: show?.images?.poster || show?.images?.thumbnail || null,
          showOpeningDate: show?.openingDate || null,
          score: r.score,
          bucket: r.bucket || null,
          publishedAt: r.publishedAt || null,
          videoUrl: r.videoUrl,
          platform: r.platform,
          keyQuote: r.keyQuote || null,
        });
      }
    }
  }

  if (reviews.length === 0) return null;

  // Sort by score descending (default)
  reviews.sort((a, b) => b.score - a.score);

  const avgScore = Math.round(reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length);

  return {
    id: creator.id,
    name: creator.name,
    slug: creator.id, // use handle as slug
    platform: creator.primaryPlatform,
    subscribers: creator.subscribers || null,
    reviewCount: reviews.length,
    avgScore,
    reviews,
  };
}

// Build all profiles at module load
const profiles = new Map<string, VideoCreatorProfile>();
for (const creator of creators) {
  const profile = buildCreatorProfile(creator);
  if (profile) profiles.set(profile.slug, profile);
}

export function getVideoCreatorBySlug(slug: string): VideoCreatorProfile | null {
  return profiles.get(slug) || null;
}

export function getAllVideoCreatorSlugs(): string[] {
  return Array.from(profiles.keys());
}

export function getAllVideoCreators(): VideoCreatorProfile[] {
  return Array.from(profiles.values()).sort((a, b) => b.reviewCount - a.reviewCount);
}
