'use client';
import type { UserReview, ShowLookup } from '@/types/user';

export interface FeedTabProps {
  reviews: UserReview[];
  showMap: Record<string, ShowLookup>;
  userId: string | null;
  isMockMode: boolean;
}

export default function FeedTab(_props: FeedTabProps) {
  return <div className="py-8 text-gray-400">Feed coming soon</div>;
}
