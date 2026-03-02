'use client';

import { useState, useCallback } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import type { UserProfile } from '@/types/user';

export function useUserProfile(userId: string | null) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getProfile = useCallback(async (): Promise<UserProfile | null> => {
    const client = getSupabaseClient();
    if (!client || !userId) return null;

    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await client
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (err) throw err;
      const result = data as UserProfile;
      setProfile(result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load profile';
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const updateProfile = useCallback(async (updates: {
    display_name?: string;
    avatar_url?: string | null;
  }): Promise<void> => {
    const client = getSupabaseClient();
    if (!client || !userId) return;

    setError(null);
    try {
      const { error: err } = await client
        .from('profiles')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', userId);

      if (err) throw err;

      // Optimistic update
      setProfile(prev => prev ? { ...prev, ...updates } : null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to update profile';
      setError(msg);
      throw new Error(msg);
    }
  }, [userId]);

  return {
    profile,
    loading,
    error,
    getProfile,
    updateProfile,
  };
}
