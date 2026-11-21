'use strict';
// BRO-7830: the live-score schema version, alone in a file with no Node
// builtins. resolve.js / apply.js are bundled into the show page's client JS
// (LiveScoreOverlay.tsx); requiring core.js for this constant dragged Node's
// `crypto` in, and webpack shipped a ~134kB browser crypto polyfill to every
// show page (first-load JS 306kB -> 440kB, Bundle Size Check red).
const SCHEMA = 1;
module.exports = { SCHEMA };
