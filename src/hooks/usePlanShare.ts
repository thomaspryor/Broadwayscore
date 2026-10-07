'use client';

import { useCallback } from 'react';
import { useShareRow, type ShareRowConfig } from './useShareRow';
import { planShareUrl } from '@/lib/shared-plans/share-url';

/**
 * The signed-in user's Shared Plans link (BRO-4481). Same method names as the
 * iOS app's hooks/usePlanShare.ts. The client contract and the stop/re-share
 * rule live in useShareRow.
 */
export interface PlanShare {
  token: string;
  enabled: boolean;
  show_booked: boolean;
  show_unbooked: boolean;
  display_name: string;
}

export type PlanSharePatch = Partial<Pick<PlanShare, 'enabled' | 'show_booked' | 'show_unbooked' | 'display_name'>>;

const CONFIG: ShareRowConfig<PlanShare> = {
  table: 'plan_shares',
  rotateFn: 'rotate_plan_share_token',
  columns: 'token,enabled,show_booked,show_unbooked,display_name',
  url: planShareUrl,
  defaults: { show_booked: true, show_unbooked: true },
};

export function usePlanShare(userId: string | null, opts: { mock?: boolean } = {}) {
  const row = useShareRow(userId, CONFIG, opts);
  const { ensure: ensureRow } = row;
  const ensure = useCallback(
    (s: { displayName: string; showBooked: boolean; showUnbooked: boolean }) =>
      ensureRow({ display_name: s.displayName, show_booked: s.showBooked, show_unbooked: s.showUnbooked }),
    [ensureRow],
  );
  return { ...row, ensure };
}
