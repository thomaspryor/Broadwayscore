// BRO-3017 acceptance path. The implementation lives in backlog-inflow-ratio.js
// (CommonJS, like the rest of scripts/lib and its digest caller); this is a
// re-export so ESM consumers can import the same functions without a copy.
import inflow from './backlog-inflow-ratio.js';

export const {
  TEAM_KEY, INFLOW_WINDOW_DAYS, MAX_PAGES, OK_MAX_RATIO, WATCH_MAX_RATIO,
  MIN_CREATED_FOR_ALARM, DIGEST_GRAPHQL_OPTS, buildInflowCountQuery, windowStart,
  buildCreatedFilter, buildCompletedFilter, buildCanceledFilter, buildOpenFilter,
  fetchInflowCounts, assessInflowRatio, countMatching,
} = inflow;
export default inflow;
