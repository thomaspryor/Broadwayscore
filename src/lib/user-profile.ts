import { supabaseRestSelect, supabaseRestUpdate } from '@/lib/supabase-rest';
import type { UserProfile } from '@/types/user';

/**
 * Profile read/write helpers over supabase-rest (explicit auth headers — same
 * reliable path the rating/list writes use). Replaces the old useUserProfile
 * hook; Phase 3's display-name edit modal consumes these directly.
 */

export async function fetchProfile(userId: string): Promise<UserProfile | null> {
  const { data } = await supabaseRestSelect<UserProfile>('profiles', `id=eq.${userId}&select=*&limit=1`);
  return data && data.length > 0 ? data[0] : null;
}

/** Update the display name. Throws on failure so callers can surface an error. */
export async function updateDisplayName(userId: string, displayName: string): Promise<void> {
  const { error } = await supabaseRestUpdate('profiles', `id=eq.${userId}`, {
    display_name: displayName.trim(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}
