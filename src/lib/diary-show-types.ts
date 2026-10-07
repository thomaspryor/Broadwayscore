// Client-safe types + helpers for diary-only shows — no Node fs/path imports
// here so DiaryShowClient.tsx (a client component) can import from this file.
// The actual file read lives in diary-show.ts (server-only).

export interface DiaryShowDetail {
  id: string;
  title: string;
  slug: string;
  venue: string;
  city: string | null;
  country: string | null;
  category: string | null;
  openingDate: string | null;
  posterUrl: string | null;
}

const MARKET_LABELS: Record<string, string> = {
  'off-broadway': 'Off-Broadway',
  'west-end': 'West End',
  'us-regional': 'Regional (US)',
  'uk-regional': 'Regional (UK)',
  international: 'International',
  other: 'Other',
};

export function marketLabel(category: string | null): string {
  if (!category) return 'Regional';
  return MARKET_LABELS[category] || 'Regional';
}
