'use client';

import { useShareRow, type ShareRowConfig } from './useShareRow';
import { diaryShareUrl } from '@/lib/shared-diary/share-url';

/**
 * The signed-in user's Shared Diary link (BRO-4566). The client contract and
 * the stop/re-share rule live in useShareRow. `show_text` (written notes) is
 * off by default in the database; release 1 never sends it.
 */
export interface DiaryShare {
  token: string;
  enabled: boolean;
  show_text: boolean;
  display_name: string;
}

const CONFIG: ShareRowConfig<DiaryShare> = {
  table: 'diary_shares',
  rotateFn: 'rotate_diary_share_token',
  columns: 'token,enabled,show_text,display_name',
  url: diaryShareUrl,
  defaults: { show_text: false },
};

export function useDiaryShare(userId: string | null, opts: { mock?: boolean } = {}) {
  return useShareRow(userId, CONFIG, opts);
}
