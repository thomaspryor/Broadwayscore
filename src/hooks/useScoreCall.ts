'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { supabaseRestRpc } from '@/lib/supabase-rest';
import { useAuth } from '@/contexts/AuthContext';

/** A locked call plus the forecast snapshot taken when it locked (null when no forecast existed). */
export interface ScoreCall {
  show_id: string;
  called_score: number;
  forecast: number | null;
  lo80: number | null;
  hi80: number | null;
  locked_at: string;
}

// One shared fetch for hero link, card and strip: they all read the same store.
interface Store { userId: string | null; calls: Record<string, ScoreCall>; loaded: boolean; loadError: boolean; inflight: Promise<void> | null }
let store: Store = { userId: null, calls: {}, loaded: false, loadError: false, inflight: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => store;

async function load(userId: string) {
  if (store.userId === userId && (store.loaded || store.inflight)) return store.inflight ?? undefined;
  // A response only lands if it is still the current request: a sign-out or a different user signing
  // in meanwhile replaces store.inflight, so a late answer for the old user is dropped.
  const ref: { p?: Promise<void> } = {};
  const p: Promise<void> = (ref.p = (async () => {
    const { data, error } = await supabaseRestRpc<ScoreCall[]>('get_my_score_calls');
    if (store.inflight !== ref.p) return;
    // A failed fetch is not "no calls": it must not let a reader re-pick a show they already called.
    if (error) { store = { userId, calls: {}, loaded: true, loadError: true, inflight: null }; emit(); return; }
    const calls: Record<string, ScoreCall> = {};
    for (const c of data || []) calls[c.show_id] = c;
    store = { userId, calls, loaded: true, loadError: false, inflight: null };
    emit();
  })());
  store = { userId, calls: {}, loaded: false, loadError: false, inflight: p };
  return p;
}

export type LockResult = { ok: true; call: ScoreCall } | { ok: false; reason: 'already_called' | 'calls_closed' | 'not_open' | 'error' };

export function useScoreCall(showId: string) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (userId) void load(userId);
    else if (store.userId) { store = { userId: null, calls: {}, loaded: false, loadError: false, inflight: null }; emit(); }
  }, [userId]);

  const lock = useCallback(async (score: number): Promise<LockResult> => {
    const { data, error } = await supabaseRestRpc<ScoreCall[]>('lock_score_call', { p_show_id: showId, p_score: score });
    if (error) {
      const m = error.message || '';
      if (m.includes('already_called')) { store = { ...store, loaded: false, loadError: false, inflight: null }; if (userId) await load(userId); return { ok: false, reason: 'already_called' }; }
      if (m.includes('calls_closed')) return { ok: false, reason: 'calls_closed' };
      if (m.includes('not_open')) return { ok: false, reason: 'not_open' };
      return { ok: false, reason: 'error' };
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return { ok: false, reason: 'error' };
    const call: ScoreCall = { show_id: showId, called_score: row.called_score as unknown as number, forecast: (row as unknown as { forecast: number | null }).forecast, lo80: (row as unknown as { lo80: number | null }).lo80, hi80: (row as unknown as { hi80: number | null }).hi80, locked_at: (row as unknown as { locked_at: string }).locked_at };
    store = { ...store, userId, calls: { ...store.calls, [showId]: call }, loaded: true, loadError: false };
    emit();
    return { ok: true, call };
  }, [showId, userId]);

  const retry = useCallback(() => { if (!userId) return; store = { ...store, loaded: false, loadError: false, inflight: null }; void load(userId); }, [userId]);

  return { signedIn: !!userId, loadError: !!userId && s.userId === userId && s.loadError, retry, loaded: !userId || (s.userId === userId && s.loaded), call: userId && s.userId === userId ? s.calls[showId] ?? null : null, lock };
}

/** Every call the signed-in reader has locked, newest first (My Shows card). Shares the store above. */
export function useMyScoreCalls() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { if (userId) void load(userId); }, [userId]);
  const ready = !!userId && s.userId === userId && s.loaded;
  const calls = ready ? Object.values(s.calls).sort((a, b) => b.locked_at.localeCompare(a.locked_at)) : [];
  const retry = useCallback(() => { if (!userId) return; store = { ...store, loaded: false, loadError: false, inflight: null }; void load(userId); }, [userId]);
  return { signedIn: !!userId, loaded: ready, loadError: !!userId && s.userId === userId && s.loadError, retry, calls };
}
