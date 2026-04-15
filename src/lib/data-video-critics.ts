import videoCreatorsData from '@/../data/video-creators.json';
import videoReviewsData from '@/../data/video-reviews.json';
import showsData from '@/../data/shows.json';

export interface VideoCreatorProfile {
  id: string;
  name: string;
  slug: string;
  platform: string;
  handle: string;          // e.g. "tylernabinger" (no @)
  profileUrl: string;      // e.g. "https://www.tiktok.com/@tylernabinger"
  subscribers: string | null;
  reviewCount: number;
  avgScore: number;
  highScore: number;
  lowScore: number;
  volumeRank: number;
  generosityRank: number;
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

function parsePublishedAt(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  const normalized = dateStr.length === 8 && /^\d{8}$/.test(dateStr)
    ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
    : dateStr;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? 0 : t;
}

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

  // Default sort: most recent first (matches /critics page default).
  // publishedAt is YYYYMMDD (no dashes) — Date.parse returns NaN on that, so normalize first.
  reviews.sort((a, b) => parsePublishedAt(b.publishedAt) - parsePublishedAt(a.publishedAt));

  const avgScore = Math.round(reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length);
  const highScore = reviews.reduce((m, r) => Math.max(m, r.score), 0);
  const lowScore = reviews.reduce((m, r) => Math.min(m, r.score), 100);

  const primary = creator.primaryPlatform;
  const platformData = (creator.platforms as any)?.[primary] || {};
  const handle: string = platformData.handle || platformData.channelHandle || creator.id;
  const profileUrl = primary === 'youtube'
    ? `https://www.youtube.com/@${handle}`
    : `https://www.tiktok.com/@${handle}`;

  return {
    id: creator.id,
    name: creator.name,
    slug: creator.id, // use id as slug
    platform: primary,
    handle,
    profileUrl,
    subscribers: creator.subscribers || null,
    reviewCount: reviews.length,
    avgScore,
    highScore,
    lowScore,
    volumeRank: 0,
    generosityRank: 0,
    reviews,
  };
}

// Build all profiles at module load
const profiles = new Map<string, VideoCreatorProfile>();
for (const creator of creators) {
  const profile = buildCreatorProfile(creator);
  if (profile) profiles.set(profile.slug, profile);
}

// Compute ranks once across all profiles
{
  const all: VideoCreatorProfile[] = [];
  profiles.forEach(p => all.push(p));

  const byVolume = [...all].sort((a, b) => b.reviewCount - a.reviewCount);
  byVolume.forEach((p, i) => { p.volumeRank = i + 1; });

  const byGenerosity = [...all].sort((a, b) => b.avgScore - a.avgScore);
  byGenerosity.forEach((p, i) => { p.generosityRank = i + 1; });
}

export function getVideoCreatorBySlug(slug: string): VideoCreatorProfile | null {
  return profiles.get(slug) || null;
}

export function getAllVideoCreatorSlugs(): string[] {
  const slugs: string[] = [];
  profiles.forEach((_, slug) => slugs.push(slug));
  return slugs;
}

export function getAllVideoCreators(): VideoCreatorProfile[] {
  const all: VideoCreatorProfile[] = [];
  profiles.forEach(p => all.push(p));
  return all.sort((a, b) => b.reviewCount - a.reviewCount);
}
