'use client';

import { useEffect } from 'react';
import { useToastSafe } from '@/components/ui/Toast';
import { LOCAL_WATCHLIST_MIGRATED_EVENT } from '@/lib/local-watchlist';

/**
 * "Saved to your account." after bookmarks saved while signed out move into
 * the account (BRO-6917 Part 3). The ratings migrator toasts for ratings
 * itself; this is the same confirmation for the want-to-see list. Mounted once
 * under the toast provider; renders nothing.
 */
export default function LocalSavesConfirmation() {
  const { showToast } = useToastSafe();
  useEffect(() => {
    const onMigrated = (e: Event) => {
      const added = Number((e as CustomEvent<{ added?: number }>).detail?.added ?? 0);
      if (added <= 0) return;
      showToast?.(added === 1 ? 'Saved to your account.' : `${added} shows saved to your account.`, 'success');
    };
    document.addEventListener(LOCAL_WATCHLIST_MIGRATED_EVENT, onMigrated);
    return () => document.removeEventListener(LOCAL_WATCHLIST_MIGRATED_EVENT, onMigrated);
  }, [showToast]);
  return null;
}
