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
interface Store { userId: string | null; calls: Record<string, ScoreCall>; loaded: boolean; inflight: Promise<void> | null }
let store: Store = { userId: null, calls: {}, loaded: false, inflight: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => store;

async function load(userId: string) {
  if (store.userId === userId && (store.loaded || store.inflight)) return store.inflight ?? undefined;
  const p = (async () => {
    const { data } = await supabaseRestRpc<ScoreCall[]>('get_my_score_calls');
    const calls: Record<string, ScoreCall> = {};
    for (const c of data || []) calls[c.show_id] = c;
    store = { userId, calls, loaded: true, inflight: null };
    emit();
  })();
  store = { userId, calls: {}, loaded: false, inflight: p };
  return p;
}

export type LockResult = { ok: true; call: ScoreCall } | { ok: false; reason: 'already_called' | 'calls_closed' | 'not_open' | 'error' };

export function useScoreCall(showId: string) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (userId) void load(userId);
    else if (store.userId) { store = { userId: null, calls: {}, loaded: false, inflight: null }; emit(); }
  }, [userId]);

  const lock = useCallback(async (score: number): Promise<LockResult> => {
    const { data, error } = await supabaseRestRpc<ScoreCall[]>('lock_score_call', { p_show_id: showId, p_score: score });
    if (error) {
      const m = error.message || '';
      if (m.includes('already_called')) { store = { ...store, loaded: false, inflight: null }; if (userId) await load(userId); return { ok: false, reason: 'already_called' }; }
      if (m.includes('calls_closed')) return { ok: false, reason: 'calls_closed' };
      if (m.includes('not_open')) return { ok: false, reason: 'not_open' };
      return { ok: false, reason: 'error' };
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return { ok: false, reason: 'error' };
    const call: ScoreCall = { show_id: showId, called_score: row.called_score as unknown as number, forecast: (row as unknown as { forecast: number | null }).forecast, lo80: (row as unknown as { lo80: number | null }).lo80, hi80: (row as unknown as { hi80: number | null }).hi80, locked_at: (row as unknown as { locked_at: string }).locked_at };
    store = { ...store, userId, calls: { ...store.calls, [showId]: call }, loaded: true };
    emit();
    return { ok: true, call };
  }, [showId, userId]);

  return { signedIn: !!userId, loaded: !userId || (s.userId === userId && s.loaded), call: userId && s.userId === userId ? s.calls[showId] ?? null : null, lock };
}
