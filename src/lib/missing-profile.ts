/**
 * Postgres foreign-key failures that mean "this signed-in user has no
 * profiles row" (BRO-8031, Sentry "UGC insert reviews failed (23503)").
 *
 * Most UGC tables' user_id references public.profiles(id), not auth.users
 * (a few newer tables reference auth.users; for those a heal fails on
 * profiles_id_fkey and the user is signed out, as before).
 * A user whose auth account is valid (getUser() succeeded) but whose profile
 * row is missing gets 23503 on every save. BRO-7727 treated that as a deleted
 * account and signed the user out, and the raw 23503 still went to Sentry, so
 * the save never worked and the issue regressed. supabase-rest.ts now
 * recreates the profile (RLS allows inserting your own row) and retries once.
 *
 * Pure and dependency-free so both ugc-analytics.ts (Sentry routing) and
 * supabase-rest.ts (recovery) share one definition.
 */

interface PgError { code?: unknown; message?: unknown; details?: unknown }

/**
 * 23503 on <table>_user_id_fkey whose key is missing from table "profiles":
 * the user's profiles row is missing. Postgres puts the referenced table in
 * details ('Key (user_id)=(..) is not present in table "profiles".'), so an FK
 * to auth.users or to another user's id does not match (review, BRO-8031).
 */
export function isMissingProfileFk(body: PgError | null | undefined): boolean {
  return body?.code === '23503'
    && /foreign key constraint "[^"\n]+_user_id_fkey"/.test(String(body.message ?? ''))
    && /not present in table "profiles"/.test(String(body.details ?? ''));
}

/** 23503 on profiles_id_fkey: inserting the profile failed because the auth user is gone. */
export function isMissingAuthUserFk(body: PgError | null | undefined): boolean {
  return body?.code === '23503'
    && /foreign key constraint "profiles_id_fkey"/.test(String(body.message ?? ''));
}
