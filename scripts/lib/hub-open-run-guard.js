'use strict';
/**
 * BRO-8455 item 8: a city-hub production that is open or in previews with neither a closing date nor a
 * closingDateSource stays in "Now playing" forever (the hub only retires a run it knows is a guess, flagged
 * closingDateSource 'estimated'). Pure; the data test and any audit call it.
 */
function openRunsWithoutClosing(shows, today) {
  return (shows || []).filter((s) => s && s.localOnly && (s.status === 'open' || s.status === 'previews')
    && !s.closingDate && !s.closingDateSource && s.openingDate && s.openingDate <= today);
}
module.exports = { openRunsWithoutClosing };
