/**
 * Shared Diary analytics (BRO-4566). Few on purpose: do friends open shared
 * diaries and tap through, and do owners share them? Never a token, user id
 * or note text (see src/lib/share-links/events.ts).
 */
import { trackShareEvent } from '@/lib/share-links/events';

export type SharedDiaryEvent =
  | { name: 'diary_page_viewed'; props: { shows: number; notes: boolean } }
  | { name: 'diary_show_tapped'; props: { show_id: string } }
  // Owner side
  | { name: 'diary_share_enabled'; props: { shows: number } }
  | { name: 'diary_shared'; props: { method: 'native-sheet' | 'copy' } }
  | { name: 'diary_share_stopped'; props: Record<string, never> }
  | { name: 'diary_link_reset'; props: Record<string, never> };

export function trackSharedDiary(e: SharedDiaryEvent): void {
  trackShareEvent(e.name, e.props);
}
