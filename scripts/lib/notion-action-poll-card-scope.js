'use strict';

// Restricts a candidate card list to a single card id (--card flag on
// notion-action-poll.js). Lets a session verify a dispatch fix against one
// real card without the poller sweeping every actionable card on the live
// Roadmap (the class of bug behind tasks #334/#528/#536/#542).

function normalizeId(id) {
  return String(id).replace(/-/g, '').toLowerCase();
}

function filterCardsByCardId(cards, cardId) {
  if (!cardId) return cards;
  const normalized = normalizeId(cardId);
  return cards.filter(c => normalizeId(c.id) === normalized);
}

module.exports = { filterCardsByCardId };
