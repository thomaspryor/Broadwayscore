'use client';
import type { UserReview, ShowLookup } from '@/types/user';

export interface StatsTabProps {
  reviews: UserReview[];
  showMap: Record<string, ShowLookup>;
  isMockMode: boolean;
}

export default function StatsTab(_props: StatsTabProps) {
  return <div className="py-8 text-gray-400">Stats coming soon</div>;
}
