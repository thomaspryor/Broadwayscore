'use strict';
// BRO-7803: master switch for the runtime score path. false = the publisher does nothing and the
// simulated opening night falls back to the full rebuild + deploy leg (about 20 min found-to-live).
// The game-day mutant flips this line to prove the night goes red without the path.
const PUBLISHER_ENABLED = true;

module.exports = { PUBLISHER_ENABLED };
