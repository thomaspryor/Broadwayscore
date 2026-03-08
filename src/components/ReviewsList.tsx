'use client';

import { useState, useMemo, memo } from 'react';
import Link from 'next/link';
import { getOutletLogoUrl, getOutletConfig } from '@/config/outlet-logos';
import { featureFlags } from '@/config/feature-flags';
import { getScoreColorClass } from '@/components/show-cards';
import { ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon } from '@/components/icons';

interface Review {
  showId: string;
  outletId: string;
  outlet: string;
  outletSlug?: string;
  criticName?: string;
  criticSlug?: string | null;
  url: string;
  publishDate: string;
  tier: 1 | 2 | 3;
  reviewScore: number;
  designation?: string;
  quote?: string;
  summary?: string;
  pullQuote?: string;
}

interface ReviewsListProps {
  reviews: Review[];
  initialCount?: number;
}
