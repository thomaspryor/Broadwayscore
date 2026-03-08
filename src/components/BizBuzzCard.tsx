'use client';

import { useState } from 'react';
import type { ShowCommercial, RecoupmentTrend } from '@/lib/data-types';
import { getDesignationBadgeStyle, getTrendColor, getTrendIcon } from '@/config/commercial';
import RecoupmentProgressBar from './RecoupmentProgressBar';
import { ChevronDownIcon } from '@/components/icons';
import { formatCurrency } from '@/lib/formatting';

interface BizBuzzCardProps {
  commercial: ShowCommercial;
  showTitle: string;
  trend?: RecoupmentTrend;
  weeklyGross?: number | null;
  showStatus?: 'open' | 'closed' | 'previews' | 'upcoming';
  allTimeGross?: number | null;
}

function formatWithEstimate(formatted: string, isEstimate: boolean): string {
  return isEstimate ? `~${formatted}` : formatted;
}

function formatWeeksToRecoup(weeks: number | null): string {
  if (weeks === null) return '';
  if (weeks < 52) {
    return `${weeks} weeks`;
  }
  const years = (weeks / 52).toFixed(1);
  return `~${years} years`;
}

function RecoupmentBadge({ recouped }: { recouped: boolean | null }) {
  if (recouped === true) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        Recouped
      </span>
    );
  }
  if (recouped === false) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-500/15 text-orange-400 border border-orange-500/25">
        Not Recouped
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/15 text-gray-400 border border-gray-500/25">
      Unknown
    </span>
  );
}
