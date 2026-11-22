/**
 * Postgres foreign-key failures that mean "this signed-in user has no
 * profiles row" (BRO-8031, Sentry "UGC insert reviews failed (23503)").
 *
 * Every UGC table's user_id references public.profiles(id), not auth.users.
 * A user whose auth account is valid (getUser() succeeded) but whose profile
 * row is missing gets 23503 on every save. BRO-7727 treated that as a deleted
 * account and signed the user out, and the raw 23503 still went to Sentry, so
 * the save never worked and the issue regressed. supabase-rest.ts now
 * recreates the profile (RLS allows inserting your own row) and retries once.
 *
 * Pure and dependency-free so both ugc-analytics.ts (Sentry routing) and
 * supabase-rest.ts (recovery) share one definition.
 */

interface PgError { code?: unknown; message?: unknown }

/** 23503 on <table>_user_id_fkey: the user's profiles row is missing. */
export function isMissingProfileFk(body: PgError | null | undefined): boolean {
  return body?.code === '23503'
    && /foreign key constraint "[^"\n]+_user_id_fkey"/.test(String(body.message ?? ''));
}

/** 23503 on profiles_id_fkey: inserting the profile failed because the auth user is gone. */
export function isMissingAuthUserFk(body: PgError | null | undefined): boolean {
  return body?.code === '23503'
    && /foreign key constraint "profiles_id_fkey"/.test(String(body.message ?? ''));
}
