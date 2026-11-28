/**
 * notion-create-safety.js — post-create existence check for notion-brain.js
 * `create` (BRO-113).
 *
 * Incident: on 2026-07-26, three consecutive `notion-brain.js create` calls
 * produced no card in Notion and no visible error (stdout was piped; the
 * downstream task bridge confirmed 0 cards created). A session that believes
 * a card was filed when it wasn't silently drops the work it was tracking.
 *
 * This module gives `createCard()` one thing to call right after
 * `notion.pages.create()` resolves: confirm the page Notion just handed back
 * is actually retrievable and not immediately archived, and throw a loud,
 * specific error otherwise. `createCard()` no longer gets to report success
 * on the strength of the create call resolving alone.
 */
'use strict';

async function verifyCardCreated(notion, pageId) {
  let page;
  try {
    page = await notion.pages.retrieve({ page_id: pageId });
  } catch (err) {
    throw new Error(
      `Post-create existence check FAILED for ${pageId}: pages.retrieve threw "${err.message}". ` +
        `notion.pages.create() reported success but the card cannot be confirmed — treat this as a lost card.`
    );
  }
  if (!page || page.archived || page.in_trash) {
    throw new Error(
      `Post-create existence check FAILED for ${pageId}: page ${
        !page ? 'was not returned' : page.archived ? 'is archived' : 'is in trash'
      } immediately after create.`
    );
  }
  return page;
}

module.exports = { verifyCardCreated };
