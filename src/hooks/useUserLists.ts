'use client';

import { useState, useCallback } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import type { UserList, ListItem } from '@/types/user';

const MAX_LISTS = 50;
const MAX_ITEMS_PER_LIST = 200;
const POSITION_GAP = 1000;

export function useUserLists(userId: string | null) {
  const [lists, setLists] = useState<UserList[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getLists = useCallback(async (): Promise<UserList[]> => {
    const client = getSupabaseClient();
    if (!client || !userId) return [];

    setLoading(true);
    setError(null);
    try {
      // Fetch lists with item counts and preview show_ids via a single query
      const { data: listsData, error: listsErr } = await client
        .from('lists')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });

      if (listsErr) throw listsErr;
      if (!listsData || listsData.length === 0) {
        setLists([]);
        return [];
      }

      // Fetch all list_items for these lists in one query
      const listIds = listsData.map((l: UserList) => l.id);
      const { data: itemsData, error: itemsErr } = await client
        .from('list_items')
        .select('list_id, show_id, position')
        .in('list_id', listIds)
        .order('position', { ascending: true });

      if (itemsErr) throw itemsErr;

      // Group items by list_id
      const itemsByList = new Map<string, string[]>();
      for (const item of (itemsData || [])) {
        const existing = itemsByList.get(item.list_id) || [];
        existing.push(item.show_id);
        itemsByList.set(item.list_id, existing);
      }

      const result: UserList[] = listsData.map((l: UserList) => {
        const showIds = itemsByList.get(l.id) || [];
        return {
          ...l,
          item_count: showIds.length,
          preview_show_ids: showIds.slice(0, 4),
          all_show_ids: showIds,
        };
      });

      setLists(result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load lists';
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const getListItems = useCallback(async (listId: string): Promise<ListItem[]> => {
    const client = getSupabaseClient();
    if (!client || !userId) return [];

    try {
      const { data, error: err } = await client
        .from('list_items')
        .select('*')
        .eq('list_id', listId)
        .order('position', { ascending: true });

      if (err) throw err;
      return (data || []) as ListItem[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load list items';
      setError(msg);
      return [];
    }
  }, [userId]);

  const createList = useCallback(async (
    name: string,
    description?: string | null,
    isRanked?: boolean,
  ): Promise<UserList | null> => {
    const client = getSupabaseClient();
    if (!client || !userId) return null;

    // Enforce max lists
    if (lists.length >= MAX_LISTS) {
      setError(`Maximum of ${MAX_LISTS} lists reached`);
      return null;
    }

    setError(null);
    try {
      const { data, error: err } = await client
        .from('lists')
        .insert({
          user_id: userId,
          name: name.trim(),
          description: description?.trim() || null,
          is_ranked: isRanked ?? false,
        })
        .select()
        .single();

      if (err) throw err;
      const newList: UserList = { ...data, item_count: 0, preview_show_ids: [], all_show_ids: [] };
      setLists(prev => [newList, ...prev]);
      return newList;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create list';
      setError(msg);
      return null;
    }
  }, [userId, lists.length]);

  const updateList = useCallback(async (
    listId: string,
    updates: { name?: string; description?: string | null; is_ranked?: boolean },
  ): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload.name = updates.name.trim();
      if (updates.description !== undefined) payload.description = updates.description?.trim() || null;
      if (updates.is_ranked !== undefined) payload.is_ranked = updates.is_ranked;

      const { error: err } = await client
        .from('lists')
        .update(payload)
        .eq('id', listId);

      if (err) throw err;

      // Optimistic update
      setLists(prev => prev.map(l =>
        l.id === listId ? { ...l, ...payload, updated_at: new Date().toISOString() } : l
      ));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to update list';
      setError(msg);
    }
  }, [userId]);

  const deleteList = useCallback(async (listId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const { error: err } = await client
        .from('lists')
        .delete()
        .eq('id', listId);

      if (err) throw err;

      // Optimistic update
      setLists(prev => prev.filter(l => l.id !== listId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to delete list';
      setError(msg);
    }
  }, [userId]);

  const addToList = useCallback(async (listId: string, showId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    // Enforce max items
    const list = lists.find(l => l.id === listId);
    if (list && (list.item_count || 0) >= MAX_ITEMS_PER_LIST) {
      setError(`Maximum of ${MAX_ITEMS_PER_LIST} shows per list reached`);
      return;
    }

    setError(null);
    try {
      // Get max position for this list
      const { data: maxData } = await client
        .from('list_items')
        .select('position')
        .eq('list_id', listId)
        .order('position', { ascending: false })
        .limit(1);

      const maxPos = maxData && maxData.length > 0 ? maxData[0].position : 0;

      const { error: err } = await client
        .from('list_items')
        .upsert(
          { list_id: listId, show_id: showId, position: maxPos + POSITION_GAP },
          { onConflict: 'list_id,show_id', ignoreDuplicates: true }
        );

      if (err) throw err;

      // Optimistic update — only increment if show wasn't already in the list
      setLists(prev => prev.map(l => {
        if (l.id !== listId) return l;
        const allIds = l.all_show_ids || [];
        if (allIds.includes(showId)) return l; // Already in list, no-op
        const previews = l.preview_show_ids || [];
        return {
          ...l,
          item_count: (l.item_count || 0) + 1,
          preview_show_ids: previews.length < 4 ? [...previews, showId] : previews,
          all_show_ids: [...allIds, showId],
          updated_at: new Date().toISOString(),
        };
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to add to list';
      setError(msg);
    }
  }, [userId, lists]);

  const removeFromList = useCallback(async (listId: string, showId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const { error: err } = await client
        .from('list_items')
        .delete()
        .eq('list_id', listId)
        .eq('show_id', showId);

      if (err) throw err;

      // Optimistic update — backfill preview if a preview show was removed
      setLists(prev => prev.map(l => {
        if (l.id !== listId) return l;
        const allIds = (l.all_show_ids || []).filter(id => id !== showId);
        const previews = (l.preview_show_ids || []).filter(id => id !== showId);
        // Backfill preview from remaining shows if under 4
        if (previews.length < 4) {
          const previewSet = new Set(previews);
          for (const id of allIds) {
            if (previews.length >= 4) break;
            if (!previewSet.has(id)) { previews.push(id); previewSet.add(id); }
          }
        }
        return { ...l, item_count: Math.max(0, (l.item_count || 0) - 1), preview_show_ids: previews, all_show_ids: allIds };
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to remove from list';
      setError(msg);
    }
  }, [userId]);

  const reorderList = useCallback(async (
    listId: string,
    itemIds: string[],
    positions: number[],
  ): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const { error: err } = await client.rpc('reorder_list_items', {
        p_list_id: listId,
        p_item_ids: itemIds,
        p_positions: positions,
      });

      if (err) throw err;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to reorder list';
      setError(msg);
    }
  }, [userId]);

  return {
    lists,
    loading,
    error,
    getLists,
    getListItems,
    createList,
    updateList,
    deleteList,
    addToList,
    removeFromList,
    reorderList,
  };
}
