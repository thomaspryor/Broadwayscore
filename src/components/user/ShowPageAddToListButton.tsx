'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserLists } from '@/hooks/useUserLists';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction, getPendingAction, clearPendingAction } from '@/lib/deferred-auth';
import { featureFlags } from '@/config/feature-flags';

interface ShowPageAddToListButtonProps {
  showId: string;
}

export default function ShowPageAddToListButton({ showId }: ShowPageAddToListButtonProps) {
  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { lists, getLists, addToList, removeFromList, createList } = useUserLists(user?.id || null);
  const { showToast } = useToastSafe();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasAutoOpened = useRef(false);
  const [listsReady, setListsReady] = useState(false);

  useEffect(() => {
    if (isAuthenticated && user) {
      getLists().then(() => setListsReady(true));
    }
  }, [isAuthenticated, user, getLists]);

  // Auto-open dropdown after deferred auth (user tapped List before signing in)
  useEffect(() => {
    if (!isAuthenticated || !user || hasAutoOpened.current || !listsReady) return;
    const pending = getPendingAction();
    if (pending?.type === 'add-to-list' && pending.showId === showId) {
      hasAutoOpened.current = true;
      clearPendingAction();
      setOpen(true);
    }
  }, [isAuthenticated, user, listsReady, showId]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewName('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus input when creating
  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [creating]);

  const handleOpen = useCallback(() => {
    if (!isAuthenticated && !authLoading) {
      savePendingAction({
        type: 'add-to-list',
        showId,
        returnUrl: window.location.pathname,
        timestamp: Date.now(),
      });
      showSignIn('generic');
      return;
    }
    setOpen(prev => !prev);
  }, [isAuthenticated, authLoading, showId, showSignIn]);

  const isInList = useCallback((listId: string) => {
    const list = lists.find(l => l.id === listId);
    return list?.all_show_ids?.includes(showId) || false;
  }, [lists, showId]);

  const handleToggleList = useCallback(async (listId: string) => {
    setBusy(listId);
    try {
      const inList = isInList(listId);
      if (inList) {
        await removeFromList(listId, showId);
        showToast?.('Removed from list', 'info');
      } else {
        await addToList(listId, showId);
        const listName = lists.find(l => l.id === listId)?.name || 'list';
        showToast?.(<>Added to <a href={`/my-shows?tab=lists&list=${listId}`} className="underline hover:text-white/90">{listName}</a></>, 'success');
      }
    } catch {
      showToast?.('Failed to update list', 'error');
    } finally {
      setBusy(null);
    }
  }, [showId, isInList, addToList, removeFromList, lists, showToast]);

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setBusy('new');
    try {
      const newList = await createList(trimmed);
      if (newList) {
        await addToList(newList.id, showId);
        showToast?.(<>Added to <a href={`/my-shows?tab=lists&list=${newList.id}`} className="underline hover:text-white/90">{trimmed}</a></>, 'success');
        setCreating(false);
        setNewName('');
      }
    } catch {
      showToast?.('Failed to create list', 'error');
    } finally {
      setBusy(null);
    }
  }, [newName, createList, addToList, showId, showToast]);

  if (!featureFlags.userAccounts) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={handleOpen}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all duration-200 bg-surface-overlay border-white/10 text-gray-300 hover:text-white hover:bg-white/10 cursor-pointer"
        aria-label="Add to list"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h10m-4 4h4m2-2v4m0 0h-4m4 0h4" />
        </svg>
        <span className="hidden sm:inline">List</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-[#1a1a2e] border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
          {/* Header */}
          <div className="px-3 py-2 border-b border-white/10 text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Add to List
          </div>

          {/* List items */}
          <div className="max-h-48 overflow-y-auto">
            {lists.length === 0 && !creating && (
              <div className="px-3 py-3 text-xs text-gray-500 text-center">
                No lists yet
              </div>
            )}
            {lists.map(list => {
              const inList = isInList(list.id);
              const isBusy = busy === list.id;
              return (
                <button
                  key={list.id}
                  type="button"
                  onClick={() => handleToggleList(list.id)}
                  disabled={isBusy}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                  {/* Checkbox */}
                  <span className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                    inList ? 'bg-[#FFD700] border-[#FFD700]' : 'border-white/20'
                  }`}>
                    {inList && (
                      <svg className="w-3 h-3 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  <span className="text-gray-200 truncate">{list.name}</span>
                  {list.is_ranked && (
                    <span className="text-[10px] text-gray-500 ml-auto flex-shrink-0">#</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Create new */}
          <div className="border-t border-white/10">
            {creating ? (
              <form
                onSubmit={e => { e.preventDefault(); handleCreate(); }}
                className="flex items-center gap-1 px-2 py-1.5"
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="List name"
                  maxLength={100}
                  className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none border-b border-white/20 focus:border-[#FFD700]/50 px-1 py-1"
                />
                <button
                  type="submit"
                  disabled={!newName.trim() || busy === 'new'}
                  className="text-xs text-[#FFD700] hover:text-[#FFD700]/80 disabled:opacity-30 px-1 py-1 font-medium"
                >
                  {busy === 'new' ? '...' : 'Add'}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Create new list
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
