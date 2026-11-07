// Shared sort-direction toggle logic for listing-page SORT ToggleBars (task #592).
//
// Clicking an already-active sort button (e.g. CRITICS) used to be a no-op on
// /off-broadway, /west-end, /opera, and /off-west-end — it always re-applied
// the same descending sort, gave no arrow/tooltip feedback, and looked
// clickable while doing nothing. The homepage already solved this by
// reversing direction on a second click; this module is that same mapping,
// pulled out so every listing page shares one definition instead of
// reimplementing (and re-drifting) it.
//
// CommonJS on purpose: `tsconfig.json` has `allowJs: true` so Next.js/webpack
// can import this with named imports from .tsx, and `tests/unit/*.test.mjs`
// requires plain CJS modules directly (see e.g. audience-buzz-write-guard.test.mjs).

const TOGGLE_PAIRS = {
  recent: 'recent_asc',
  score_desc: 'score_asc',
  alpha: 'alpha_desc',
  audience_buzz: 'audience_asc',
};

const BASE_FOR_TOGGLED = Object.entries(TOGGLE_PAIRS).reduce((acc, [base, toggled]) => {
  acc[toggled] = base;
  return acc;
}, {});

function isToggleable(sortValue) {
  return Object.prototype.hasOwnProperty.call(TOGGLE_PAIRS, sortValue);
}

// Maps a toggled ("second click") value back to its base value, e.g.
// 'score_asc' -> 'score_desc'. Non-toggled/unknown values pass through
// unchanged. Used to compute which ToggleBar button should render as active.
function normalizeSort(sortValue) {
  return BASE_FOR_TOGGLED[sortValue] || sortValue;
}

// Given the option value a user clicked and the sort currently applied,
// returns the sort to apply next: clicking the already-active option
// reverses it, clicking a different option selects its base (descending/
// default) direction.
function getNextSort(clickedValue, currentSort) {
  if (!isToggleable(clickedValue)) return clickedValue;
  return currentSort === clickedValue ? TOGGLE_PAIRS[clickedValue] : clickedValue;
}

// Returns the arrow to show on a sort button: '↓' when its base direction is
// active, '↑' when its toggled direction is active, '' when the button isn't
// the active sort (or isn't toggleable at all).
function getSortArrow(baseValue, currentSort) {
  if (!isToggleable(baseValue)) return '';
  if (currentSort === baseValue) return '↓';
  if (currentSort === TOGGLE_PAIRS[baseValue]) return '↑';
  return '';
}

// Same mapping shape as above, parameterized on a caller-supplied base->toggled
// map. Lets a page whose sort values don't match the hardcoded TOGGLE_PAIRS
// above (e.g. BrowseListClient's SortOption uses 'score'/'alpha' rather than
// 'score_desc'/'alpha') opt into the same no-op-free toggle behavior without
// colliding with the pairs above (a shared toggled-state string like
// 'score_asc' used by two different base values would corrupt normalizeSort
// for both — each caller gets its own closure instead).
function createSortToggle(pairs) {
  const baseForToggled = Object.entries(pairs).reduce((acc, [base, toggled]) => {
    acc[toggled] = base;
    return acc;
  }, {});

  function isToggleableLocal(sortValue) {
    return Object.prototype.hasOwnProperty.call(pairs, sortValue);
  }

  function normalizeSortLocal(sortValue) {
    return baseForToggled[sortValue] || sortValue;
  }

  function getNextSortLocal(clickedValue, currentSort) {
    if (!isToggleableLocal(clickedValue)) return clickedValue;
    return currentSort === clickedValue ? pairs[clickedValue] : clickedValue;
  }

  function getSortArrowLocal(baseValue, currentSort) {
    if (!isToggleableLocal(baseValue)) return '';
    if (currentSort === baseValue) return '↓';
    if (currentSort === pairs[baseValue]) return '↑';
    return '';
  }

  return {
    pairs,
    isToggleable: isToggleableLocal,
    normalizeSort: normalizeSortLocal,
    getNextSort: getNextSortLocal,
    getSortArrow: getSortArrowLocal,
  };
}

module.exports = { TOGGLE_PAIRS, isToggleable, normalizeSort, getNextSort, getSortArrow, createSortToggle };
