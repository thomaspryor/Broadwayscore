-- Welcome email for new accounts (BRO-4620).
--
-- welcome_emails is the durable once-only record: one row per account that
-- was sent (or is being sent) its welcome email. The primary key on user_id
-- is the claim: scripts/send-welcome-emails.js inserts the row with
-- ON CONFLICT DO NOTHING before calling Resend, so two overlapping runs, a
-- retry or a re-run can never both send. A failed send deletes the row so a
-- later run retries (Resend's Idempotency-Key, per account, stops a retry of
-- a send that did go through from delivering twice).
--
-- A separate table rather than a profiles column: users can UPDATE their own
-- profiles row through RLS, so a column there could be reset by the account
-- holder. This table has RLS on and no policies, so only the service role
-- (the cron job) can read or write it. ON DELETE CASCADE drops the row with
-- the account (delete-account removes the auth user).
--
-- welcome_email_candidates() reads auth.users (email + created_at live there,
-- not in profiles) and is executable by service_role only.
--
-- Re-runnable. ROLLBACK (disable send-welcome-emails.yml first):
--   DROP FUNCTION IF EXISTS public.welcome_email_candidates(TIMESTAMPTZ, INTEGER);
--   DROP TABLE IF EXISTS public.welcome_emails;

CREATE TABLE IF NOT EXISTS public.welcome_emails (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resend_id TEXT,
  -- Set when Resend refused the message for good (400/403/422). The row stays,
  -- so the account is never retried; the owner gets one alert.
  failed_reason TEXT
);

-- Re-run safety for a project where an earlier draft of this table exists.
ALTER TABLE public.welcome_emails ADD COLUMN IF NOT EXISTS failed_reason TEXT;

ALTER TABLE public.welcome_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.welcome_emails FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.welcome_emails TO service_role;

CREATE INDEX IF NOT EXISTS welcome_emails_sent_at_idx ON public.welcome_emails (sent_at);

-- Accounts created at or after p_since that have a confirmed email and no welcome_emails
-- row yet, oldest first. display_name falls back to the OAuth metadata name
-- when the profiles row has none (or has not been created yet).
CREATE OR REPLACE FUNCTION public.welcome_email_candidates(p_since TIMESTAMPTZ, p_limit INTEGER)
RETURNS TABLE (id UUID, email TEXT, display_name TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id,
         u.email::text,
         COALESCE(NULLIF(p.display_name, ''),
                  u.raw_user_meta_data->>'full_name',
                  u.raw_user_meta_data->>'name') AS display_name,
         u.created_at
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    LEFT JOIN public.welcome_emails w ON w.user_id = u.id
   WHERE w.user_id IS NULL
     AND u.created_at >= p_since
     AND COALESCE(u.email, '') <> ''
     -- OAuth sign-ins arrive confirmed; this keeps a future email/password or
     -- magic-link sign-up from getting mail before the address is verified.
     AND u.email_confirmed_at IS NOT NULL
     AND u.deleted_at IS NULL
   ORDER BY u.created_at
   LIMIT GREATEST(p_limit, 0);
$$;

REVOKE ALL ON FUNCTION public.welcome_email_candidates(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.welcome_email_candidates(TIMESTAMPTZ, INTEGER) TO service_role;
