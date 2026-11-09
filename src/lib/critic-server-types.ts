// Client-safe type for the public critic profile (critic-server.ts is server-only).
export interface PublicCriticProfile {
  slug: string; photoUrl: string | null; jobTitle: string | null; bio: string | null;
  outlets: string[]; links: { label: string; url: string }[];
  picks: { bestEver?: string; thisSeason?: string }; pinnedReviewKey: string | null;
}
