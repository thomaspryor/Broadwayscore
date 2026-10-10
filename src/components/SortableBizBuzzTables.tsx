'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getDesignationColor, getDesignationIcon } from '@/config/commercial';

type SortDirection = 'asc' | 'desc';

interface CommercialData {
  designation: string;
  capitalization: number | null;
  recouped: boolean | null;
  recoupedWeeks: number | null;
  recoupedDate: string | null;
}

interface ShowCommercialData {
  show: {
    slug: string;
    title: string;
    status: string;
  };
  commercial: CommercialData | null | undefined;
}

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(1)}M`;
  }
  return `$${(amount / 1000).toFixed(0)}K`;
}

function SortIcon({ direction, active }: { direction: SortDirection | null; active: boolean }) {
  if (!active) {
    return (
      <span className="ml-1 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
        ↕
      </span>
    );
  }
  return (
    <span className="ml-1 text-brand">
      {direction === 'asc' ? '↑' : '↓'}
    </span>
  );
}

