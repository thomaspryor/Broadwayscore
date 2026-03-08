'use client';

import { useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';

interface Review {
  showId: string;
  outletId: string;
  outlet: string;
  criticName?: string;
  url: string;
  publishDate: string;
  tier: 1 | 2 | 3;
  reviewScore: number;
  designation?: string;
  pullQuote?: string;
}

interface CollapsibleReviewsProps {
  reviews: Review[];
  initialCount?: number;
  renderReview: (review: Review, index: number) => React.ReactNode;
}
