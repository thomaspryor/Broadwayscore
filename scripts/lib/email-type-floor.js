'use strict';
/**
 * BRO-7075: nothing in an owner-facing email body renders below MIN_FONT_PX.
 * The owner reads these in Gmail on a phone ("a wall of tiny text"). One choke
 * point instead of dozens of inline styles: any smaller `font-size:Npx` the
 * renderers emit is raised here. Larger sizes and non-px units are untouched.
 */
const MIN_FONT_PX = 14;

// Gmail drops the `background:#hex` shorthand in some clients; `background-color`
// is honoured everywhere. Same choke point, same owner-facing senders.
function enforceTypeFloor(html, min = MIN_FONT_PX) {
  return String(html)
    .replace(/font-size:\s*(\d+(?:\.\d+)?)px/g, (m, n) => (Number(n) < min ? `font-size:${min}px` : m))
    .replace(/(^|[;"'\s])background:\s*(#[0-9a-fA-F]{3,8})(?![0-9a-fA-F])/g, '$1background-color:$2');
}

module.exports = { enforceTypeFloor, MIN_FONT_PX };
