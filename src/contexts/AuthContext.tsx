'use client';

import { createContext, useState, useEffect, useCallback, ReactNode } from 'react';
import type { User, AuthChangeEvent, Session } from '@supabase/supabase-js';
import { getSupabaseClient } from '@/lib/supabase';
import { Profile } from '@/types/database';

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithMagicLink: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  hasPendingRating: boolean;
  clearPendingRating: () => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasPendingRating, setHasPendingRating] = useState(false);

  const supabase = getSupabaseClient();

  // Check for pending rating data in sessionStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const pending = sessionStorage.getItem('pendingRatingData');
      if (pending) {
        setHasPendingRating(true);
      }
    }
  }, []);

  const clearPendingRating = useCallback(() => {
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('pendingRatingData');
    }
    setHasPendingRating(false);
  }, []);

  const fetchProfile = useCallback(async (userId: string) => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('Error fetching profile:', error);
        return;
      }
      setProfile(data as Profile);
    } catch (err) {
      console.error('Error fetching profile:', err);
    }
  }, [supabase]);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    // Check current session on mount
    const initSession = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          setUser(session.user);
          await fetchProfile(session.user.id);
        }
      } catch (err) {
        console.error('Error getting session:', err);
      } finally {
        setLoading(false);
      }
    };

    initSession();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event: AuthChangeEvent, session: Session | null) => {
        if (event === 'SIGNED_IN' && session?.user) {
          setUser(session.user);
          await fetchProfile(session.user.id);
        } else if (event === 'SIGNED_OUT') {
          setUser(null);
          setProfile(null);
        }
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [supabase, fetchProfile]);

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) {
      console.warn('Supabase client not available. Cannot sign in with Google.');
      return;
    }
    try {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(
          'pendingRedirectPath',
          window.location.pathname
        );
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) {
        console.error('Error signing in with Google:', error);
      }
    } catch (err) {
      console.error('Error signing in with Google:', err);
    }
  }, [supabase]);

  const signInWithMagicLink = useCallback(async (email: string) => {
    if (!supabase) {
      console.warn('Supabase client not available. Cannot send magic link.');
      return;
    }
    try {
      const { error } = await supabase.auth.signInWithOtp({ email });
      if (error) {
        console.error('Error sending magic link:', error);
      }
    } catch (err) {
      console.error('Error sending magic link:', err);
    }
  }, [supabase]);

  const signOutHandler = useCallback(async () => {
    if (!supabase) {
      console.warn('Supabase client not available. Cannot sign out.');
      return;
    }
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error('Error signing out:', error);
      }
    } catch (err) {
      console.error('Error signing out:', err);
    }
  }, [supabase]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        signInWithGoogle,
        signInWithMagicLink,
        signOut: signOutHandler,
        hasPendingRating,
        clearPendingRating,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
