import type { ImageResponse } from 'next/og';
import { renderShareCard, type ShareCardInput } from '@/lib/share-links/og-card';
import { diarySummary, diaryTitle, type SharedDiaryView } from './view-model';

/**
 * The Shared Diary link-preview card (BRO-4566): name, shows-seen count, up
 * to four recent posters. Never note text, even when notes are shared: a
 * preview shows up in group chats the owner didn't pick.
 */
export function diaryCardInput(view: Pick<SharedDiaryView, 'name' | 'showsSeen' | 'recentPosters'>): ShareCardInput {
  return { title: diaryTitle(view.name), summary: diarySummary(view.showsSeen), posterUrls: view.recentPosters };
}

export function renderDiaryCard(view: SharedDiaryView): Promise<ImageResponse> {
  return renderShareCard(diaryCardInput(view));
}
