-- BRO-4530: created_by (an account id) was readable by anon through the public
-- read policy. Column-level grants hide it. Prerequisite (done): both clients
-- insert with Prefer: return=minimal, because RETURNING created_by would now be
-- refused for anon/authenticated. The service role (resolver) is unaffected.
REVOKE SELECT ON user_show_stubs FROM anon, authenticated;
GRANT SELECT (id, title, venue, city, category, opening_date, poster_url, mezz_prod_id, created_at)
  ON user_show_stubs TO anon, authenticated;
-- NOTE: a column added to this table later is invisible to anon/authenticated until granted here.
