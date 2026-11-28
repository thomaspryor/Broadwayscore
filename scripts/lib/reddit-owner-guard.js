/**
 * reddit-owner-guard.js (BRO-7337/BRO-7348): the sentence every Reddit outage or
 * missing-credentials message must carry. Two sessions asked the owner to create a
 * Reddit app after reading an outage alert; app creation is broken for the owner
 * (re-confirmed 2026-11-11). tests/unit/reddit-never-ask-owner.test.mjs fails if a
 * message loses this text.
 */
'use strict';

const NEVER_ASK_REDDIT_APP =
  'Do NOT ask the owner to create a Reddit app or mint REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET ' +
  '(app creation is broken for their account). See cloud-memory/feedback_reddit_app_creation_broken.md.';

module.exports = { NEVER_ASK_REDDIT_APP };
