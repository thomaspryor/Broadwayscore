'use strict';

// Per-user tables (a uuid user_id/created_by column) that the delete-account
// edge function deliberately leaves alone, and why. Shared by
// tests/unit/delete-account-coverage.test.mjs (migration scan) and
// scripts/verify-supabase-schema.js (live catalog scan, which also sees tables
// only the iOS repo's migrations create, BRO-4534).
module.exports = {
  user_show_stubs: 'shared catalog rows other users can point at; no personal content',
  plan_shares: 'ON DELETE CASCADE from profiles, which delete-account removes',
  diary_shares: 'ON DELETE CASCADE from profiles, which delete-account removes',
  welcome_emails: 'ON DELETE CASCADE from auth.users, which delete-account removes; holds only user_id + send status',
  push_alert_log: 'ON DELETE CASCADE from auth.users, which delete-account removes; holds only user_id, show id and an alert key',
  seen_unrated: 'ON DELETE CASCADE from profiles, which delete-account removes',
};
